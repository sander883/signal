const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Breakout Strategy (Enhanced)
 *
 * Core: Price breaks S/R with ATR-confirmed momentum
 * Confirmation: Volume/ATR expansion + ADX rising + VWAP alignment
 * Protection: Requires candle close beyond level (not just wick)
 *             + previous candle must NOT have already broken (fresh break)
 *
 * BUY:  Price closes above resistance + ATR expanding + ADX > 20
 * SELL: Price closes below support + ATR expanding + ADX > 20
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, atr, adx, supportResistance, rsi, vwap, regime, stoch } = data;

  const result = { signal: null, confidence: 0, strategy: 'Breakout' };

  if (!candles.length || !atr.length || !supportResistance) return result;

  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const prev2Candle = candles.length > 2 ? candles[candles.length - 3] : null;
  const currentPrice = currentCandle.close;
  const currentAtr = ind.latest(atr);
  const prevAtr = ind.latest(atr, 1);
  const atr5ago = ind.latest(atr, 5);
  const currentRsi = ind.latest(rsi);
  const currentAdx = ind.latest(adx);
  const currStoch = ind.latest(stoch);

  if (!currentAtr || !prevAtr) return result;

  const { support, resistance } = supportResistance;

  // VWAP data
  const hasVwap = vwap && vwap.current;
  const priceAboveVwap = hasVwap ? currentPrice > vwap.current : true;
  const priceBelowVwap = hasVwap ? currentPrice < vwap.current : true;

  // ATR expansion: current ATR should be rising vs recent average
  const atrExpanding = atr5ago ? currentAtr > atr5ago * 1.1 : currentAtr > prevAtr;

  // ADX value
  const adxValue = currentAdx ? currentAdx.adx : 0;

  // ── Check for Resistance Breakout (BUY) ──
  for (const level of resistance) {
    const breakoutMargin = currentAtr * 0.3;

    // Fresh breakout: previous candle was below, current closes above
    const wasBelow = prevCandle.close < level;
    const nowAbove = currentPrice > level + breakoutMargin;

    // Anti-false breakout: prev2 also below (not re-testing an already-broken level)
    const prev2Below = prev2Candle ? prev2Candle.close < level : true;

    if (wasBelow && nowAbove && prev2Below) {
      let confidence = 45;

      // ATR expanding confirms genuine breakout momentum
      if (atrExpanding) confidence += 12;

      // Strong bullish candle body (not just wick)
      const bodySize = currentCandle.close - currentCandle.open;
      if (bodySize > 0 && bodySize > currentAtr * 0.5) confidence += 10;
      else if (bodySize > 0 && bodySize > currentAtr * 0.3) confidence += 5;

      // Candle closed well above level (not marginal)
      const clearance = (currentPrice - level) / currentAtr;
      if (clearance > 0.5) confidence += 5;

      // ADX confirms directional strength
      if (adxValue > 25) confidence += 8;
      else if (adxValue > 20) confidence += 4;

      // RSI not extremely overbought (room to continue)
      if (currentRsi && currentRsi < 75) confidence += 3;
      if (currentRsi && currentRsi > 80) confidence -= 5; // Overextended risk

      // VWAP alignment: breakout above resistance + above VWAP = strong
      if (priceAboveVwap) confidence += 7;

      // Stochastic: if crossing up from mid-zone, momentum is fresh
      if (currStoch && currStoch.k > 50 && currStoch.k < 85) confidence += 3;

      // Regime: breakout works best when market is starting to trend
      if (regime && (regime.type === 'trending' || regime.type === 'weak-trend')) confidence += 3;

      result.signal = 'BUY';
      result.confidence = Math.min(Math.max(confidence, 30), 93);
      result.breakoutLevel = level;

      logger.info(
        `[Breakout] BUY - Price ${currentPrice.toFixed(2)} broke R ${level.toFixed(2)} | ` +
          `ATR: ${currentAtr.toFixed(2)} (expanding: ${atrExpanding}) | ` +
          `ADX: ${adxValue.toFixed(1)} | Conf: ${result.confidence}%`
      );
      break;
    }
  }

  // ── Check for Support Breakdown (SELL) ──
  if (!result.signal) {
    for (const level of support) {
      const breakoutMargin = currentAtr * 0.3;
      const wasAbove = prevCandle.close > level;
      const nowBelow = currentPrice < level - breakoutMargin;
      const prev2Above = prev2Candle ? prev2Candle.close > level : true;

      if (wasAbove && nowBelow && prev2Above) {
        let confidence = 45;

        if (atrExpanding) confidence += 12;

        const bodySize = currentCandle.open - currentCandle.close;
        if (bodySize > 0 && bodySize > currentAtr * 0.5) confidence += 10;
        else if (bodySize > 0 && bodySize > currentAtr * 0.3) confidence += 5;

        const clearance = (level - currentPrice) / currentAtr;
        if (clearance > 0.5) confidence += 5;

        if (adxValue > 25) confidence += 8;
        else if (adxValue > 20) confidence += 4;

        if (currentRsi && currentRsi > 25) confidence += 3;
        if (currentRsi && currentRsi < 20) confidence -= 5;

        if (priceBelowVwap) confidence += 7;

        if (currStoch && currStoch.k < 50 && currStoch.k > 15) confidence += 3;

        if (regime && (regime.type === 'trending' || regime.type === 'weak-trend')) confidence += 3;

        result.signal = 'SELL';
        result.confidence = Math.min(Math.max(confidence, 30), 93);
        result.breakoutLevel = level;

        logger.info(
          `[Breakout] SELL - Price ${currentPrice.toFixed(2)} broke S ${level.toFixed(2)} | ` +
            `ATR: ${currentAtr.toFixed(2)} (expanding: ${atrExpanding}) | ` +
            `ADX: ${adxValue.toFixed(1)} | Conf: ${result.confidence}%`
        );
        break;
      }
    }
  }

  return result;
}

module.exports = { analyze };
