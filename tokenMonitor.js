// src/tokenMonitor.js
// 代币生命周期管理：接收新代币、拉取元数据、订阅 WS、年龄到期退出

const config        = require('./config');
const tokenStore    = require('./tokenStore');
const birdeyeRest   = require('./birdeyeRest');
const birdeyeWs     = require('./birdeyeWs');
const webhookSender = require('./webhookSender');
const { evaluateStrategy } = require('./strategy');

// ── 年龄计时器 ────────────────────────────────────────────────────
// 每分钟检查所有 active token，到期时：
//   有首仓持仓 → 发 SELL AGE_EXPIRE，再移除
//   无持仓（已止盈）→ 直接移除
function startAgeTicker() {
  setInterval(async () => {
    const now    = Date.now();
    const maxAge = config.monitor.tokenMaxAgeMinutes * 60 * 1000;

    for (const token of tokenStore.getActiveTokens()) {
      const age = Math.floor((now - token.addedAt) / 60000);
      tokenStore.updateTokenData(token.address, { age });

      if (now - token.addedAt >= maxAge) {
        console.log(`[Monitor] AGE_EXPIRE: ${token.symbol} (${age}m)`);

        birdeyeWs.unsubscribe(token.address);
        tokenStore.removeToken(token.address);

        if (token.positionOpen) {
          await webhookSender.sendSell(
            token.address,
            token.symbol,
            'AGE_EXPIRE',
            token.price
          );
          token.positionOpen    = false;
          token.isFirstPosition = false;
          token.entryPrice      = null;
          token.pnl             = 0;
        }
      }
    }
  }, 60 * 1000);
}

// ── REST 兜底轮询 ──────────────────────────────────────────────────
function startRestFallback(address) {
  const interval = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(interval);
      return;
    }
    if (birdeyeWs.connected) return;

    const price = await birdeyeRest.getPrice(address);
    if (price && price > 0) {
      tokenStore.updateTokenData(address, { price });
    }
  }, 10000);
}

// ── 新代币入列主流程 ───────────────────────────────────────────────
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // 1. 拉取元数据
  const overview = await birdeyeRest.getTokenOverview(address);
  if (overview) {
    tokenStore.updateTokenData(address, {
      price:       overview.price,
      lp:          overview.lp,
      fdv:         overview.fdv,
      priceChange: overview.priceChange,
    });

    // FDV 过滤
    if (overview.fdv && overview.fdv < config.monitor.fdvMinimum) {
      console.log(`[Monitor] SKIP low FDV $${overview.fdv}: ${symbol}`);
      tokenStore.removeToken(address);
      return;
    }
  }

  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  // 2. 立即买入首仓
  const entryPrice = token.price;
  await webhookSender.sendBuy(address, symbol, 'FIRST_POSITION', entryPrice);
  tokenStore.updateTokenData(address, {
    positionOpen:    true,
    isFirstPosition: true,
    entryPrice:      entryPrice,
    entryAt:         Date.now(),
  });
  console.log(`[Monitor] FIRST_POSITION entry=$${entryPrice} ${symbol}`);

  // 3. 订阅 WS（实时止盈由 birdeyeWs._checkTakeProfit 处理）
  birdeyeWs.subscribe(address);

  // 4. REST 兜底（WS 断线时保持价格更新）
  startRestFallback(address);

  // 5. 每根 K 线结束时做一次止盈检查（兜底，防止成交稀少时 WS 检查不及时）
  tokenStore.on('newCandle', async ({ address: addr, candle }) => {
    if (addr !== address) return;
    const t = tokenStore.getToken(addr);
    if (!t || !t.active) return;
    await evaluateStrategy(addr, candle);
  });
}

module.exports = { onTokenReceived, startAgeTicker };
