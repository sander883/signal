const config = require('./config');
const logger = require('./logger');
const dataCollector = require('./dataCollector');

class PaperTrader {
  constructor() {
    this.enabled = config.paperTrading.enabled;
    this.balance = config.paperTrading.initialBalance;
    this.equityCurve = [this.balance];
    this.positions = []; // { id, timeframe, direction, entry, sl, tp, lots, openedAt }
    this.closed = [];
    this.nextId = 1;
  }

  /**
   * Restore open positions, closed history, and balance from persisted state.
   */
  restore(state) {
    if (!state) return;
    if (typeof state.paperBalance === 'number') this.balance = state.paperBalance;
    if (Array.isArray(state.paperPositions)) {
      // Backfill MFE/MAE fields on positions saved before the dataset layer
      this.positions = state.paperPositions.map((p) => ({
        ...p,
        mfe: typeof p.mfe === 'number' ? p.mfe : 0,
        mae: typeof p.mae === 'number' ? p.mae : 0,
      }));
      this.nextId = Math.max(...this.positions.map((p) => p.id), 0) + 1;
    }
    if (Array.isArray(state.paperClosed)) {
      this.closed = state.paperClosed;
      this.nextId = Math.max(
        this.nextId,
        ...this.closed.map((p) => p.id || 0),
      ) + 1;
    }
    this.equityCurve = [this.balance];
    logger.info(
      `[Paper] Restored: balance=${this.balance.toFixed(2)} open=${this.positions.length} closed=${this.closed.length}`
    );
  }

  /**
   * Snapshot current state for persistence.
   */
  snapshot() {
    return {
      paperBalance: this.balance,
      paperPositions: this.positions,
      paperClosed: this.closed.slice(-100),
    };
  }

  open(signal, riskParams, timeframe) {
    if (!this.enabled) return { opened: false, reason: 'Paper trading disabled' };
    if (this.positions.length >= config.paperTrading.maxOpenPositions) {
      return { opened: false, reason: 'Max open virtual positions reached' };
    }

    const pos = {
      id: this.nextId++,
      // Link back to the dataCollector signal log row so we can later
      // join features → outcome when training models.
      signal_id: signal.id || null,
      timeframe,
      direction: signal.signal,
      strategy: signal.strategy,
      confidence: signal.confidence,
      entry: riskParams.entryPrice,
      sl: riskParams.stopLoss,
      tp: riskParams.takeProfit,
      lots: riskParams.lots,
      riskAmount: riskParams.riskAmount,
      slDistance: riskParams.slDistance, // needed to compute R-multiples at close
      openedAt: new Date().toISOString(),
      // Excursion tracking — updated per-candle while position is open
      mfe: 0, // max favorable (absolute price)
      mae: 0, // max adverse (absolute price)
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

      // Update MFE/MAE from candle extremes BEFORE checking hit so we
      // capture the full intrabar excursion, not just what happens at close.
      this._updateExcursion(p, candle);

      const hit = this._checkHit(p, candle);
      if (!hit) {
        remaining.push(p);
        continue;
      }

      const pnl = hit.result === 'WIN' ? p.riskAmount * 2 : -p.riskAmount;
      this.balance += pnl;
      this.equityCurve.push(this.balance);

      const closedMs = Date.now();
      const openedMs = new Date(p.openedAt).getTime();
      const durationMin = Math.max(0, Math.round((closedMs - openedMs) / 60000));

      // MFE/MAE as R-multiples (fraction of initial SL distance).
      // mfe_r = 1.0  → price moved in our favor by 1× the stop distance
      // mae_r = 0.7  → worst adverse move was 70% of the stop distance
      const mfeR = p.slDistance > 0 ? Math.round((p.mfe / p.slDistance) * 100) / 100 : 0;
      const maeR = p.slDistance > 0 ? Math.round((p.mae / p.slDistance) * 100) / 100 : 0;

      const record = {
        ...p,
        result: hit.result,
        exit: hit.price,
        closedAt: new Date(closedMs).toISOString(),
        durationMin,
        pnl,
        mfe: Math.round(p.mfe * 100) / 100,
        mae: Math.round(p.mae * 100) / 100,
        mfe_r: mfeR,
        mae_r: maeR,
      };

      this.closed.push(record);
      closedNow.push(record);
      logger.info(
        `[Paper] CLOSE #${p.id} ${hit.result} @ ${hit.price} | PnL: ${pnl.toFixed(2)} | ` +
          `MFE: ${record.mfe} (${mfeR}R) MAE: ${record.mae} (${maeR}R) | Bal: ${this.balance.toFixed(2)}`
      );

      // Append to long-term dataset (never crashes main pipeline on error)
      dataCollector.logTrade(record);
    }

    this.positions = remaining;
    return closedNow;
  }

  /**
   * Update Max Favorable / Adverse Excursion based on the candle's extremes.
   *
   * - MFE = best price move in the trade's favor while the position was open
   * - MAE = worst adverse move while the position was open
   *
   * Both are stored in absolute price units. R-multiples are computed at close.
   * This data is gold for exit optimization: "were our TPs too conservative?"
   */
  _updateExcursion(p, candle) {
    if (p.direction === 'BUY') {
      const favor = candle.high - p.entry;
      const adverse = p.entry - candle.low;
      if (favor > p.mfe) p.mfe = favor;
      if (adverse > p.mae) p.mae = adverse;
    } else {
      const favor = p.entry - candle.low;
      const adverse = candle.high - p.entry;
      if (favor > p.mfe) p.mfe = favor;
      if (adverse > p.mae) p.mae = adverse;
    }
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
