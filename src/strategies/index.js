const config = require('../config');
const trendFollowing = require('./trendFollowing');
const scalping = require('./scalping');
const breakout = require('./breakout');
const meanReversion = require('./meanReversion');
const priceAction = require('./priceAction');
const logger = require('../logger');

const strategyMap = {
  trend: { module: trendFollowing, name: 'Trend Following', type: 'trend' },
  scalping: { module: scalping, name: 'Scalping', type: 'momentum' },
  breakout: { module: breakout, name: 'Breakout', type: 'trend' },
  meanReversion: { module: meanReversion, name: 'Mean Reversion', type: 'reversal' },
  priceAction: { module: priceAction, name: 'Price Action (SMC)', type: 'structure' },
};

// Strategy weights by market regime
// Higher weight = more trusted in that regime
const regimeWeights = {
  trending: { trend: 1.3, momentum: 1.1, structure: 1.0, reversal: 0.5 },
  'weak-trend': { trend: 1.1, momentum: 1.0, structure: 1.1, reversal: 0.7 },
  ranging: { trend: 0.5, momentum: 0.8, structure: 0.9, reversal: 1.3 },
  volatile: { trend: 0.7, momentum: 0.6, structure: 1.0, reversal: 1.0 },
  unknown: { trend: 1.0, momentum: 1.0, structure: 1.0, reversal: 1.0 },
};

/**
 * Run all enabled strategies against the computed indicator data.
 * Returns an array of signals sorted by confidence (highest first).
 */
function runAll(indicatorData) {
  const signals = [];

  for (const [key, { module: strat, name, type }] of Object.entries(strategyMap)) {
    if (!config.strategies[key]) {
      logger.debug(`Strategy ${name} is disabled, skipping`);
      continue;
    }

    try {
      const result = strat.analyze(indicatorData);
      if (result.signal) {
        result.strategyType = type;
        signals.push(result);
      }
    } catch (err) {
      logger.error(`Strategy ${name} error: ${err.message}`);
    }
  }

  // Sort by confidence descending
  signals.sort((a, b) => b.confidence - a.confidence);

  logger.info(`Strategies executed: ${signals.length} signal(s) generated`);
  return signals;
}

/**
 * Enhanced confluence scoring with regime-weighted confidence.
 *
 * Instead of simple count-based bonuses:
 * 1. Weight each signal by its strategy type's relevance to current regime
 * 2. Use confidence-weighted voting for direction
 * 3. Penalize mixed signals more intelligently
 */
function getBestSignal(signals, regime) {
  if (signals.length === 0) return null;

  const regimeType = regime && regime.type ? regime.type : 'unknown';
  const regimeDir = regime && regime.direction ? regime.direction : 'neutral';
  const weights = regimeWeights[regimeType] || regimeWeights.unknown;

  // Counter-trend filter: remove signals opposing the regime direction.
  // Data shows 28% of trending-regime signals fire against trend → all lose.
  if (regimeDir !== 'neutral') {
    signals = signals.filter((s) => {
      if (regimeDir === 'bullish' && s.signal === 'SELL') return false;
      if (regimeDir === 'bearish' && s.signal === 'BUY') return false;
      return true;
    });
    if (signals.length === 0) return null;
  }

  // Compute weighted confidence for each signal
  const weighted = signals.map((s) => {
    const w = weights[s.strategyType] || 1.0;
    return { ...s, weightedConf: s.confidence * w };
  });

  // Weighted vote: sum weighted confidence by direction
  const buyScore = weighted
    .filter((s) => s.signal === 'BUY')
    .reduce((sum, s) => sum + s.weightedConf, 0);
  const sellScore = weighted
    .filter((s) => s.signal === 'SELL')
    .reduce((sum, s) => sum + s.weightedConf, 0);

  // Tied scores = indecisive market, refuse to force a direction.
  if (buyScore === sellScore) {
    logger.info(`[Confluence] Tied buy/sell score (${buyScore.toFixed(1)}) — no signal`);
    return null;
  }
  const direction = buyScore > sellScore ? 'BUY' : 'SELL';
  const matching = weighted.filter((s) => s.signal === direction);
  const opposing = weighted.filter((s) => s.signal !== direction);

  if (matching.length === 0) return null;

  // ── Aggressive conflict rejection ──
  // If opposing weighted score is more than 50% of matching score, the
  // market is too split to call. Refuse to force a signal.
  const matchingScore = direction === 'BUY' ? buyScore : sellScore;
  const opposingScore = direction === 'BUY' ? sellScore : buyScore;
  if (opposingScore > matchingScore * 0.5) {
    logger.info(
      `[Confluence] Rejected: opposing score ${opposingScore.toFixed(1)} > 50% of ` +
        `matching ${matchingScore.toFixed(1)} — market too split`
    );
    return null;
  }

  // Sort matching by weighted confidence
  matching.sort((a, b) => b.weightedConf - a.weightedConf);
  const best = { ...matching[0] };

  // ── Confluence Scoring ──
  // Weighted average confidence of agreeing strategies
  const totalWeight = matching.reduce((s, m) => s + (weights[m.strategyType] || 1), 0);
  const avgWeightedConf = matching.reduce((s, m) => {
    const w = weights[m.strategyType] || 1;
    return s + m.confidence * w;
  }, 0) / totalWeight;

  // Blend: 60% best signal, 40% weighted average (rewards confluence).
  // This is already a confluence-reward mechanism — do NOT stack count
  // bonuses on top. Instead we use ONE consolidated diversity bonus below
  // which rewards agreement across DIFFERENT strategy types (a genuine
  // independent confirmation) rather than merely "more signals from the
  // same family" (e.g. trend+breakout often fire together and are not
  // independent).
  let finalConfidence = Math.round(best.confidence * 0.6 + avgWeightedConf * 0.4);

  // Consolidated bonus: reward only TYPE DIVERSITY, not raw count.
  // This avoids double-counting correlated strategies.
  const uniqueTypes = new Set(matching.map((s) => s.strategyType));
  if (uniqueTypes.size >= 3) finalConfidence += 8;
  else if (uniqueTypes.size >= 2) finalConfidence += 4;

  // Mild residual opposing penalty (kept for borderline cases that survive
  // the 50% rejection gate above).
  if (opposing.length > 0) {
    const maxOpposingConf = Math.max(...opposing.map((o) => o.weightedConf));
    const penalty = Math.round(maxOpposingConf * 0.1);
    finalConfidence -= Math.min(penalty, 10);
  }

  // Clamp to valid range. No artificial floor — weak signals should stay weak
  // so downstream gates can reject them honestly.
  best.confidence = Math.min(Math.max(finalConfidence, 0), 98);
  best.confluence = matching.length;
  best.allStrategies = matching.map((s) => s.strategy).join(', ');
  best.regimeWeight = weights[best.strategyType] || 1;

  logger.info(
    `[Confluence] ${direction} x${matching.length} vs ${opposing.length} opposing | ` +
      `Types: ${uniqueTypes.size} | Regime: ${regimeType} (weight: ${best.regimeWeight.toFixed(1)}) | ` +
      `Final confidence: ${best.confidence}%`
  );

  return best;
}

module.exports = { runAll, getBestSignal };
