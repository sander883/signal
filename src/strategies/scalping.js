const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Scalping Strategy (Enhanced)
 *
 * Core: Fast EMA 9/21 crossover
 * Confirmation: VWAP proximity, Stochastic momentum, ATR volatility check
 * Filter: Needs sufficient volatility (ATR) but not extreme
 *
 * BUY:  EMA9 crosses above EMA21 + RSI 45-70 + price near/above VWAP + stoch rising
 * SELL: EMA9 crosses below EMA21 + RSI 30-55 + price near/below VWAP + stoch falling
 */
function analyze(data) {
  const ind = indicators;
  const { ema9, ema21, rsi, atr, vwap, stoch, regime } = data;

  const result = { signal: null, confidence: 0, strategy: 'Scalping' };

  if (!ema9.length || !ema21.length || !rsi.length || !atr.length) return result;

  const currEma9 = ind.latest(ema9);
  const currEma21 = ind.latest(ema21);
  const prevEma9 = ind.latest(ema9, 1);
  const prevEma21 = ind.latest(ema21, 1);
  const currRsi = ind.latest(rsi);
  const prevRsi = ind.latest(rsi, 1);
  const currAtr = ind.latest(atr);
  const prevAtr = ind.latest(atr, 1);
  const currStoch = ind.latest(stoch);
  const prevStoch = ind.latest(stoch, 1);

  if (currEma9 === null || prevEma9 === null || currRsi === null || prevRsi === null) return result;
  if (!currAtr || !prevAtr) return result;

  // ── ATR Volatility Filter ──
  // Scalping needs movement but not chaos
  // Too low ATR = no profit potential; too high = too risky for scalps
  const atrRatio = currAtr / prevAtr;
  if (atrRatio < 0.5) return result; // Dead market, skip
  if (regime && regime.type === 'volatile' && regime.strength > 70) return result; // Too volatile

  // EMA crossover detection
  const bullishCross = prevEma9 <= prevEma21 && currEma9 > currEma21;
  const bearishCross = prevEma9 >= prevEma21 && currEma9 < currEma21;

  // No crossover = no scalp signal
  if (!bullishCross && !bearishCross) return result;

  // VWAP data
  const currentPrice = data.closes[data.closes.length - 1];
  const hasVwap = vwap && vwap.current;
  const priceAboveVwap = hasVwap ? currentPrice > vwap.current : true;
  const priceBelowVwap = hasVwap ? currentPrice < vwap.current : true;
  // Distance from VWAP (% of price)
  const vwapDistance = hasVwap ? Math.abs(currentPrice - vwap.current) / currentPrice * 100 : 0;

  // Stochastic momentum
  const stochRising = currStoch && prevStoch ? currStoch.k > prevStoch.k : false;
  const stochFalling = currStoch && prevStoch ? currStoch.k < prevStoch.k : false;
  const stochOversold = currStoch ? currStoch.k < 25 : false;
  const stochOverbought = currStoch ? currStoch.k > 75 : false;

  // ── BUY ──
  if (bullishCross && currRsi > 45 && currRsi < 70) {
    let confidence = 50;

    // RSI momentum rising
    if (currRsi > prevRsi) confidence += 7;

    // Strong crossover (separation relative to ATR)
    const separation = currEma9 - currEma21;
    if (separation > currAtr * 0.05) confidence += 8;

    // RSI sweet spot
    if (currRsi > 50 && currRsi < 62) confidence += 5;

    // VWAP: price above or near VWAP supports buying
    if (priceAboveVwap) confidence += 7;
    else if (vwapDistance < 0.05) confidence += 3; // Very close to VWAP, still ok

    // Stochastic confirmation
    if (stochRising) confidence += 5;
    if (stochOversold) confidence += 5; // Crossing up from oversold = strong

    // ATR adequate for scalp profit
    if (atrRatio > 0.8 && atrRatio < 2.0) confidence += 3;

    result.signal = 'BUY';
    result.confidence = Math.min(Math.max(confidence, 30), 90);
  }

  // ── SELL ──
  if (!result.signal && bearishCross && currRsi < 55 && currRsi > 30) {
    let confidence = 50;

    if (currRsi < prevRsi) confidence += 7;

    const separation = currEma21 - currEma9;
    if (separation > currAtr * 0.05) confidence += 8;

    if (currRsi > 38 && currRsi < 50) confidence += 5;

    if (priceBelowVwap) confidence += 7;
    else if (vwapDistance < 0.05) confidence += 3;

    if (stochFalling) confidence += 5;
    if (stochOverbought) confidence += 5;

    if (atrRatio > 0.8 && atrRatio < 2.0) confidence += 3;

    result.signal = 'SELL';
    result.confidence = Math.min(Math.max(confidence, 30), 90);
  }

  if (result.signal) {
    logger.info(
      `[Scalping] ${result.signal} | Conf: ${result.confidence}% | ` +
        `EMA9: ${currEma9.toFixed(2)} EMA21: ${currEma21.toFixed(2)} | ` +
        `RSI: ${currRsi.toFixed(1)} | ATR ratio: ${atrRatio.toFixed(2)} | ` +
        `VWAP: ${hasVwap ? vwap.current.toFixed(2) : 'N/A'} | ` +
        `Stoch K: ${currStoch ? currStoch.k.toFixed(1) : 'N/A'}`
    );
  }

  return result;
}

module.exports = { analyze };
