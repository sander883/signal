const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Breakout Strategy
 * - Identifies support/resistance levels
 * - Waits for price to break through with momentum
 * - Volume/ATR confirmation for valid breakout
 *
 * BUY:  Price breaks above resistance with rising ATR
 * SELL: Price breaks below support with rising ATR
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, atr, adx, supportResistance, rsi } = data;

  const result = { signal: null, confidence: 0, strategy: 'Breakout' };

  if (!candles.length || !atr.length || !supportResistance) return result;

  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const currentPrice = currentCandle.close;
  const currentAtr = ind.latest(atr);
  const prevAtr = ind.latest(atr, 1);
  const currentRsi = ind.latest(rsi);

  if (!currentAtr || !prevAtr) return result;

  const { support, resistance } = supportResistance;

  // Check for resistance breakout (BUY)
  for (const level of resistance) {
    const breakoutMargin = currentAtr * 0.3; // Must break by 30% of ATR
    const wasBelow = prevCandle.close < level;
    const nowAbove = currentPrice > level + breakoutMargin;

    if (wasBelow && nowAbove) {
      let confidence = 50;

      // ATR rising = increasing volatility (confirms breakout)
      if (currentAtr > prevAtr) confidence += 15;

      // Candle body closed above resistance (not just wick)
      if (currentCandle.close > level) confidence += 10;

      // RSI not overbought
      if (currentRsi && currentRsi < 75) confidence += 5;

      // Strong bullish candle
      const bodySize = currentCandle.close - currentCandle.open;
      if (bodySize > 0 && bodySize > currentAtr * 0.5) confidence += 10;

      // ADX showing trend strength
      const currentAdx = ind.latest(adx);
      if (currentAdx && currentAdx.adx > 25) confidence += 10;

      result.signal = 'BUY';
      result.confidence = Math.min(confidence, 92);
      result.breakoutLevel = level;

      logger.info(
        `[Breakout] BUY - Price ${currentPrice.toFixed(2)} broke resistance ${level.toFixed(2)} | ` +
          `ATR: ${currentAtr.toFixed(2)} | Confidence: ${confidence}%`
      );
      break;
    }
  }

  // Check for support breakdown (SELL)
  if (!result.signal) {
    for (const level of support) {
      const breakoutMargin = currentAtr * 0.3;
      const wasAbove = prevCandle.close > level;
      const nowBelow = currentPrice < level - breakoutMargin;

      if (wasAbove && nowBelow) {
        let confidence = 50;

        if (currentAtr > prevAtr) confidence += 15;
        if (currentCandle.close < level) confidence += 10;
        if (currentRsi && currentRsi > 25) confidence += 5;

        const bodySize = currentCandle.open - currentCandle.close;
        if (bodySize > 0 && bodySize > currentAtr * 0.5) confidence += 10;

        const currentAdx = ind.latest(adx);
        if (currentAdx && currentAdx.adx > 25) confidence += 10;

        result.signal = 'SELL';
        result.confidence = Math.min(confidence, 92);
        result.breakoutLevel = level;

        logger.info(
          `[Breakout] SELL - Price ${currentPrice.toFixed(2)} broke support ${level.toFixed(2)} | ` +
            `ATR: ${currentAtr.toFixed(2)} | Confidence: ${confidence}%`
        );
        break;
      }
    }
  }

  return result;
}

module.exports = { analyze };
