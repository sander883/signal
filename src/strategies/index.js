const config = require('../config');
const trendFollowing = require('./trendFollowing');
const scalping = require('./scalping');
const breakout = require('./breakout');
const meanReversion = require('./meanReversion');
const priceAction = require('./priceAction');
const logger = require('../logger');

const strategyMap = {
  trend: { module: trendFollowing, name: 'Trend Following' },
  scalping: { module: scalping, name: 'Scalping' },
  breakout: { module: breakout, name: 'Breakout' },
  meanReversion: { module: meanReversion, name: 'Mean Reversion' },
  priceAction: { module: priceAction, name: 'Price Action (SMC)' },
};

/**
 * Run all enabled strategies against the computed indicator data.
 * Returns an array of signals sorted by confidence (highest first).
 */
function runAll(indicatorData) {
  const signals = [];

  for (const [key, { module: strat, name }] of Object.entries(strategyMap)) {
    if (!config.strategies[key]) {
      logger.debug(`Strategy ${name} is disabled, skipping`);
      continue;
    }

    try {
      const result = strat.analyze(indicatorData);
      if (result.signal) {
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
 * Check if multiple strategies agree on direction (confluence).
 * Returns the best signal with adjusted confidence, or null.
 */
function getBestSignal(signals) {
  if (signals.length === 0) return null;

  // Count agreement
  const buySignals = signals.filter((s) => s.signal === 'BUY');
  const sellSignals = signals.filter((s) => s.signal === 'SELL');

  let direction, matching;
  if (buySignals.length >= sellSignals.length) {
    direction = 'BUY';
    matching = buySignals;
  } else {
    direction = 'SELL';
    matching = sellSignals;
  }

  if (matching.length === 0) return null;

  // Take highest confidence signal
  const best = { ...matching[0] };

  // Confluence bonus: multiple strategies agree
  if (matching.length >= 3) {
    best.confidence = Math.min(best.confidence + 10, 98);
    best.confluence = matching.length;
  } else if (matching.length >= 2) {
    best.confidence = Math.min(best.confidence + 5, 95);
    best.confluence = matching.length;
  } else {
    best.confluence = 1;
  }

  // Conflicting signals penalty
  const opposing = direction === 'BUY' ? sellSignals : buySignals;
  if (opposing.length > 0) {
    best.confidence = Math.max(best.confidence - opposing.length * 5, 30);
  }

  best.allStrategies = matching.map((s) => s.strategy).join(', ');
  return best;
}

module.exports = { runAll, getBestSignal };
