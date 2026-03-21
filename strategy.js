// src/strategy.js
// RSI(7) 交易策略
//
// ┌─ 代币收录 ──────────────────────────────────────────────────────┐
// │  不立即买入，进入监控等待信号                                      │
// │                                                                 │
// │  买入：RSI(7) 上穿 30（prevRsi<30 且 rsi>=30）                   │
// │        addPositionOpen=false 时才触发（防重复买）                 │
// │                                                                 │
// │  卖出（addPositionOpen=true）：                                  │
// │    K线最高价相对入场价 +150% → SELL（TP_+150%）                   │
// │    K线最低价相对入场价 -50%  → SELL（SL_-50%）                    │
// │                                                                 │
// │  重要：用K线high/low判断止盈止损，而非收盘价                        │
// │        避免价格在两根K线之间快速穿越止盈/止损价位而漏掉信号           │
// │                                                                 │
// │  Age > 30min → AGE_EXPIRE 信号由白名单退出机制负责，不在此处理      │
// └─────────────────────────────────────────────────────────────────┘

const { RSI }       = require('technicalindicators');
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

  // prevRsi 从 closes 倒数第二位直接计算，不依赖上次存的值
  const prevCloses = closes.slice(0, -1);
  const prevRsi    = prevCloses.length >= RSI_PERIOD + 1 ? calcRSI(prevCloses) : null;

  token.prevRsi = prevRsi;
  token.rsi     = rsi;

  if (prevRsi === null) return;

  // 当前价格（收盘价）
  const price = token.price || closes[closes.length - 1];

  // K线最高价和最低价（用于止盈止损判断，避免漏掉K线内的极值）
  const high = (candle && candle.high) ? candle.high : price;
  const low  = (candle && candle.low)  ? candle.low  : price;

  // ── 持仓中：止盈 / 止损 ───────────────────────────────────────────
  if (token.addPositionOpen) {

    // 入场价兜底
    if (!token.addEntryPrice && price) {
      token.addEntryPrice = price;
      console.log(`[Strategy] Entry price set: $${price} for ${token.symbol}`);
    }

    if (token.addEntryPrice) {
      const tpPrice = token.addEntryPrice * (1 + config.rsi.tpPct / 100);
      const slPrice = token.addEntryPrice * (1 - config.rsi.slPct / 100);

      // 用 high 判断止盈（K线内是否触及止盈价）
      if (high >= tpPrice) {
        const exitPrice = tpPrice; // 以止盈价格成交
        const gainPct   = ((exitPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL TP +${gainPct}%: ${token.symbol} entry=$${token.addEntryPrice} high=$${high}`);
        await webhookSender.sendSell(
          address, token.symbol,
          `TP_+${config.rsi.tpPct}%`,
          exitPrice
        );
        _clearPosition(token);
        return;
      }

      // 用 low 判断止损（K线内是否触及止损价）
      if (low <= slPrice) {
        const exitPrice = slPrice;
        const lossPct   = ((exitPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL SL ${lossPct}%: ${token.symbol} entry=$${token.addEntryPrice} low=$${low}`);
        await webhookSender.sendSell(
          address, token.symbol,
          `SL_-${config.rsi.slPct}%`,
          exitPrice
        );
        _clearPosition(token);
        return;
      }

      // 更新浮盈显示
      token.pnl = parseFloat(((price - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(2));
    }
  }

  // ── RSI(7) 上穿 30 → 买入 ────────────────────────────────────────
  if (!token.addPositionOpen &&
      prevRsi < config.rsi.buyCross &&
      rsi >= config.rsi.buyCross) {
    if (!token.active) return;
    console.log(`[Strategy] BUY (RSI cross↑${config.rsi.buyCross}): ${token.symbol} RSI=${rsi.toFixed(2)} price=$${price}`);
    await webhookSender.sendBuy(
      address, token.symbol,
      `RSI_CROSS_UP_${config.rsi.buyCross}`,
      price
    );
    token.addPositionOpen = true;
    token.addEntryPrice   = price;
    token.pnl             = 0;
    token.additionCount++;
  }
}

// 清除所有仓位状态
function _clearPosition(token) {
  token.addPositionOpen = false;
  token.addEntryPrice   = null;
  token.pnl             = 0;
  token.sellCount++;
  // 首仓状态同步清除（机器人全仓卖出）
  token.positionOpen    = false;
  token.isFirstPosition = false;
  token.entryPrice      = null;
}

module.exports = { calcRSI, evaluateStrategy };
