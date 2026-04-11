const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Mean Reversion Strategy (Enhanced)
 *
 * Core: Bollinger Band extremes + RSI divergence
 * Confirmation: VWAP as mean target, Stochastic reversal signal
 * Filter: ADX < 30 (ranging), regime-aware RSI thresholds
 *
 * BUY:  Price at/below lower BB + RSI oversold + Stoch turning up + VWAP above (target)
 * SELL: Price at/above upper BB + RSI overbought + Stoch turning down + VWAP below (target)
 */
function analyze(data) {
  const ind = indicators;
  const { candles, closes, bb, rsi, adx, atr, vwap, stoch, regime } = data;

  const result = { signal: null, confidence: 0, strategy: 'Mean Reversion' };

  if (!bb.length || !rsi.length) return result;

  const currentPrice = closes[closes.length - 1];
  const currentBB = ind.latest(bb);
  const prevBB = ind.latest(bb, 1);
  const currentRsi = ind.latest(rsi);
  const prevRsi = ind.latest(rsi, 1);
  const currentAdx = ind.latest(adx);
  const currStoch = ind.latest(stoch);
  const prevStoch = ind.latest(stoch, 1);
  const currentAtr = ind.latest(atr);

  if (!currentBB || !prevBB || currentRsi === null) return result;

  const { upper, middle, lower } = currentBB;
  const bbWidth = (upper - lower) / middle;

  // ── Market Regime Filter ──
  // Mean reversion works best in ranging markets, bad in strong trends
  if (regime && regime.type === 'trending' && regime.strength > 35) {
    return result; // Strong trend = don't fade it
  }

  // ADX filter: prefer ranging (ADX < 30), but adapt thresholds
  const adxValue = currentAdx ? currentAdx.adx : 0;
  const isRanging = adxValue < 30;
  if (!isRanging) return result;

  // ── Regime-Aware RSI Thresholds ──
  // In volatile markets, use wider RSI thresholds (more extreme needed)
  // In calm ranging, narrower thresholds are ok
  let rsiOversold = 35;
  let rsiOverbought = 65;
  if (regime && regime.type === 'volatile') {
    rsiOversold = 25;
    rsiOverbought = 75;
  } else if (regime && regime.type === 'ranging' && regime.strength > 10) {
    rsiOversold = 38;
    rsiOverbought = 62;
  }

  // VWAP data
  const hasVwap = vwap && vwap.current;
  const vwapAbovePrice = hasVwap ? vwap.current > currentPrice : false;
  const vwapBelowPrice = hasVwap ? vwap.current < currentPrice : false;

  // Stochastic reversal signals
  const stochTurningUp = currStoch && prevStoch ? currStoch.k > prevStoch.k && currStoch.k < 30 : false;
  const stochTurningDown = currStoch && prevStoch ? currStoch.k < prevStoch.k && currStoch.k > 70 : false;
  const stochBullCross = currStoch && currStoch.k > currStoch.d && prevStoch && prevStoch.k <= prevStoch.d;
  const stochBearCross = currStoch && currStoch.k < currStoch.d && prevStoch && prevStoch.k >= prevStoch.d;

  // ── BUY: Price at Lower Band ──
  if (currentPrice <= lower && currentRsi < rsiOversold) {
    let confidence = 45;

    // Price below lower band = stronger signal
    if (currentPrice < lower) confidence += 8;

    // RSI deeply oversold
    if (currentRsi < 25) confidence += 12;
    else if (currentRsi < 30) confidence += 8;
    else confidence += 4;

    // RSI bullish divergence (price lower but RSI higher)
    if (prevRsi !== null && currentRsi > prevRsi) confidence += 8;

    // Stochastic turning up from oversold — reversal confirmation
    if (stochTurningUp) confidence += 7;
    if (stochBullCross) confidence += 5;

    // VWAP above price = natural mean-reversion target above
    if (vwapAbovePrice) confidence += 7;

    // BB squeeze (narrow bands = potential expansion toward mean)
    if (bbWidth < 0.02) confidence += 4;

    // Candle rejection (long lower wick = buying pressure)
    const candle = candles[candles.length - 1];
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const body = Math.abs(candle.close - candle.open);
    if (body > 0 && lowerWick > body * 1.5) confidence += 7;

    // Distance from middle band (potential profit target)
    if (currentAtr && (middle - currentPrice) > currentAtr * 0.5) confidence += 3;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 90);

    logger.info(
      `[Mean Reversion] BUY - Price ${currentPrice.toFixed(2)} at lower BB ${lower.toFixed(2)} | ` +
        `RSI: ${currentRsi.toFixed(1)} (threshold: ${rsiOversold}) | ` +
        `Stoch K: ${currStoch ? currStoch.k.toFixed(1) : 'N/A'} | ` +
        `BB Width: ${(bbWidth * 100).toFixed(2)}% | Regime: ${regime ? regime.type : '?'}`
    );
  }

  // ── SELL: Price at Upper Band ──
  if (!result.signal && currentPrice >= upper && currentRsi > rsiOverbought) {
    let confidence = 45;

    if (currentPrice > upper) confidence += 8;

    if (currentRsi > 75) confidence += 12;
    else if (currentRsi > 70) confidence += 8;
    else confidence += 4;

    if (prevRsi !== null && currentRsi < prevRsi) confidence += 8;

    if (stochTurningDown) confidence += 7;
    if (stochBearCross) confidence += 5;

    if (vwapBelowPrice) confidence += 7;

    if (bbWidth < 0.02) confidence += 4;

    const candle = candles[candles.length - 1];
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const body = Math.abs(candle.close - candle.open);
    if (body > 0 && upperWick > body * 1.5) confidence += 7;

    if (currentAtr && (currentPrice - middle) > currentAtr * 0.5) confidence += 3;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 90);

    logger.info(
      `[Mean Reversion] SELL - Price ${currentPrice.toFixed(2)} at upper BB ${upper.toFixed(2)} | ` +
        `RSI: ${currentRsi.toFixed(1)} (threshold: ${rsiOverbought}) | ` +
        `Stoch K: ${currStoch ? currStoch.k.toFixed(1) : 'N/A'} | ` +
        `BB Width: ${(bbWidth * 100).toFixed(2)}% | Regime: ${regime ? regime.type : '?'}`
    );
  }

  return result;
}

module.exports = { analyze };
