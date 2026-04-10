const cron = require('node-cron');
const config = require('./config');
const { validateOrThrow } = require('./configValidator');
const logger = require('./logger');
const marketData = require('./data');
const indicators = require('./indicators');
const strategies = require('./strategies');
const newsFilter = require('./filters/newsFilter');
const sessionFilter = require('./filters/sessionFilter');
const dxyFilter = require('./filters/dxyFilter');
const riskManager = require('./risk');
const aiAgent = require('./aiAgent');
const telegram = require('./telegram');
const metrics = require('./metrics');
const paperTrader = require('./paperTrader');
const state = require('./state');
const healthServer = require('./healthServer');

// Performance tracking
const stats = {
  totalSignals: 0,
  buySignals: 0,
  sellSignals: 0,
  newsBlocked: 0,
  sessionBlocked: 0,
  aiRejected: 0,
  errors: 0,
  confidenceSum: 0,
  strategyCounts: {},
  startTime: new Date(),
};

// Duplicate signal protection: tracks last signal per timeframe
// This is restored from persistent state at startup
let lastSignalSent = {}; // { "15min": { direction: "BUY", time: Date.now(), price: 2345 } }
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per timeframe

/**
 * Persist mutable runtime state to disk (best-effort, async not needed).
 */
function persistState() {
  state.set('lastSignalSent', lastSignalSent);
  state.set('metricCounters', metrics.counters);
  if (paperTrader.enabled) {
    const snap = paperTrader.snapshot();
    state.set('paperBalance', snap.paperBalance);
    state.set('paperPositions', snap.paperPositions);
    state.set('paperClosed', snap.paperClosed);
  }
  state.save();
}

/**
 * Run analysis for a SINGLE timeframe.
 * Called independently by each timeframe's cron job.
 *
 * @param {string} timeframe - e.g. '15min', '1h'
 */
async function runAnalysisForTimeframe(timeframe) {
  const cycleStart = Date.now();
  metrics.inc('cycles');
  logger.info('='.repeat(60));
  logger.info(`[${timeframe}] Analysis cycle started | ${new Date().toUTCString()}`);
  logger.info(`Session: ${sessionFilter.getCurrentSession()}`);

  try {
    // ── STEP 1: Session Filter ──
    const session = sessionFilter.check();
    if (!session.allowed) {
      stats.sessionBlocked++;
      metrics.inc('sessionBlocked');
      logger.info(`[${timeframe}] [SESSION BLOCK] ${session.reason}`);
      return;
    }
    logger.info(`[${timeframe}] [Session] ${session.reason}`);

    // ── STEP 2: News Filter (MANDATORY) ──
    const news = await newsFilter.check();
    if (news.blocked) {
      stats.newsBlocked++;
      metrics.inc('newsBlocked');
      logger.warn(`[${timeframe}] [NEWS BLOCK ACTIVE] ${news.reason}`);
      await telegram.sendNewsBlock(news.reason);
      return;
    }
    if (news.nextEvent) {
      logger.info(`[${timeframe}] [News] Next event: ${news.nextEvent.title}`);
    }

    // ── STEP 3: Fetch Market Data ──
    logger.info(`[${timeframe}] Fetching ${config.symbol} data...`);
    const candles = await marketData.fetchCandles(timeframe, 250);
    if (!candles || candles.length < 50) {
      logger.error(`[${timeframe}] Insufficient candle data for analysis`);
      stats.errors++;
      return;
    }

    // Update open paper positions using latest candle for this timeframe.
    // Persist immediately when any position closes so balance/history survive restarts.
    if (paperTrader.enabled) {
      const closedNow = paperTrader.updateWithCandle(timeframe, candles[candles.length - 1]);
      if (closedNow && closedNow.length > 0) persistState();
    }

    // Fetch higher timeframe for trend alignment
    // For H1: use H4/Daily as alignment. For M15: use H1.
    const alignmentTF = getAlignmentTimeframe(timeframe);
    let alignmentTrend = 'neutral';

    if (alignmentTF) {
      try {
        const alignCandles = await marketData.fetchCandles(alignmentTF, 100);
        if (alignCandles && alignCandles.length > 50) {
          const alignInd = indicators.compute(alignCandles);
          const aEma50 = indicators.latest(alignInd.ema50);
          const aEma200 = indicators.latest(alignInd.ema200);
          if (aEma50 && aEma200) {
            alignmentTrend = aEma50 > aEma200 ? 'bullish' : 'bearish';
          }
        }
      } catch (err) {
        logger.warn(`[${timeframe}] Alignment TF (${alignmentTF}) fetch failed: ${err.message}`);
      }
    }

    // ── STEP 4: Compute Indicators ──
    const indData = indicators.compute(candles);
    const currentPrice = candles[candles.length - 1].close;
    logger.info(
      `[${timeframe}] Price: ${currentPrice.toFixed(2)} | ` +
        `Alignment (${alignmentTF || 'none'}): ${alignmentTrend}`
    );

    // ── STEP 5: Run All Strategies ──
    const signals = strategies.runAll(indData);
    const bestSignal = strategies.getBestSignal(signals, indData.regime);

    if (!bestSignal) {
      logger.info(`[${timeframe}] No valid signals generated`);
      logger.info(`[${timeframe}] Cycle completed in ${Date.now() - cycleStart}ms`);
      return;
    }

    // Log market regime
    if (indData.regime) {
      logger.info(
        `[${timeframe}] [Regime] ${indData.regime.type} (strength: ${indData.regime.strength}, dir: ${indData.regime.direction})`
      );
    }

    // ── STEP 6: Trend Alignment Check ──
    if (alignmentTrend !== 'neutral') {
      const aligned =
        (bestSignal.signal === 'BUY' && alignmentTrend === 'bullish') ||
        (bestSignal.signal === 'SELL' && alignmentTrend === 'bearish');

      if (!aligned) {
        bestSignal.confidence = Math.max(bestSignal.confidence - 15, 25);
        logger.warn(
          `[${timeframe}] [Trend Alignment] ${bestSignal.signal} conflicts with ${alignmentTF} trend (${alignmentTrend}). ` +
            `Confidence reduced to ${bestSignal.confidence}%`
        );
      } else {
        bestSignal.confidence = Math.min(bestSignal.confidence + 5, 98);
        logger.info(`[${timeframe}] [Trend Alignment] Confirmed - ${alignmentTF} trend is ${alignmentTrend}`);
      }
    }

    // Apply Asian session confidence penalty (lower gold volatility)
    if (session.confPenalty && session.confPenalty > 0) {
      const prevConf = bestSignal.confidence;
      bestSignal.confidence = Math.max(bestSignal.confidence - session.confPenalty, 25);
      logger.info(
        `[${timeframe}] [Asian Session] Confidence ${prevConf}% → ${bestSignal.confidence}% (-${session.confPenalty}%)`
      );
    }

    // Minimum confidence threshold
    if (bestSignal.confidence < 50) {
      logger.info(`[${timeframe}] Signal confidence too low (${bestSignal.confidence}%), skipping`);
      return;
    }

    // ── STEP 6b: DXY Correlation Filter ──
    const dxyResult = await dxyFilter.check(bestSignal.signal);
    if (dxyResult.score !== 0) {
      const prevConf = bestSignal.confidence;
      bestSignal.confidence = Math.min(Math.max(bestSignal.confidence + dxyResult.score, 25), 98);
      logger.info(
        `[${timeframe}] [DXY] ${dxyResult.reason} | Score: ${dxyResult.score > 0 ? '+' : ''}${dxyResult.score} | ` +
          `Confidence: ${prevConf}% → ${bestSignal.confidence}%`
      );

      // If DXY conflict drops confidence below threshold, skip
      if (bestSignal.confidence < 50) {
        logger.info(`[${timeframe}] DXY conflict dropped confidence below 50%, skipping`);
        return;
      }
    }
    bestSignal.dxyTrend = dxyResult.dxyTrend;
    bestSignal.dxyAligned = dxyResult.aligned;

    // ── STEP 7: Risk Management ──
    const riskParams = riskManager.calculate(
      bestSignal.signal,
      currentPrice,
      indData.atr
    );

    if (!riskParams || !riskManager.validate(riskParams, { atrValues: indData.atr })) {
      logger.warn(`[${timeframe}] Risk/quality validation failed, signal discarded`);
      stats.errors++;
      return;
    }

    // ── STEP 8: AI Agent Validation ──
    const aiResult = await aiAgent.validateSignal(bestSignal, riskParams, {
      currentPrice,
      timeframe,
      alignmentTrend,
      session: session.session,
      rsi: indicators.latest(indData.rsi),
      atr: indicators.latest(indData.atr),
      ema50: indicators.latest(indData.ema50),
      ema200: indicators.latest(indData.ema200),
      bbUpper: indicators.latest(indData.bb)?.upper ?? null,
      bbLower: indicators.latest(indData.bb)?.lower ?? null,
      recentCandles: candles.slice(-10),
    });

    if (!aiResult.approved) {
      stats.aiRejected = (stats.aiRejected || 0) + 1;
      metrics.inc('aiRejected');
      logger.warn(
        `[${timeframe}] [AI REJECTED] ${bestSignal.signal} signal — ${aiResult.reason}`
      );
      await telegram.sendAIReject(bestSignal, aiResult, timeframe);
      return;
    }

    // Apply AI adjustments to risk params if provided, then re-validate
    if (aiResult.adjustedSignal) {
      if (aiResult.adjustedSignal.entryPrice) riskParams.entryPrice = aiResult.adjustedSignal.entryPrice;
      if (aiResult.adjustedSignal.stopLoss) riskParams.stopLoss = aiResult.adjustedSignal.stopLoss;
      if (aiResult.adjustedSignal.takeProfit) riskParams.takeProfit = aiResult.adjustedSignal.takeProfit;
      // Recalculate distances after adjustment
      riskParams.slDistance = Math.abs(riskParams.entryPrice - riskParams.stopLoss);
      riskParams.tpDistance = Math.abs(riskParams.takeProfit - riskParams.entryPrice);
      logger.info(`[${timeframe}] [AI] Adjusted levels applied`);

      // Re-validate after AI adjustments
      if (!riskManager.validate(riskParams, { atrValues: indData.atr })) {
        logger.warn(`[${timeframe}] AI-adjusted risk params invalid, discarding`);
        stats.errors++;
        return;
      }
    }

    // ── Duplicate Signal Protection ──
    const lastSig = lastSignalSent[timeframe];
    if (
      lastSig &&
      lastSig.direction === bestSignal.signal &&
      Date.now() - lastSig.time < SIGNAL_COOLDOWN_MS
    ) {
      const minAgo = Math.round((Date.now() - lastSig.time) / 60000);
      logger.info(`[${timeframe}] Duplicate ${bestSignal.signal} signal skipped (sent ${minAgo}min ago)`);
      return;
    }

    // Blend AI confidence into signal
    bestSignal.aiConfidence = aiResult.confidence;
    bestSignal.aiSentiment = aiResult.sentiment;
    bestSignal.aiReason = aiResult.reason;

    // ── STEP 9: Send Alert ──
    await telegram.sendSignal(bestSignal, riskParams, timeframe);
    metrics.inc('signalsSent');

    if (paperTrader.enabled) {
      const openResult = paperTrader.open(bestSignal, riskParams, timeframe);
      if (!openResult.opened) {
        logger.info(`[Paper] Skip open: ${openResult.reason}`);
      }
    }

    // Track for duplicate protection
    lastSignalSent[timeframe] = {
      direction: bestSignal.signal,
      time: Date.now(),
      price: currentPrice,
    };

    // Persist state after each successful signal so a restart keeps cooldowns
    persistState();

    // Update stats
    stats.totalSignals++;
    if (bestSignal.signal === 'BUY') stats.buySignals++;
    else stats.sellSignals++;
    stats.confidenceSum += bestSignal.confidence;
    const statKey = `${bestSignal.strategy} [${timeframe}]`;
    stats.strategyCounts[statKey] = (stats.strategyCounts[statKey] || 0) + 1;

    logger.info(
      `[${timeframe}] ✓ Signal sent: ${bestSignal.signal} @ ${currentPrice.toFixed(2)} | ` +
        `Strategy: ${bestSignal.strategy} | Confidence: ${bestSignal.confidence}% | ` +
        `AI: ${aiResult.confidence}% (${aiResult.sentiment})`
    );
  } catch (err) {
    stats.errors++;
    metrics.inc('errors');
    logger.error(`[${timeframe}] Analysis error: ${err.message}`, { stack: err.stack });
    await telegram.sendMessage(`⚠️ Bot error [${timeframe}]: ${err.message}`).catch(() => {});
  }

  const cycleDuration = Date.now() - cycleStart;
  healthServer.markCycle(cycleDuration);
  logger.info(`[${timeframe}] Cycle completed in ${cycleDuration}ms`);

  const hbEveryMs = config.observability.heartbeatMinutes * 60 * 1000;
  if (Date.now() - metrics.lastHeartbeat >= hbEveryMs) {
    metrics.heartbeat({ paper: paperTrader.stats(), uptimeMin: Math.round((Date.now() - stats.startTime.getTime()) / 60000) });
  }
}

/**
 * Get the higher timeframe used for trend alignment.
 */
function getAlignmentTimeframe(tf) {
  const map = {
    '1min': '15min',
    '5min': '1h',
    '15min': '1h',
    '30min': '4h',
    '1h': '4h',
    '4h': '1day',
  };
  return map[tf] || null;
}

/**
 * Legacy wrapper: run analysis on primary timeframe only.
 */
async function runAnalysis() {
  await runAnalysisForTimeframe(config.primaryTimeframe);
}

/**
 * Send daily summary at 21:00 UTC.
 */
function scheduleDailySummary() {
  cron.schedule('0 21 * * 1-5', async () => {
    const avgConf =
      stats.totalSignals > 0
        ? Math.round(stats.confidenceSum / stats.totalSignals)
        : 0;

    const topStrategy = Object.entries(stats.strategyCounts).sort(
      (a, b) => b[1] - a[1]
    )[0];

    await telegram.sendDailySummary({
      totalSignals: stats.totalSignals,
      buySignals: stats.buySignals,
      sellSignals: stats.sellSignals,
      newsBlocked: stats.newsBlocked,
      sessionBlocked: stats.sessionBlocked,
      aiRejected: stats.aiRejected || 0,
      avgConfidence: avgConf,
      topStrategy: topStrategy ? `${topStrategy[0]} (${topStrategy[1]})` : 'N/A',
    });

    // Reset daily stats
    stats.totalSignals = 0;
    stats.buySignals = 0;
    stats.sellSignals = 0;
    stats.newsBlocked = 0;
    stats.sessionBlocked = 0;
    stats.aiRejected = 0;
    stats.confidenceSum = 0;
    stats.strategyCounts = {};
  });
}

/**
 * Startup sequence.
 */
async function start() {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║     XAUUSD Trading Signal Bot v1.0       ║
  ║     Gold Signal Generator + News Filter  ║
  ╚══════════════════════════════════════════╝
  `);

  // ── Validate config BEFORE touching any external services ──
  validateOrThrow();
  logger.info('[Config] Validated — all required settings present');

  // ── Restore persistent state (cooldowns, metrics, paper positions) ──
  state.load();
  lastSignalSent = state.get('lastSignalSent') || {};
  metrics.restore(state.get('metricCounters'));
  if (paperTrader.enabled) paperTrader.restore(state.data);
  logger.info(
    `[State] Cooldowns restored for timeframes: ${Object.keys(lastSignalSent).join(', ') || 'none'}`
  );

  // Initialize Telegram
  telegram.init();

  // Initialize AI Agent
  aiAgent.init();

  // Pre-fetch news events
  logger.info('Loading economic calendar...');
  await newsFilter.fetchEvents();
  logger.info(newsFilter.getSummary());

  // Start HTTP health/metrics endpoint (opt-in via HEALTH_SERVER_ENABLED)
  healthServer.start();

  // Send startup notification
  await telegram.sendStartup();

  // Schedule analysis for each enabled timeframe
  const timeframes = config.timeframes;
  logger.info(`Active timeframes: ${timeframes.join(', ')}`);

  for (const tf of timeframes) {
    const schedule = config.cronSchedules[tf] || config.cronSchedule;
    logger.info(`Scheduling [${tf}] analysis: ${schedule}`);
    cron.schedule(schedule, () => runAnalysisForTimeframe(tf));
  }

  // Schedule daily summary
  scheduleDailySummary();

  // Run initial analysis on all timeframes
  logger.info('Running initial analysis on all timeframes...');
  for (const tf of timeframes) {
    await runAnalysisForTimeframe(tf);
  }

  logger.info('Bot is running. Waiting for next scheduled cycle...');
}

// Handle graceful shutdown — persist state so cooldowns/metrics/paper survive restarts
function shutdown(signal) {
  logger.info(`Received ${signal}, persisting state and shutting down...`);
  try {
    persistState();
    logger.info('[State] Persisted on shutdown');
  } catch (err) {
    logger.error(`[State] Shutdown persist failed: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// Start the bot
start().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
