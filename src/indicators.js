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
   * Includes adaptive periods based on current volatility.
   */
  compute(candles) {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const opens = candles.map((c) => c.open);
    const volumes = candles.map((c) => c.volume || 0);

    const ind = config.indicators;

    // ── Adaptive Periods ──
    // In high volatility: use longer periods to filter noise
    // In low volatility: use shorter periods for quicker signals
    const adaptiveFactor = this._getAdaptiveFactor(highs, lows, closes);

    const rsiPeriod = this._adaptPeriod(ind.rsi.period, adaptiveFactor, 10, 21);
    const bbPeriod = this._adaptPeriod(ind.bb.period, adaptiveFactor, 14, 30);
    const atrPeriod = this._adaptPeriod(ind.atr.period, adaptiveFactor, 10, 21);

    const result = {
      candles,
      closes,
      highs,
      lows,
      opens,
      volumes,
      adaptiveFactor, // expose for strategies

      // EMAs (fixed periods — trend structure shouldn't adapt)
      ema9: EMA.calculate({ period: ind.ema.fast, values: closes }),
      ema21: EMA.calculate({ period: ind.ema.medium, values: closes }),
      ema50: EMA.calculate({ period: ind.ema.slow, values: closes }),
      ema200: EMA.calculate({ period: ind.ema.trend, values: closes }),

      // RSI (adaptive)
      rsi: RSI.calculate({ period: rsiPeriod, values: closes }),

      // MACD (fixed — uses EMA internally)
      macd: MACD.calculate({
        values: closes,
        fastPeriod: ind.macd.fast,
        slowPeriod: ind.macd.slow,
        signalPeriod: ind.macd.signal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),

      // Bollinger Bands (adaptive period)
      bb: BollingerBands.calculate({
        period: bbPeriod,
        values: closes,
        stdDev: ind.bb.stdDev,
      }),

      // ATR (adaptive)
      atr: ATR.calculate({
        period: atrPeriod,
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

      // Stochastic (momentum crossover)
      stoch: Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3,
      }),
    };

    // VWAP
    result.vwap = this._computeVWAP(candles);

    // Market Regime detection
    result.regime = this._detectRegime(result);

    // Support / Resistance (improved with clustering)
    result.supportResistance = this._findSupportResistance(candles, result.atr);

    // Supply / Demand zones (fixed edge cases)
    result.supplyDemand = this._findSupplyDemandZones(candles);

    // BOS / CHOCH detection
    result.structureBreaks = this._detectStructureBreaks(candles);

    logger.debug(
      `Indicators computed: ${closes.length} candles | regime: ${result.regime.type} | ` +
        `adaptive: ${adaptiveFactor.toFixed(2)} | RSI period: ${rsiPeriod}`
    );
    return result;
  }

  // ══════════════════════════════════════════
  // ADAPTIVE INDICATOR PERIODS
  // ══════════════════════════════════════════

  /**
   * Compute adaptive factor based on current vs historical volatility.
   * >1 = high volatility (use longer periods), <1 = low volatility (shorter).
   */
  _getAdaptiveFactor(highs, lows, closes) {
    if (closes.length < 50) return 1.0;

    // Recent ATR (last 14 candles) vs historical ATR (last 50)
    const recentATR = this._simpleATR(highs.slice(-14), lows.slice(-14), closes.slice(-14));
    const historicalATR = this._simpleATR(highs.slice(-50), lows.slice(-50), closes.slice(-50));

    if (historicalATR === 0) return 1.0;
    const ratio = recentATR / historicalATR;

    // Clamp between 0.7 and 1.5
    return Math.max(0.7, Math.min(1.5, ratio));
  }

  _simpleATR(highs, lows, closes) {
    let sum = 0;
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      sum += tr;
    }
    return sum / (highs.length - 1) || 0;
  }

  _adaptPeriod(basePeriod, factor, min, max) {
    return Math.round(Math.max(min, Math.min(max, basePeriod * factor)));
  }

  // ══════════════════════════════════════════
  // VWAP (Volume Weighted Average Price)
  // ══════════════════════════════════════════

  /**
   * Compute cumulative VWAP and upper/lower bands.
   * Acts as dynamic support/resistance based on volume.
   */
  _computeVWAP(candles) {
    if (candles.length < 10) return { values: [], upper: [], lower: [] };

    const values = [];
    let cumVolPrice = 0;
    let cumVol = 0;
    let cumVP2 = 0; // for std dev bands

    // Use last 50 candles for intraday VWAP
    const recent = candles.slice(-50);

    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const typicalPrice = (c.high + c.low + c.close) / 3;
      const vol = c.volume || 1; // fallback if no volume

      cumVolPrice += typicalPrice * vol;
      cumVol += vol;
      cumVP2 += typicalPrice * typicalPrice * vol;

      const vwap = cumVolPrice / cumVol;
      const variance = cumVP2 / cumVol - vwap * vwap;
      const stdDev = Math.sqrt(Math.max(0, variance));

      values.push(vwap);
    }

    // Compute bands from last VWAP stddev
    const lastVwap = values[values.length - 1];
    const lastTP = (recent[recent.length - 1].high + recent[recent.length - 1].low + recent[recent.length - 1].close) / 3;
    const lastVariance = cumVP2 / cumVol - lastVwap * lastVwap;
    const lastStdDev = Math.sqrt(Math.max(0, lastVariance));

    return {
      values,
      current: lastVwap,
      upper: lastVwap + lastStdDev * 2,
      lower: lastVwap - lastStdDev * 2,
      stdDev: lastStdDev,
    };
  }

  // ══════════════════════════════════════════
  // MARKET REGIME DETECTION
  // ══════════════════════════════════════════

  /**
   * Detect current market regime: trending, ranging, or volatile.
   * Used by strategies to adapt their behavior.
   */
  _detectRegime(data) {
    const result = { type: 'unknown', strength: 0, direction: 'neutral' };

    const adxVal = this.latest(data.adx);
    const currEma50 = this.latest(data.ema50);
    const currEma200 = this.latest(data.ema200);
    const currAtr = this.latest(data.atr);
    const prevAtr = this.latest(data.atr, 5);

    if (!adxVal || !currEma50 || !currEma200) return result;

    const adx = adxVal.adx;

    // Trending: ADX > 25, EMAs separated
    if (adx > 25) {
      result.type = 'trending';
      result.strength = Math.min(100, Math.round(adx));
      result.direction = currEma50 > currEma200 ? 'bullish' : 'bearish';
    }
    // Volatile: ADX low but ATR spiking
    else if (currAtr && prevAtr && currAtr > prevAtr * 1.5) {
      result.type = 'volatile';
      result.strength = Math.round((currAtr / prevAtr) * 50);
      result.direction = 'neutral';
    }
    // Ranging: ADX < 20, EMAs close together
    else if (adx < 20) {
      result.type = 'ranging';
      result.strength = Math.round(20 - adx);
      result.direction = 'neutral';
    }
    // Weak trend
    else {
      result.type = 'weak-trend';
      result.strength = Math.round(adx);
      result.direction = currEma50 > currEma200 ? 'bullish' : 'bearish';
    }

    return result;
  }

  // ══════════════════════════════════════════
  // SUPPORT / RESISTANCE (Improved with clustering)
  // ══════════════════════════════════════════

  /**
   * Find support and resistance with ATR-based clustering.
   * Levels within 0.5 ATR of each other are merged into one.
   */
  _findSupportResistance(candles, atrValues) {
    const levels = { support: [], resistance: [] };
    const recent = candles.slice(-120);
    if (recent.length < 30) return levels;

    const atr = this.latest(atrValues) || 5;
    const clusterDistance = atr * 0.5;

    // Use multiple lookback windows (5, 10, 15) for different scale swing points
    for (const lookback of [5, 10, 15]) {
      for (let i = lookback; i < recent.length - lookback; i++) {
        const candle = recent[i];
        const windowBefore = recent.slice(i - lookback, i);
        const windowAfter = recent.slice(i + 1, i + lookback + 1);
        const window = [...windowBefore, ...windowAfter];

        // Swing high
        if (window.every((c) => c.high <= candle.high)) {
          levels.resistance.push({ price: candle.high, strength: lookback });
        }
        // Swing low
        if (window.every((c) => c.low >= candle.low)) {
          levels.support.push({ price: candle.low, strength: lookback });
        }
      }
    }

    // Cluster nearby levels (merge within clusterDistance)
    levels.resistance = this._clusterLevels(levels.resistance, clusterDistance);
    levels.support = this._clusterLevels(levels.support, clusterDistance);

    return levels;
  }

  /**
   * Merge price levels that are close together.
   * Returns array of prices sorted by strength (most tested first).
   */
  _clusterLevels(levels, distance) {
    if (levels.length === 0) return [];

    // Sort by price
    levels.sort((a, b) => a.price - b.price);

    const clusters = [];
    let cluster = [levels[0]];

    for (let i = 1; i < levels.length; i++) {
      if (levels[i].price - cluster[cluster.length - 1].price <= distance) {
        cluster.push(levels[i]);
      } else {
        clusters.push(cluster);
        cluster = [levels[i]];
      }
    }
    clusters.push(cluster);

    // Each cluster → single level (weighted average price, strength = count)
    return clusters
      .map((c) => {
        const totalStrength = c.reduce((s, l) => s + l.strength, 0);
        const avgPrice = c.reduce((s, l) => s + l.price * l.strength, 0) / totalStrength;
        return { price: Math.round(avgPrice * 100) / 100, touches: c.length, strength: totalStrength };
      })
      .sort((a, b) => b.touches - a.touches) // most tested first
      .slice(0, 8) // keep top 8
      .map((l) => l.price);
  }

  // ══════════════════════════════════════════
  // SUPPLY / DEMAND ZONES (Fixed edge cases)
  // ══════════════════════════════════════════

  _findSupplyDemandZones(candles) {
    const zones = { supply: [], demand: [] };
    const recent = candles.slice(-80);
    if (recent.length < 10) return zones;

    const threshold = 0.003; // 0.3%

    for (let i = 2; i < recent.length - 1; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      const bodySize = Math.abs(curr.close - curr.open);
      const avgBody =
        recent.slice(Math.max(0, i - 10), i).reduce((s, c) => s + Math.abs(c.close - c.open), 0) /
        Math.min(i, 10);

      if (avgBody === 0) continue; // avoid division by zero

      // Demand zone: large bullish candle
      if (curr.close > curr.open && bodySize > avgBody * 2 && bodySize / curr.open > threshold) {
        const zoneLow = Math.min(curr.open, prev.low);
        const zoneHigh = Math.max(curr.open, prev.low);
        // Validate zone has positive width
        if (zoneHigh > zoneLow) {
          zones.demand.push({ high: zoneHigh, low: zoneLow, strength: bodySize / avgBody });
        }
      }

      // Supply zone: large bearish candle
      if (curr.open > curr.close && bodySize > avgBody * 2 && bodySize / curr.open > threshold) {
        const zoneLow = Math.min(curr.open, prev.high);
        const zoneHigh = Math.max(curr.open, prev.high);
        if (zoneHigh > zoneLow) {
          zones.supply.push({ high: zoneHigh, low: zoneLow, strength: bodySize / avgBody });
        }
      }
    }

    zones.supply = zones.supply.sort((a, b) => b.strength - a.strength).slice(0, 5);
    zones.demand = zones.demand.sort((a, b) => b.strength - a.strength).slice(0, 5);

    return zones;
  }

  // ══════════════════════════════════════════
  // BOS / CHOCH DETECTION
  // ══════════════════════════════════════════

  _detectStructureBreaks(candles) {
    const result = { bos: null, choch: null, trend: 'neutral' };
    const recent = candles.slice(-60);
    if (recent.length < 20) return result;

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

    const higherHighs = lastHigh.price > prevHigh.price;
    const higherLows = lastLow.price > prevLow.price;
    const lowerHighs = lastHigh.price < prevHigh.price;
    const lowerLows = lastLow.price < prevLow.price;

    if (higherHighs && higherLows) result.trend = 'bullish';
    else if (lowerHighs && lowerLows) result.trend = 'bearish';

    // BOS: only detect if the break is RECENT (within last 3 candles).
    // Keeping this tight avoids firing "stale" BOS signals hours after the break.
    const priceJustBrokeHigh = currentPrice > lastHigh.price &&
      recent.length - 1 - lastHigh.index <= 3;
    const priceJustBrokeLow = currentPrice < lastLow.price &&
      recent.length - 1 - lastLow.index <= 3;

    if (result.trend === 'bullish' && priceJustBrokeHigh) {
      result.bos = { direction: 'bullish', level: lastHigh.price };
    } else if (result.trend === 'bearish' && priceJustBrokeLow) {
      result.bos = { direction: 'bearish', level: lastLow.price };
    }

    if (result.trend === 'bullish' && currentPrice < lastLow.price) {
      result.choch = { direction: 'bearish', level: lastLow.price };
    } else if (result.trend === 'bearish' && currentPrice > lastHigh.price) {
      result.choch = { direction: 'bullish', level: lastHigh.price };
    }

    return result;
  }

  /**
   * Get the latest value from an indicator array.
   */
  latest(arr, offset = 0) {
    if (!arr || arr.length === 0) return null;
    const idx = arr.length - 1 - offset;
    return idx >= 0 ? arr[idx] : null;
  }
}

module.exports = new Indicators();
