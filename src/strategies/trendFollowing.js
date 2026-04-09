const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Trend Following Strategy
 * - EMA 50/200 golden/death cross for trend direction
 * - MACD histogram for momentum confirmation
 * - RSI for overbought/oversold filter
 *
 * BUY:  EMA50 > EMA200, MACD histogram > 0 and rising, RSI < 70
 * SELL: EMA50 < EMA200, MACD histogram < 0 and falling, RSI > 30
 */
function analyze(data) {
  const ind = indicators;
  const { ema50, ema200, macd, rsi } = data;

  const result = { signal: null, confidence: 0, strategy: 'Trend Following' };

  // Need enough data
  if (!ema50.length || !ema200.length || !macd.length || !rsi.length) {
    return result;
  }

  const currentEma50 = ind.latest(ema50);
  const currentEma200 = ind.latest(ema200);
  const prevEma50 = ind.latest(ema50, 1);
  const prevEma200 = ind.latest(ema200, 1);

  const currentMacd = ind.latest(macd);
  const prevMacd = ind.latest(macd, 1);

  const currentRsi = ind.latest(rsi);

  if (!currentMacd || !prevMacd || currentRsi === null) return result;

  const macdHist = currentMacd.histogram;
  const prevMacdHist = prevMacd.histogram;

  // Trend direction
  const bullishTrend = currentEma50 > currentEma200;
  const bearishTrend = currentEma50 < currentEma200;

  // Fresh cross detection
  const goldenCross = currentEma50 > currentEma200 && prevEma50 <= prevEma200;
  const deathCross = currentEma50 < currentEma200 && prevEma50 >= prevEma200;

  // MACD momentum
  const macdBullish = macdHist > 0 && macdHist > prevMacdHist;
  const macdBearish = macdHist < 0 && macdHist < prevMacdHist;

  // BUY signal
  if (bullishTrend && macdBullish && currentRsi < config.indicators.rsi.overbought) {
    let confidence = 50;

    // Fresh golden cross is strongest
    if (goldenCross) confidence += 20;

    // Strong MACD momentum
    if (macdHist > 0.5) confidence += 10;

    // RSI sweet spot (40-60)
    if (currentRsi > 40 && currentRsi < 60) confidence += 10;

    // MACD line above signal line
    if (currentMacd.MACD > currentMacd.signal) confidence += 10;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 95);
  }

  // SELL signal
  if (bearishTrend && macdBearish && currentRsi > config.indicators.rsi.oversold) {
    let confidence = 50;

    if (deathCross) confidence += 20;
    if (macdHist < -0.5) confidence += 10;
    if (currentRsi > 40 && currentRsi < 60) confidence += 10;
    if (currentMacd.MACD < currentMacd.signal) confidence += 10;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 95);
  }

  if (result.signal) {
    logger.info(
      `[Trend Following] ${result.signal} signal | Confidence: ${result.confidence}% | ` +
        `EMA50: ${currentEma50.toFixed(2)} | EMA200: ${currentEma200.toFixed(2)} | ` +
        `MACD Hist: ${macdHist.toFixed(4)} | RSI: ${currentRsi.toFixed(1)}`
    );
  }

  return result;
}

module.exports = { analyze };
