const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Price Action Strategy (Smart Money Concepts)
 * - Break of Structure (BOS): continuation in trend direction
 * - Change of Character (CHOCH): reversal signal
 * - Supply/Demand zones as entry areas
 * - Candlestick pattern confirmation
 *
 * BUY:  Bullish BOS or Bullish CHOCH + price at demand zone
 * SELL: Bearish BOS or Bearish CHOCH + price at supply zone
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, structureBreaks, supplyDemand, atr, rsi } = data;

  const result = { signal: null, confidence: 0, strategy: 'Price Action (SMC)' };

  if (!candles.length || !structureBreaks) return result;

  const currentPrice = closes[closes.length - 1];
  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const currentAtr = ind.latest(atr);
  const currentRsi = ind.latest(rsi);

  const { bos, choch, trend } = structureBreaks;
  const { supply, demand } = supplyDemand;

  // Check if price is in a demand zone
  const inDemandZone = demand.some(
    (zone) => currentPrice >= zone.low - (currentAtr || 0) * 0.5 && currentPrice <= zone.high + (currentAtr || 0) * 0.5
  );

  // Check if price is in a supply zone
  const inSupplyZone = supply.some(
    (zone) => currentPrice >= zone.low - (currentAtr || 0) * 0.5 && currentPrice <= zone.high + (currentAtr || 0) * 0.5
  );

  // Candlestick patterns
  const patterns = _detectCandlePatterns(candles);

  // === BUY SIGNALS ===

  // Bullish BOS + demand zone
  if (bos && bos.direction === 'bullish') {
    let confidence = 55;

    if (inDemandZone) confidence += 15;
    if (patterns.bullishEngulfing) confidence += 10;
    if (patterns.hammer) confidence += 8;
    if (currentRsi && currentRsi > 40 && currentRsi < 65) confidence += 5;
    if (trend === 'bullish') confidence += 7;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 93);

    logger.info(
      `[Price Action] BUY - Bullish BOS at ${bos.level.toFixed(2)} | ` +
        `Demand zone: ${inDemandZone} | Confidence: ${result.confidence}%`
    );
  }

  // Bullish CHOCH (bearish trend reversing to bullish)
  if (!result.signal && choch && choch.direction === 'bullish') {
    let confidence = 50;

    if (inDemandZone) confidence += 20;
    if (patterns.bullishEngulfing) confidence += 10;
    if (patterns.hammer) confidence += 8;
    if (patterns.morningStar) confidence += 10;
    if (currentRsi && currentRsi < 40) confidence += 5;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 93);

    logger.info(
      `[Price Action] BUY - Bullish CHOCH at ${choch.level.toFixed(2)} | ` +
        `Demand zone: ${inDemandZone} | Confidence: ${result.confidence}%`
    );
  }

  // === SELL SIGNALS ===

  // Bearish BOS + supply zone
  if (!result.signal && bos && bos.direction === 'bearish') {
    let confidence = 55;

    if (inSupplyZone) confidence += 15;
    if (patterns.bearishEngulfing) confidence += 10;
    if (patterns.shootingStar) confidence += 8;
    if (currentRsi && currentRsi > 35 && currentRsi < 60) confidence += 5;
    if (trend === 'bearish') confidence += 7;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 93);

    logger.info(
      `[Price Action] SELL - Bearish BOS at ${bos.level.toFixed(2)} | ` +
        `Supply zone: ${inSupplyZone} | Confidence: ${result.confidence}%`
    );
  }

  // Bearish CHOCH
  if (!result.signal && choch && choch.direction === 'bearish') {
    let confidence = 50;

    if (inSupplyZone) confidence += 20;
    if (patterns.bearishEngulfing) confidence += 10;
    if (patterns.shootingStar) confidence += 8;
    if (patterns.eveningStar) confidence += 10;
    if (currentRsi && currentRsi > 60) confidence += 5;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 93);

    logger.info(
      `[Price Action] SELL - Bearish CHOCH at ${choch.level.toFixed(2)} | ` +
        `Supply zone: ${inSupplyZone} | Confidence: ${result.confidence}%`
    );
  }

  return result;
}

/**
 * Detect common candlestick patterns on the last few candles.
 */
function _detectCandlePatterns(candles) {
  const patterns = {
    bullishEngulfing: false,
    bearishEngulfing: false,
    hammer: false,
    shootingStar: false,
    morningStar: false,
    eveningStar: false,
    doji: false,
  };

  if (candles.length < 3) return patterns;

  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const currBody = Math.abs(curr.close - curr.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const currRange = curr.high - curr.low;

  // Bullish Engulfing
  if (
    prev.close < prev.open && // Previous bearish
    curr.close > curr.open && // Current bullish
    curr.open <= prev.close && // Opens at or below prev close
    curr.close >= prev.open // Closes at or above prev open
  ) {
    patterns.bullishEngulfing = true;
  }

  // Bearish Engulfing
  if (
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open
  ) {
    patterns.bearishEngulfing = true;
  }

  // Hammer (bullish reversal)
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  if (lowerWick > currBody * 2 && upperWick < currBody * 0.5 && currRange > 0) {
    patterns.hammer = true;
  }

  // Shooting Star (bearish reversal)
  if (upperWick > currBody * 2 && lowerWick < currBody * 0.5 && currRange > 0) {
    patterns.shootingStar = true;
  }

  // Doji
  if (currBody < currRange * 0.1) {
    patterns.doji = true;
  }

  // Morning Star (3-candle bullish reversal)
  const prev2Body = Math.abs(prev2.close - prev2.open);
  if (
    prev2.close < prev2.open && // First: bearish
    prevBody < prev2Body * 0.3 && // Second: small body (star)
    curr.close > curr.open && // Third: bullish
    curr.close > (prev2.open + prev2.close) / 2 // Closes above midpoint of first
  ) {
    patterns.morningStar = true;
  }

  // Evening Star (3-candle bearish reversal)
  if (
    prev2.close > prev2.open &&
    prevBody < prev2Body * 0.3 &&
    curr.close < curr.open &&
    curr.close < (prev2.open + prev2.close) / 2
  ) {
    patterns.eveningStar = true;
  }

  return patterns;
}

module.exports = { analyze };
