// src/birdeyeWs.js
// BirdEye WebSocket — 订阅成交流 (SUBSCRIBE_TXS)
// 每笔真实成交推送一条 trade，本地按时间窗口聚合成 5s K 线

const WebSocket  = require('ws');
const config     = require('./config');
const tokenStore = require('./tokenStore');

const CANDLE_SEC = config.monitor.candleIntervalSeconds; // 5

class BirdeyeWsManager {
  constructor() {
    this.ws             = null;
    this.connected      = false;
    this.reconnectDelay = 3000;
    this.subscriptions  = new Set();
    this.pingInterval   = null;
  }

  // ─── Public ──────────────────────────────────────────────────────

  connect() {
    console.log('[BirdEye WS] Connecting...');
    const url = `${config.birdeye.wsUrl}?x-api-key=${config.birdeye.apiKey}`;
    this.ws = new WebSocket(url, {
      headers: { 'x-api-key': config.birdeye.apiKey },
    });

    this.ws.on('open', () => {
      console.log('[BirdEye WS] Connected');
      this.connected = true;

      // 重连时清空未封口窗口，防止脏数据
      for (const addr of this.subscriptions) {
        const token = tokenStore.getToken(addr);
        if (token) token._candleWindow = null;
      }

      for (const addr of this.subscriptions) {
        this._sendSubscribe(addr);
      }

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data) => this._handleMessage(data));

    this.ws.on('close', () => {
      console.log('[BirdEye WS] Disconnected, reconnecting in 3s...');
      this.connected = false;
      clearInterval(this.pingInterval);
      this.pingInterval = null;
      this.ws.removeAllListeners();
      this.ws = null;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('error', (err) => {
      console.error('[BirdEye WS] Error:', err.message);
    });
  }

  subscribe(address) {
    this.subscriptions.add(address);
    if (this.connected) this._sendSubscribe(address);
  }

  unsubscribe(address) {
    this.subscriptions.delete(address);
    const token = tokenStore.getToken(address);
    if (token) token._candleWindow = null;

    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          type: 'UNSUBSCRIBE_TXS',
          data: { queryType: 'simple', address },
        }));
        console.log(`[BirdEye WS] Unsubscribed: ${address}`);
      } catch (_) {}
    }
  }

  // ─── Private ─────────────────────────────────────────────────────

  _sendSubscribe(address) {
    try {
      this.ws.send(JSON.stringify({
        type: 'SUBSCRIBE_TXS',
        data: { queryType: 'simple', address },
      }));
      console.log(`[BirdEye WS] Subscribed: ${address}`);
    } catch (e) {
      console.error('[BirdEye WS] Subscribe error:', e.message);
    }
  }

  _handleMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'TXS_DATA' || !msg.data) return;

      const d       = msg.data;
      const address = d.address;
      if (!address) return;

      const token = tokenStore.getToken(address);
      if (!token || !token.active) return;

      const price  = parseFloat(d.price);
      const volume = parseFloat(d.volume ?? d.amount ?? 0);
      const ts     = parseInt(d.blockUnixTime ?? d.unixTime ?? Math.floor(Date.now() / 1000));

      if (!price || price <= 0 || !ts) return;

      // 更新最新价与浮盈
      tokenStore.updateTokenData(address, { price });
      if (token.positionOpen && token.entryPrice) {
        token.pnl = parseFloat(
          ((price - token.entryPrice) / token.entryPrice * 100).toFixed(2)
        );
      }

      // 每笔成交实时止盈检查
      this._checkTakeProfit(address, price);

      // 聚合进 5s K 线窗口
      this._accumulateTrade(address, price, volume, ts);

    } catch (_) {}
  }

  // ── 实时止盈检查（首仓，每笔成交触发）────────────────────────────
  // 避免价格在 K 线内冲高后回落，K 线封口时漏掉止盈点
  _checkTakeProfit(address, price) {
    const token = tokenStore.getToken(address);
    if (!token || !token.active)  return;
    if (!token.positionOpen)      return;
    if (!token.entryPrice)        return;

    const tpPct   = config.rsi.tpPct / 100;
    const tpPrice = token.entryPrice * (1 + tpPct);

    if (price >= tpPrice) {
      const webhookSender = require('./webhookSender');
      console.log(
        `[WS-TP] SELL TP +${config.rsi.tpPct}%: ${token.symbol} ` +
        `price=$${price.toFixed(8)} entry=$${token.entryPrice.toFixed(8)}`
      );
      webhookSender.sendSell(
        address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice
      ).then(() => {
        token.positionOpen    = false;
        token.isFirstPosition = false;
        token.entryPrice      = null;
        token.pnl             = 0;
        token.sellCount++;
      });
    }
  }

  // ── 5s K 线聚合 ───────────────────────────────────────────────────
  _accumulateTrade(address, price, volume, ts) {
    const token = tokenStore.getToken(address);
    if (!token) return;

    const windowStart = Math.floor(ts / CANDLE_SEC) * CANDLE_SEC;

    if (!token._candleWindow) {
      token._candleWindow = _newWindow(windowStart, price, volume);
      return;
    }

    const w = token._candleWindow;

    if (windowStart === w.windowStart) {
      if (price > w.high) w.high = price;
      if (price < w.low)  w.low  = price;
      w.close   = price;
      w.volume += volume;
      w.trades++;
      return;
    }

    if (windowStart > w.windowStart) {
      if (w.trades > 0) {
        const candle = {
          time:   w.windowStart,
          open:   w.open,
          high:   w.high,
          low:    w.low,
          close:  w.close,
          volume: w.volume,
          trades: w.trades,
        };
        token.candles.push(candle);
        if (token.candles.length > 500) token.candles.shift();

        tokenStore.pushClose(address, candle.close);
        tokenStore.emit('newCandle', { address, candle, token });

        console.log(
          `[Candle] ${token.symbol} | t=${candle.time} | ` +
          `O=${candle.open.toFixed(8)} H=${candle.high.toFixed(8)} ` +
          `L=${candle.low.toFixed(8)} C=${candle.close.toFixed(8)} | ` +
          `vol=$${candle.volume.toFixed(2)} txs=${candle.trades}`
        );
      }

      // 补填无成交空窗口
      let fillStart = w.windowStart + CANDLE_SEC;
      while (fillStart < windowStart) {
        token.candles.push({
          time: fillStart, open: w.close, high: w.close,
          low: w.close, close: w.close, volume: 0, trades: 0, isFill: true,
        });
        if (token.candles.length > 500) token.candles.shift();
        tokenStore.pushClose(address, w.close);
        fillStart += CANDLE_SEC;
      }

      token._candleWindow = _newWindow(windowStart, price, volume);
    }
    // 迟到成交直接丢弃
  }
}

function _newWindow(windowStart, price, volume) {
  return {
    windowStart,
    open:   price,
    high:   price,
    low:    price,
    close:  price,
    volume: volume || 0,
    trades: 1,
  };
}

module.exports = new BirdeyeWsManager();
