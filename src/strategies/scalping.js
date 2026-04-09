const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Scalping Strategy
 * - Fast EMA 9/21 crossover for quick entries
 * - RSI for momentum confirmation
 * - Best on M15 timeframe
 *
 * BUY:  EMA9 crosses above EMA21, RSI > 50 and < 70
 * SELL: EMA9 crosses below EMA21, RSI < 50 and > 30
 */
function analyze(data) {
  const ind = indicators;
  const { ema9, ema21, rsi, atr } = data;

  const result = { signal: null, confidence: 0, strategy: 'Scalping' };

  if (!ema9.length || !ema21.length || !rsi.length) return result;

  const currEma9 = ind.latest(ema9);
  const currEma21 = ind.latest(ema21);
  const prevEma9 = ind.latest(ema9, 1);
  const prevEma21 = ind.latest(ema21, 1);
  const currRsi = ind.latest(rsi);
  const prevRsi = ind.latest(rsi, 1);

  if (currEma9 === null || prevEma9 === null || currRsi === null || prevRsi === null) {
    return result;
  }

  // EMA crossover detection
  const bullishCross = prevEma9 <= prevEma21 && currEma9 > currEma21;
  const bearishCross = prevEma9 >= prevEma21 && currEma9 < currEma21;

  // RSI momentum
  const rsiRising = currRsi > prevRsi;
  const rsiFalling = currRsi < prevRsi;

  // BUY
  if (bullishCross && currRsi > 50 && currRsi < 70) {
    let confidence = 55;

    if (rsiRising) confidence += 10;
    // Strong crossover (wide separation)
    const separation = ((currEma9 - currEma21) / currEma21) * 100;
    if (separation > 0.05) confidence += 10;
    if (currRsi > 55 && currRsi < 65) confidence += 10;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 90);
  }

  // SELL
  if (bearishCross && currRsi < 50 && currRsi > 30) {
    let confidence = 55;

    if (rsiFalling) confidence += 10;
    const separation = ((currEma21 - currEma9) / currEma9) * 100;
    if (separation > 0.05) confidence += 10;
    if (currRsi > 35 && currRsi < 45) confidence += 10;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 90);
  }

  if (result.signal) {
    logger.info(
      `[Scalping] ${result.signal} signal | Confidence: ${result.confidence}% | ` +
        `EMA9: ${currEma9.toFixed(2)} | EMA21: ${currEma21.toFixed(2)} | RSI: ${currRsi.toFixed(1)}`
    );
  }

  return result;
}

module.exports = { analyze };
