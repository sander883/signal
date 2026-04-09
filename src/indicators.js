const {
  EMA,
  SMA,
  RSI,
  MACD,
  BollingerBands,
  ATR,
  Stochastic,
  ADX,
} = require('technicalindicators');
const config = require('./config');
const logger = require('./logger');

class Indicators {
  /**
   * Compute all required indicators from candle data.
   * @param {Array} candles - Array of {open, high, low, close, volume}
   * @returns {Object} computed indicators
   */
  compute(candles) {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const opens = candles.map((c) => c.open);

    const ind = config.indicators;

    const result = {
      candles,
      closes,
      highs,
      lows,
      opens,

      // EMAs
      ema9: EMA.calculate({ period: ind.ema.fast, values: closes }),
      ema21: EMA.calculate({ period: ind.ema.medium, values: closes }),
      ema50: EMA.calculate({ period: ind.ema.slow, values: closes }),
      ema200: EMA.calculate({ period: ind.ema.trend, values: closes }),

      // RSI
      rsi: RSI.calculate({ period: ind.rsi.period, values: closes }),

      // MACD
      macd: MACD.calculate({
        values: closes,
        fastPeriod: ind.macd.fast,
        slowPeriod: ind.macd.slow,
        signalPeriod: ind.macd.signal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),

      // Bollinger Bands
      bb: BollingerBands.calculate({
        period: ind.bb.period,
        values: closes,
        stdDev: ind.bb.stdDev,
      }),

      // ATR
      atr: ATR.calculate({
        period: ind.atr.period,
        high: highs,
        low: lows,
        close: closes,
      }),

      // ADX (trend strength)
      adx: ADX.calculate({
        period: 14,
        close: closes,
        high: highs,
        low: lows,
      }),
    };

    // Support / Resistance levels (swing highs / lows)
    result.supportResistance = this._findSupportResistance(candles);

    // Supply / Demand zones
    result.supplyDemand = this._findSupplyDemandZones(candles);

    // BOS / CHOCH detection
    result.structureBreaks = this._detectStructureBreaks(candles);

    logger.debug(`Indicators computed: ${closes.length} candles`);
    return result;
  }

  /**
   * Find support and resistance from recent swing highs/lows.
   */
  _findSupportResistance(candles, lookback = 20) {
    const levels = { support: [], resistance: [] };
    const recent = candles.slice(-100);

    for (let i = lookback; i < recent.length - lookback; i++) {
      const window = recent.slice(i - lookback, i + lookback + 1);
      const high = recent[i].high;
      const low = recent[i].low;

      // Swing high: highest in window
      const isSwingHigh = window.every((c) => c.high <= high);
      if (isSwingHigh) {
        levels.resistance.push(high);
      }

      // Swing low: lowest in window
      const isSwingLow = window.every((c) => c.low >= low);
      if (isSwingLow) {
        levels.support.push(low);
      }
    }

    // Keep most recent levels
    levels.support = [...new Set(levels.support)].slice(-5);
    levels.resistance = [...new Set(levels.resistance)].slice(-5);

    return levels;
  }

  /**
   * Supply/Demand zone identification.
   * Supply zone: sharp bearish move after consolidation.
   * Demand zone: sharp bullish move after consolidation.
   */
  _findSupplyDemandZones(candles) {
    const zones = { supply: [], demand: [] };
    const recent = candles.slice(-80);
    const threshold = 0.003; // 0.3% move threshold for gold

    for (let i = 2; i < recent.length - 1; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      const bodySize = Math.abs(curr.close - curr.open);
      const avgBody =
        recent.slice(Math.max(0, i - 10), i).reduce((s, c) => s + Math.abs(c.close - c.open), 0) /
        Math.min(i, 10);

      // Large bullish candle = demand zone at its base
      if (curr.close > curr.open && bodySize > avgBody * 2 && bodySize / curr.open > threshold) {
        zones.demand.push({
          high: Math.max(curr.open, prev.low),
          low: Math.min(curr.open, prev.low),
          strength: bodySize / avgBody,
        });
      }

      // Large bearish candle = supply zone at its top
      if (curr.open > curr.close && bodySize > avgBody * 2 && bodySize / curr.open > threshold) {
        zones.supply.push({
          high: Math.max(curr.open, prev.high),
          low: Math.min(curr.open, prev.high),
          strength: bodySize / avgBody,
        });
      }
    }

    // Keep strongest zones
    zones.supply = zones.supply.sort((a, b) => b.strength - a.strength).slice(0, 5);
    zones.demand = zones.demand.sort((a, b) => b.strength - a.strength).slice(0, 5);

    return zones;
  }

  /**
   * Detect Break of Structure (BOS) and Change of Character (CHOCH).
   * BOS: Price breaks previous swing high/low in trend direction.
   * CHOCH: Price breaks against the trend direction, signaling reversal.
   */
  _detectStructureBreaks(candles) {
    const result = { bos: null, choch: null, trend: 'neutral' };
    const recent = candles.slice(-60);
    if (recent.length < 20) return result;

    // Find swing points
    const swingHighs = [];
    const swingLows = [];

    for (let i = 5; i < recent.length - 5; i++) {
      const win = recent.slice(i - 5, i + 6);
      if (win.every((c) => c.high <= recent[i].high)) {
        swingHighs.push({ index: i, price: recent[i].high });
      }
      if (win.every((c) => c.low >= recent[i].low)) {
        swingLows.push({ index: i, price: recent[i].low });
      }
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return result;

    const lastHigh = swingHighs[swingHighs.length - 1];
    const prevHigh = swingHighs[swingHighs.length - 2];
    const lastLow = swingLows[swingLows.length - 1];
    const prevLow = swingLows[swingLows.length - 2];
    const currentPrice = recent[recent.length - 1].close;

    // Determine current structure trend
    const higherHighs = lastHigh.price > prevHigh.price;
    const higherLows = lastLow.price > prevLow.price;
    const lowerHighs = lastHigh.price < prevHigh.price;
    const lowerLows = lastLow.price < prevLow.price;

    if (higherHighs && higherLows) result.trend = 'bullish';
    else if (lowerHighs && lowerLows) result.trend = 'bearish';

    // BOS: Break in trend direction
    if (result.trend === 'bullish' && currentPrice > lastHigh.price) {
      result.bos = { direction: 'bullish', level: lastHigh.price };
    } else if (result.trend === 'bearish' && currentPrice < lastLow.price) {
      result.bos = { direction: 'bearish', level: lastLow.price };
    }

    // CHOCH: Break against trend direction (reversal signal)
    if (result.trend === 'bullish' && currentPrice < lastLow.price) {
      result.choch = { direction: 'bearish', level: lastLow.price };
    } else if (result.trend === 'bearish' && currentPrice > lastHigh.price) {
      result.choch = { direction: 'bullish', level: lastHigh.price };
    }

    return result;
  }

  /**
   * Get the latest value from an indicator array, aligned to candle index.
   */
  latest(arr, offset = 0) {
    if (!arr || arr.length === 0) return null;
    const idx = arr.length - 1 - offset;
    return idx >= 0 ? arr[idx] : null;
  }
}

module.exports = new Indicators();
