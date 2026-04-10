const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Price Action Strategy (SMC - Enhanced)
 *
 * Core: Break of Structure (BOS) / Change of Character (CHOCH) + Supply/Demand zones
 * Confirmation: VWAP alignment, ATR-relative candle sizing, market regime
 * Filter: Candlestick patterns must be ATR-significant
 *
 * BUY:  Bullish BOS/CHOCH + demand zone + bullish candle pattern
 * SELL: Bearish BOS/CHOCH + supply zone + bearish candle pattern
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, structureBreaks, supplyDemand, atr, rsi, vwap, regime, stoch } = data;

  const result = { signal: null, confidence: 0, strategy: 'Price Action (SMC)' };

  if (!candles.length || !structureBreaks) return result;

  const currentPrice = closes[closes.length - 1];
  const currentCandle = candles[candles.length - 1];
  const currentAtr = ind.latest(atr);
  const currentRsi = ind.latest(rsi);
  const currStoch = ind.latest(stoch);
  const prevStoch = ind.latest(stoch, 1);

  if (!currentAtr) return result;

  const { bos, choch, trend } = structureBreaks;
  const { supply, demand } = supplyDemand;

  // VWAP
  const hasVwap = vwap && vwap.current;
  const priceAboveVwap = hasVwap ? currentPrice > vwap.current : true;
  const priceBelowVwap = hasVwap ? currentPrice < vwap.current : true;

  // Zone proximity checks (ATR-relative)
  const zoneMargin = currentAtr * 0.5;
  const inDemandZone = demand.some(
    (zone) => currentPrice >= zone.low - zoneMargin && currentPrice <= zone.high + zoneMargin
  );
  const inSupplyZone = supply.some(
    (zone) => currentPrice >= zone.low - zoneMargin && currentPrice <= zone.high + zoneMargin
  );

  // ATR-relative candlestick patterns (only significant candles count)
  const patterns = _detectCandlePatterns(candles, currentAtr);

  // Stochastic signals
  const stochBullish = currStoch && currStoch.k < 40;
  const stochBearish = currStoch && currStoch.k > 60;
  const stochBullCross = currStoch && prevStoch && currStoch.k > currStoch.d && prevStoch.k <= prevStoch.d;
  const stochBearCross = currStoch && prevStoch && currStoch.k < currStoch.d && prevStoch.k >= prevStoch.d;

  // === BUY SIGNALS ===

  // Bullish BOS (trend continuation)
  if (bos && bos.direction === 'bullish') {
    let confidence = 50;

    if (inDemandZone) confidence += 12;
    if (patterns.bullishEngulfing) confidence += 10;
    if (patterns.hammer) confidence += 7;
    if (currentRsi && currentRsi > 40 && currentRsi < 65) confidence += 5;
    if (trend === 'bullish') confidence += 5;
    if (priceAboveVwap) confidence += 5;
    if (stochBullish || stochBullCross) confidence += 4;

    // Regime: BOS in trending market = stronger
    if (regime && (regime.type === 'trending' || regime.type === 'weak-trend')) confidence += 4;
    if (regime && regime.type === 'ranging') confidence -= 5;

    result.signal = 'BUY';
    result.confidence = Math.min(Math.max(confidence, 30), 93);

    logger.info(
      `[Price Action] BUY - Bullish BOS at ${bos.level.toFixed(2)} | ` +
        `Demand: ${inDemandZone} | VWAP: ${priceAboveVwap ? 'above' : 'below'} | ` +
        `Regime: ${regime ? regime.type : '?'} | Conf: ${result.confidence}%`
    );
  }

  // Bullish CHOCH (reversal from bearish)
  if (!result.signal && choch && choch.direction === 'bullish') {
    let confidence = 45; // Lower base — reversals are riskier

    if (inDemandZone) confidence += 15;
    if (patterns.bullishEngulfing) confidence += 10;
    if (patterns.hammer) confidence += 7;
    if (patterns.morningStar) confidence += 10;
    if (currentRsi && currentRsi < 40) confidence += 5; // Oversold reversal
    if (priceAboveVwap) confidence += 5;
    if (stochBullCross) confidence += 5;

    // CHOCH works better in ranging/volatile (actual reversal potential)
    if (regime && regime.type === 'ranging') confidence += 3;
    if (regime && regime.type === 'trending' && regime.direction === 'bearish') confidence -= 5;

    result.signal = 'BUY';
    result.confidence = Math.min(Math.max(confidence, 30), 93);

    logger.info(
      `[Price Action] BUY - Bullish CHOCH at ${choch.level.toFixed(2)} | ` +
        `Demand: ${inDemandZone} | Conf: ${result.confidence}%`
    );
  }

  // === SELL SIGNALS ===

  // Bearish BOS
  if (!result.signal && bos && bos.direction === 'bearish') {
    let confidence = 50;

    if (inSupplyZone) confidence += 12;
    if (patterns.bearishEngulfing) confidence += 10;
    if (patterns.shootingStar) confidence += 7;
    if (currentRsi && currentRsi > 35 && currentRsi < 60) confidence += 5;
    if (trend === 'bearish') confidence += 5;
    if (priceBelowVwap) confidence += 5;
    if (stochBearish || stochBearCross) confidence += 4;

    if (regime && (regime.type === 'trending' || regime.type === 'weak-trend')) confidence += 4;
    if (regime && regime.type === 'ranging') confidence -= 5;

    result.signal = 'SELL';
    result.confidence = Math.min(Math.max(confidence, 30), 93);

    logger.info(
      `[Price Action] SELL - Bearish BOS at ${bos.level.toFixed(2)} | ` +
        `Supply: ${inSupplyZone} | VWAP: ${priceBelowVwap ? 'below' : 'above'} | ` +
        `Regime: ${regime ? regime.type : '?'} | Conf: ${result.confidence}%`
    );
  }

  // Bearish CHOCH
  if (!result.signal && choch && choch.direction === 'bearish') {
    let confidence = 45;

    if (inSupplyZone) confidence += 15;
    if (patterns.bearishEngulfing) confidence += 10;
    if (patterns.shootingStar) confidence += 7;
    if (patterns.eveningStar) confidence += 10;
    if (currentRsi && currentRsi > 60) confidence += 5;
    if (priceBelowVwap) confidence += 5;
    if (stochBearCross) confidence += 5;

    if (regime && regime.type === 'ranging') confidence += 3;
    if (regime && regime.type === 'trending' && regime.direction === 'bullish') confidence -= 5;

    result.signal = 'SELL';
    result.confidence = Math.min(Math.max(confidence, 30), 93);

    logger.info(
      `[Price Action] SELL - Bearish CHOCH at ${choch.level.toFixed(2)} | ` +
        `Supply: ${inSupplyZone} | Conf: ${result.confidence}%`
    );
  }

  return result;
}

/**
 * Detect candlestick patterns with ATR-relative significance check.
 * A pattern only counts if the candle range is at least 30% of ATR.
 */
function _detectCandlePatterns(candles, atr) {
  const patterns = {
    bullishEngulfing: false,
    bearishEngulfing: false,
    hammer: false,
    shootingStar: false,
    morningStar: false,
    eveningStar: false,
    doji: false,
  };

  if (candles.length < 3 || !atr) return patterns;

  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const currBody = Math.abs(curr.close - curr.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const currRange = curr.high - curr.low;

  // ATR significance: candle range must be meaningful
  const isSignificant = currRange > atr * 0.3;
  if (!isSignificant) return patterns;

  // Bullish Engulfing
  if (
    prev.close < prev.open &&
    curr.close > curr.open &&
    curr.open <= prev.close &&
    curr.close >= prev.open &&
    currBody > prevBody
  ) {
    patterns.bullishEngulfing = true;
  }

  // Bearish Engulfing
  if (
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open &&
    currBody > prevBody
  ) {
    patterns.bearishEngulfing = true;
  }

  // Hammer (bullish reversal)
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  if (currBody > 0 && lowerWick > currBody * 2 && upperWick < currBody * 0.5) {
    patterns.hammer = true;
  }

  // Shooting Star (bearish reversal)
  if (currBody > 0 && upperWick > currBody * 2 && lowerWick < currBody * 0.5) {
    patterns.shootingStar = true;
  }

  // Doji
  if (currRange > 0 && currBody < currRange * 0.1) {
    patterns.doji = true;
  }

  // Morning Star (3-candle bullish reversal)
  const prev2Body = Math.abs(prev2.close - prev2.open);
  if (
    prev2.close < prev2.open &&
    prevBody < prev2Body * 0.3 &&
    curr.close > curr.open &&
    curr.close > (prev2.open + prev2.close) / 2
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
