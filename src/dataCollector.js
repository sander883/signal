const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const indicators = require('./indicators');

/**
 * Data Collection Layer — ML dataset builder
 *
 * Writes append-only JSONL files to data/ for future training and analysis:
 *
 *   data/signals-YYYY-MM-DD.jsonl   Every signal decision (sent AND blocked).
 *                                   Logging rejected signals is CRITICAL to
 *                                   avoid survivorship bias during training.
 *
 *   data/trades-YYYY-MM-DD.jsonl    Paper trade close events enriched with
 *                                   MFE/MAE (max favorable / adverse excursion)
 *                                   — crucial inputs for exit optimization.
 *
 * Design principles:
 * - Append-only, one JSON per line → easy to read from pandas/polars/duckdb.
 * - Daily file rotation so files stay manageable.
 * - Silent failure: data logging must NEVER crash the main pipeline.
 * - Short field names in candle windows to save disk space.
 *
 * File size estimate (2 TFs, 15min cron):
 *   ~400 signal records/day × ~5 KB = ~2 MB/day
 *   ~1 trade record per signal sent ≈ ~40 KB/day
 *   → ~60 MB/month. Gzip old files manually if retention > 6 months.
 */

const DATA_DIR = path.join(process.cwd(), 'data');

class DataCollector {
  constructor() {
    this.enabled = config.dataCollection.enabled;
    this.logBlocks = config.dataCollection.logBlocks;
    this.candleWindow = config.dataCollection.candleWindow;
    this.signalCount = 0;
    this.tradeCount = 0;
    this.writeErrors = 0;
  }

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _todayFile(prefix) {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(DATA_DIR, `${prefix}-${date}.jsonl`);
  }

  _append(prefix, record) {
    try {
      this._ensureDir();
      fs.appendFileSync(this._todayFile(prefix), JSON.stringify(record) + '\n');
      return true;
    } catch (err) {
      this.writeErrors++;
      logger.error(`[DataCollector] ${prefix} write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Generate a unique id for linking a signal log row to its downstream paper
   * trade log row. Short, sortable by time (base36 timestamp + random suffix).
   */
  generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Log a signal decision. `decision` tag tells the future analyst WHY the
   * signal took this path, so rejected signals are still valuable:
   *
   *   sent                signal passed all filters and alerted
   *   no_signal           strategies produced nothing this cycle
   *   blocked_session     session filter rejected
   *   blocked_news        news filter rejected
   *   blocked_low_conf    final confidence below 50%
   *   blocked_dxy         DXY conflict dropped confidence below 50%
   *   blocked_risk        risk / quality gate rejected
   *   blocked_ai          AI agent rejected
   *   blocked_dedupe      duplicate of recent signal
   *   blocked_data        insufficient candle data
   */
  logSignal(entry) {
    if (!this.enabled) return;
    // Honor logBlocks flag for non-sent decisions
    if (!this.logBlocks && entry.decision && entry.decision !== 'sent') return;

    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    if (this._append('signals', record)) this.signalCount++;
  }

  /**
   * Log a paper trade close event. Expected to be called from paperTrader.
   */
  logTrade(entry) {
    if (!this.enabled) return;
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    if (this._append('trades', record)) this.tradeCount++;
  }

  /**
   * Extract a compact feature snapshot from computed indicator data.
   * Every field is a scalar or primitive for easy consumption by
   * tabular ML libraries.
   */
  extractFeatures(indData, extras = {}) {
    if (!indData) return { ...extras };
    const latest = (arr) => indicators.latest(arr);
    const bb = latest(indData.bb);
    const macd = latest(indData.macd);
    const atr = latest(indData.atr);
    return {
      ema9: latest(indData.ema9),
      ema21: latest(indData.ema21),
      ema50: latest(indData.ema50),
      ema200: latest(indData.ema200),
      rsi: latest(indData.rsi),
      atr,
      bb_upper: bb?.upper ?? null,
      bb_middle: bb?.middle ?? null,
      bb_lower: bb?.lower ?? null,
      macd: macd?.MACD ?? null,
      macd_signal: macd?.signal ?? null,
      macd_hist: macd?.histogram ?? null,
      regime_type: indData.regime?.type ?? null,
      regime_strength: indData.regime?.strength ?? null,
      regime_direction: indData.regime?.direction ?? null,
      ...extras,
    };
  }

  /**
   * Compact a candle array to the last N candles with short field names.
   * Short keys (o/h/l/c/v/t) reduce disk usage ~30% vs verbose keys.
   */
  compactCandles(candles, n = this.candleWindow) {
    if (!Array.isArray(candles)) return [];
    return candles.slice(-n).map((c) => ({
      t: c.time,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume || 0,
    }));
  }

  /**
   * Stats for /metrics endpoint and heartbeat logs.
   */
  stats() {
    return {
      enabled: this.enabled,
      signalsLogged: this.signalCount,
      tradesLogged: this.tradeCount,
      writeErrors: this.writeErrors,
    };
  }
}

module.exports = new DataCollector();
