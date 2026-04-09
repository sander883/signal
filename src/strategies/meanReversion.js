const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Mean Reversion Strategy (Bollinger Bands)
 * - Price touches/breaks lower BB = potential BUY (oversold)
 * - Price touches/breaks upper BB = potential SELL (overbought)
 * - RSI confirmation required
 * - Avoids strong trends (ADX filter)
 *
 * BUY:  Price near/below lower BB + RSI < 35 + ADX < 30 (ranging)
 * SELL: Price near/above upper BB + RSI > 65 + ADX < 30 (ranging)
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, bb, rsi, adx, atr } = data;

  const result = { signal: null, confidence: 0, strategy: 'Mean Reversion' };

  if (!bb.length || !rsi.length) return result;

  const currentPrice = closes[closes.length - 1];
  const currentBB = ind.latest(bb);
  const prevBB = ind.latest(bb, 1);
  const currentRsi = ind.latest(rsi);
  const prevRsi = ind.latest(rsi, 1);
  const currentAdx = ind.latest(adx);

  if (!currentBB || !prevBB || currentRsi === null) return result;

  const { upper, middle, lower } = currentBB;
  const bbWidth = (upper - lower) / middle; // Bandwidth

  // ADX filter: only trade in ranging markets (avoid strong trends)
  const isRanging = !currentAdx || currentAdx.adx < 30;

  // BUY: Price at lower band, RSI oversold, ranging market
  if (currentPrice <= lower && currentRsi < 35 && isRanging) {
    let confidence = 50;

    // Price below lower band
    if (currentPrice < lower) confidence += 10;

    // RSI deeply oversold
    if (currentRsi < 25) confidence += 15;
    else if (currentRsi < 30) confidence += 10;

    // RSI divergence (price lower but RSI higher than previous)
    if (prevRsi !== null && currentRsi > prevRsi) confidence += 10;

    // BB squeeze (narrow bands = potential expansion)
    if (bbWidth < 0.02) confidence += 5;

    // Candle rejection (long lower wick)
    const candle = candles[candles.length - 1];
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const body = Math.abs(candle.close - candle.open);
    if (lowerWick > body * 1.5) confidence += 10;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 90);

    logger.info(
      `[Mean Reversion] BUY - Price ${currentPrice.toFixed(2)} at lower BB ${lower.toFixed(2)} | ` +
        `RSI: ${currentRsi.toFixed(1)} | BB Width: ${(bbWidth * 100).toFixed(2)}%`
    );
  }

  // SELL: Price at upper band, RSI overbought, ranging market
  if (currentPrice >= upper && currentRsi > 65 && isRanging) {
    let confidence = 50;

    if (currentPrice > upper) confidence += 10;
    if (currentRsi > 75) confidence += 15;
    else if (currentRsi > 70) confidence += 10;

    if (prevRsi !== null && currentRsi < prevRsi) confidence += 10;
    if (bbWidth < 0.02) confidence += 5;

    const candle = candles[candles.length - 1];
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const body = Math.abs(candle.close - candle.open);
    if (upperWick > body * 1.5) confidence += 10;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 90);

    logger.info(
      `[Mean Reversion] SELL - Price ${currentPrice.toFixed(2)} at upper BB ${upper.toFixed(2)} | ` +
        `RSI: ${currentRsi.toFixed(1)} | BB Width: ${(bbWidth * 100).toFixed(2)}%`
    );
  }

  return result;
}

module.exports = { analyze };
