const config = require('./config');
const logger = require('./logger');

class PaperTrader {
  constructor() {
    this.enabled = config.paperTrading.enabled;
    this.balance = config.paperTrading.initialBalance;
    this.equityCurve = [this.balance];
    this.positions = []; // { id, timeframe, direction, entry, sl, tp, lots, openedAt }
    this.closed = [];
    this.nextId = 1;
  }

  open(signal, riskParams, timeframe) {
    if (!this.enabled) return { opened: false, reason: 'Paper trading disabled' };
    if (this.positions.length >= config.paperTrading.maxOpenPositions) {
      return { opened: false, reason: 'Max open virtual positions reached' };
    }

    const pos = {
      id: this.nextId++,
      timeframe,
      direction: signal.signal,
      strategy: signal.strategy,
      confidence: signal.confidence,
      entry: riskParams.entryPrice,
      sl: riskParams.stopLoss,
      tp: riskParams.takeProfit,
      lots: riskParams.lots,
      riskAmount: riskParams.riskAmount,
      openedAt: new Date().toISOString(),
    };

    this.positions.push(pos);
    logger.info(`[Paper] OPEN #${pos.id} ${pos.direction} ${timeframe} @ ${pos.entry} (SL ${pos.sl} TP ${pos.tp})`);
    return { opened: true, position: pos };
  }

  updateWithCandle(timeframe, candle) {
    if (!this.enabled || !candle) return [];

    const closedNow = [];
    const remaining = [];

    for (const p of this.positions) {
      if (p.timeframe !== timeframe) {
        remaining.push(p);
        continue;
      }

      const hit = this._checkHit(p, candle);
      if (!hit) {
        remaining.push(p);
        continue;
      }

      const pnl = hit.result === 'WIN' ? p.riskAmount * 2 : -p.riskAmount;
      this.balance += pnl;
      this.equityCurve.push(this.balance);

      const record = {
        ...p,
        result: hit.result,
        exit: hit.price,
        closedAt: new Date().toISOString(),
        pnl,
      };

      this.closed.push(record);
      closedNow.push(record);
      logger.info(`[Paper] CLOSE #${p.id} ${hit.result} @ ${hit.price} | PnL: ${pnl.toFixed(2)} | Bal: ${this.balance.toFixed(2)}`);
    }

    this.positions = remaining;
    return closedNow;
  }

  _checkHit(p, candle) {
    if (p.direction === 'BUY') {
      if (candle.low <= p.sl) return { result: 'LOSS', price: p.sl };
      if (candle.high >= p.tp) return { result: 'WIN', price: p.tp };
    } else {
      if (candle.high >= p.sl) return { result: 'LOSS', price: p.sl };
      if (candle.low <= p.tp) return { result: 'WIN', price: p.tp };
    }
    return null;
  }

  stats() {
    const wins = this.closed.filter((t) => t.result === 'WIN').length;
    const losses = this.closed.filter((t) => t.result === 'LOSS').length;
    const total = this.closed.length;
    return {
      enabled: this.enabled,
      balance: Math.round(this.balance * 100) / 100,
      openPositions: this.positions.length,
      totalClosed: total,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      wins,
      losses,
    };
  }
}

module.exports = new PaperTrader();
