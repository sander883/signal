const config = require('../config');
const indicators = require('../indicators');
const logger = require('../logger');

/**
 * Trend Following Strategy (Enhanced)
 *
 * Core: EMA 50/200 trend direction + ADX trend strength
 * Confirmation: MACD momentum + VWAP alignment + Stochastic
 * Filter: Market regime must be trending or weak-trend
 *
 * BUY:  EMA50 > EMA200 + ADX > 20 + MACD bullish + price above VWAP
 * SELL: EMA50 < EMA200 + ADX > 20 + MACD bearish + price below VWAP
 */
function analyze(data) {
  const ind = indicators;
  const { ema50, ema200, macd, rsi, adx, atr, vwap, regime, stoch } = data;

  const result = { signal: null, confidence: 0, strategy: 'Trend Following' };

  if (!ema50.length || !ema200.length || !macd.length || !rsi.length) return result;

  const currentEma50 = ind.latest(ema50);
  const currentEma200 = ind.latest(ema200);
  const prevEma50 = ind.latest(ema50, 1);
  const prevEma200 = ind.latest(ema200, 1);
  const currentMacd = ind.latest(macd);
  const prevMacd = ind.latest(macd, 1);
  const currentRsi = ind.latest(rsi);
  const currentAdx = ind.latest(adx);
  const currentAtr = ind.latest(atr);
  const currentStoch = ind.latest(stoch);

  if (!currentMacd || !prevMacd || currentRsi === null) return result;

  // ── Market Regime Filter ──
  // Trend following works best in trending markets, acceptable in weak-trend
  if (regime && (regime.type === 'ranging' || regime.type === 'volatile')) {
    return result; // Skip — wrong market for this strategy
  }

  // ── ADX Trend Strength ──
  // Require ADX > 20 to confirm a real trend exists
  const adxValue = currentAdx ? currentAdx.adx : 0;
  if (adxValue < 20) return result;

  const macdHist = currentMacd.histogram;
  const prevMacdHist = prevMacd.histogram;

  // Trend direction
  const bullishTrend = currentEma50 > currentEma200;
  const bearishTrend = currentEma50 < currentEma200;

  // Fresh cross detection
  const goldenCross = currentEma50 > currentEma200 && prevEma50 <= prevEma200;
  const deathCross = currentEma50 < currentEma200 && prevEma50 >= prevEma200;

  // MACD momentum (histogram relative to ATR for gold-appropriate scaling)
  const macdThreshold = currentAtr ? currentAtr * 0.02 : 0.5;
  const macdBullish = macdHist > 0 && macdHist > prevMacdHist;
  const macdBearish = macdHist < 0 && macdHist < prevMacdHist;
  const strongMacdBull = macdHist > macdThreshold;
  const strongMacdBear = macdHist < -macdThreshold;

  // VWAP alignment — only reward/punish when VWAP actually exists
  const currentPrice = data.closes[data.closes.length - 1];
  const hasVwap = !!(vwap && vwap.current);
  const priceAboveVwap = hasVwap && currentPrice > vwap.current;
  const priceBelowVwap = hasVwap && currentPrice < vwap.current;

  // ── BUY Signal ──
  if (bullishTrend && macdBullish && currentRsi < config.indicators.rsi.overbought) {
    let confidence = 45;

    // ADX strength bonus
    if (adxValue > 30) confidence += 8;
    else if (adxValue > 25) confidence += 5;

    // Fresh golden cross is strongest
    if (goldenCross) confidence += 18;

    // Strong MACD momentum (ATR-scaled)
    if (strongMacdBull) confidence += 8;

    // MACD line above signal line
    if (currentMacd.MACD > currentMacd.signal) confidence += 5;

    // RSI sweet spot (45-60) — not overextended
    if (currentRsi > 45 && currentRsi < 60) confidence += 7;

    // VWAP confirmation — neutral when VWAP missing (no bonus, no penalty)
    if (hasVwap) {
      if (priceAboveVwap) confidence += 7;
      else confidence -= 5;
    }

    // Stochastic not overbought (room to run)
    if (currentStoch && currentStoch.k < 80) confidence += 3;

    // Regime direction alignment
    if (regime && regime.direction === 'bullish') confidence += 5;

    result.signal = 'BUY';
    result.confidence = Math.min(confidence, 95);
  }

  // ── SELL Signal ──
  if (!result.signal && bearishTrend && macdBearish && currentRsi > config.indicators.rsi.oversold) {
    let confidence = 45;

    if (adxValue > 30) confidence += 8;
    else if (adxValue > 25) confidence += 5;

    if (deathCross) confidence += 18;
    if (strongMacdBear) confidence += 8;
    if (currentMacd.MACD < currentMacd.signal) confidence += 5;
    if (currentRsi > 40 && currentRsi < 55) confidence += 7;

    if (hasVwap) {
      if (priceBelowVwap) confidence += 7;
      else confidence -= 5;
    }

    if (currentStoch && currentStoch.k > 20) confidence += 3;
    if (regime && regime.direction === 'bearish') confidence += 5;

    result.signal = 'SELL';
    result.confidence = Math.min(confidence, 95);
  }

  if (result.signal) {
    logger.info(
      `[Trend Following] ${result.signal} | Conf: ${result.confidence}% | ` +
        `EMA50: ${currentEma50.toFixed(2)} EMA200: ${currentEma200.toFixed(2)} | ` +
        `ADX: ${adxValue.toFixed(1)} | MACD H: ${macdHist.toFixed(4)} | ` +
        `RSI: ${currentRsi.toFixed(1)} | Regime: ${regime ? regime.type : '?'}`
    );
  }

  return result;
}

module.exports = { analyze };
