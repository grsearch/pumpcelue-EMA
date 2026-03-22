// src/strategy.js
// RSI(7) 交易策略
//
// ┌─ 代币收录 ──────────────────────────────────────────────────────┐
// │  立即 BUY（FIRST_POSITION），不做任何过滤                        │
// │                                                                 │
// │  首仓卖出（positionOpen=true）：                                 │
// │    K线high 相对首仓入场价 +50% → SELL TP                        │
// │    加仓未发生时 RSI 信号不触发首仓卖出                            │
// │    加仓已发生后 RSI>80 / RSI下穿70 也触发全部卖出                 │
// │                                                                 │
// │  加仓买入条件（同时满足）：                                       │
// │    1. RSI(7) 上穿 30                                            │
// │    2. EMA9 >= EMA20 × 0.97（过滤明显下跌趋势）                   │
// │    3. 无持仓时触发，卖出后可再次买入                              │
// │    4. 已有持仓且跌超-20%时可第二次加仓（最多2次）                  │
// │                                                                 │
// │  加仓卖出：                                                      │
// │    K线high 相对加仓入场价 +50% → SELL TP                        │
// │    RSI > 80 → SELL                                              │
// │    RSI 下穿 70 → SELL                                           │
// │                                                                 │
// │  白名单退出（tokenMonitor 负责）：                               │
// │    60分钟到期 / FDV < 10000                                     │
// └─────────────────────────────────────────────────────────────────┘

const { RSI } = require('technicalindicators');
const config        = require('./config');
const tokenStore    = require('./tokenStore');
const webhookSender = require('./webhookSender');

const RSI_PERIOD = config.rsi.period; // 7
function calcRSI(closes) {
  if (closes.length < RSI_PERIOD + 1) return null;
  const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
  if (!values || values.length === 0) return null;
  return values[values.length - 1];
}


async function evaluateStrategy(address, candle) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  const closes = token.closes;
  if (closes.length < RSI_PERIOD + 2) return;

  const rsi = calcRSI(closes);
  if (rsi === null) return;

  const prevCloses = closes.slice(0, -1);
  const prevRsi    = prevCloses.length >= RSI_PERIOD + 1 ? calcRSI(prevCloses) : null;

  token.prevRsi = prevRsi;
  token.rsi     = rsi;

  if (prevRsi === null) return;

  const price = token.price || closes[closes.length - 1];
  const high  = (candle && candle.high) ? candle.high : price;

  // ── 首仓：加仓未发生时仅 +50% 止盈；加仓已发生后 RSI 信号也可触发 ──
  if (token.positionOpen && token.isFirstPosition) {
    if (!token.entryPrice && price) {
      token.entryPrice = price;
      console.log(`[Strategy] First pos entry: $${price} for ${token.symbol}`);
    }

    if (token.entryPrice) {
      const tpPrice = token.entryPrice * (1 + config.rsi.tpPct / 100);
      token.pnl     = parseFloat(((price - token.entryPrice) / token.entryPrice * 100).toFixed(2));

      // +50% 止盈：始终有效
      if (high >= tpPrice) {
        const gainPct = ((tpPrice - token.entryPrice) / token.entryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL first pos TP +${gainPct}%: ${token.symbol}`);
        await webhookSender.sendSell(address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice);
        _clearAll(token);
        return;
      }

      // RSI 信号：仅在加仓已发生后才触发
      if (token.addPositionOpen) {
        if (rsi > config.rsi.sellHigh) {
          console.log(`[Strategy] SELL first+add pos RSI>${config.rsi.sellHigh}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
          await webhookSender.sendSell(address, token.symbol, `RSI_ABOVE_${config.rsi.sellHigh}`, price);
          _clearAll(token);
          return;
        }
        if (prevRsi >= config.rsi.sellCross && rsi < config.rsi.sellCross) {
          console.log(`[Strategy] SELL first+add pos RSI cross↓${config.rsi.sellCross}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
          await webhookSender.sendSell(address, token.symbol, `RSI_CROSS_DOWN_${config.rsi.sellCross}`, price);
          _clearAll(token);
          return;
        }
      }
    }
  }

  // ── 加仓：止盈 + RSI 卖出 ─────────────────────────────────────────
  if (token.addPositionOpen) {
    if (!token.addEntryPrice && price) {
      token.addEntryPrice = price;
      console.log(`[Strategy] Add pos entry: $${price} for ${token.symbol}`);
    }

    if (token.addEntryPrice) {
      const tpPrice = token.addEntryPrice * (1 + config.rsi.tpPct / 100);

      // 卖出条件 1：+50% 止盈（用 high 判断）
      if (high >= tpPrice) {
        const gainPct = ((tpPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL add pos TP +${gainPct}%: ${token.symbol}`);
        await webhookSender.sendSell(address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice);
        _clearAll(token);
        return;
      }

      // 卖出条件 2：RSI > 80
      if (rsi > config.rsi.sellHigh) {
        console.log(`[Strategy] SELL RSI>${config.rsi.sellHigh}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
        await webhookSender.sendSell(address, token.symbol, `RSI_ABOVE_${config.rsi.sellHigh}`, price);
        _clearAll(token);
        return;
      }

      // 卖出条件 3：RSI 下穿 70
      if (prevRsi >= config.rsi.sellCross && rsi < config.rsi.sellCross) {
        console.log(`[Strategy] SELL RSI cross↓${config.rsi.sellCross}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
        await webhookSender.sendSell(address, token.symbol, `RSI_CROSS_DOWN_${config.rsi.sellCross}`, price);
        _clearAll(token);
        return;
      }

      // 更新浮盈
      token.pnl = parseFloat(((price - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(2));
    }
  }

  // ── RSI 上穿 30 → 加仓买入 ───────────────────────────────────────
  // 执行条件（以首仓盈亏判断币的强弱）：
  //   情况A：首仓持有中 且 当前价格 > 首仓入场价（首仓盈利 → 强势币）
  //   情况B：首仓已止盈出场（positionOpen=false 且 sellCount>0）
  // 不执行条件：
  //   首仓持有中 且 当前价格 <= 首仓入场价（首仓亏损 → 弱势币，只亏首仓）
  if (prevRsi < config.rsi.buyCross && rsi >= config.rsi.buyCross) {
    if (!token.active) return;

    // 判断是否允许执行RSI策略
    const firstPosInProfit = token.positionOpen &&
                             token.entryPrice &&
                             price > token.entryPrice;   // 首仓持有且盈利
    const firstPosTookProfit = !token.positionOpen &&
                               token.sellCount > 0;      // 首仓已止盈出场

    const rsiStrategyAllowed = firstPosInProfit || firstPosTookProfit;

    if (!rsiStrategyAllowed) {
      console.log(`[Strategy] SKIP add (first pos losing, price=$${price} entry=$${token.entryPrice}): ${token.symbol}`);
      return;
    }

    const canBuyFresh  = !token.addPositionOpen;
    const canDoubleAdd = token.addPositionOpen &&
                         token.addEntryPrice &&
                         token.additionCount < 2 &&
                         price <= token.addEntryPrice * (1 - config.rsi.reAddDropPct / 100);

    if (canBuyFresh || canDoubleAdd) {
      const reason = canDoubleAdd
        ? `RE_ADD (drop≥${config.rsi.reAddDropPct}%)`
        : `RSI_CROSS_UP_${config.rsi.buyCross}`;
      console.log(`[Strategy] BUY add ${reason}: ${token.symbol} RSI=${rsi.toFixed(2)} price=$${price}`);
      await webhookSender.sendBuy(address, token.symbol, reason, price);
      token.addPositionOpen = true;
      token.addEntryPrice   = price;
      token.pnl             = 0;
      token.additionCount++;
    }
  }
}

// 任何 SELL 信号机器人全仓卖出，所有仓位状态联动清除
function _clearAll(token) {
  token.positionOpen    = false;
  token.isFirstPosition = false;
  token.entryPrice      = null;
  token.addPositionOpen = false;
  token.addEntryPrice   = null;
  token.pnl             = 0;
  token.additionCount   = 0;
  token.sellCount++;
}

module.exports = { calcRSI, evaluateStrategy };
