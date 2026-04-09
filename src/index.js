const cron = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const marketData = require('./data');
const indicators = require('./indicators');
const strategies = require('./strategies');
const newsFilter = require('./filters/newsFilter');
const sessionFilter = require('./filters/sessionFilter');
const riskManager = require('./risk');
const telegram = require('./telegram');

// Performance tracking
const stats = {
  totalSignals: 0,
  buySignals: 0,
  sellSignals: 0,
  newsBlocked: 0,
  sessionBlocked: 0,
  errors: 0,
  confidenceSum: 0,
  strategyCounts: {},
  startTime: new Date(),
};

/**
 * Main analysis cycle.
 * This runs on every cron tick and performs the full signal pipeline:
 * 1. Check session filter
 * 2. Check news filter
 * 3. Fetch market data
 * 4. Compute indicators
 * 5. Run strategies
 * 6. Validate and calculate risk
 * 7. Send Telegram alert
 */
async function runAnalysis() {
  const cycleStart = Date.now();
  logger.info('='.repeat(60));
  logger.info(`Analysis cycle started | ${new Date().toUTCString()}`);
  logger.info(`Session: ${sessionFilter.getCurrentSession()}`);

  try {
    // ── STEP 1: Session Filter ──
    const session = sessionFilter.check();
    if (!session.allowed) {
      stats.sessionBlocked++;
      logger.info(`[SESSION BLOCK] ${session.reason}`);
      return;
    }
    logger.info(`[Session] ${session.reason}`);

    // ── STEP 2: News Filter (MANDATORY) ──
    const news = await newsFilter.check();
    if (news.blocked) {
      stats.newsBlocked++;
      logger.warn(`[NEWS BLOCK ACTIVE] ${news.reason}`);
      await telegram.sendNewsBlock(news.reason);
      return;
    }
    if (news.nextEvent) {
      logger.info(`[News] Next event: ${news.nextEvent.title}`);
    }

    // ── STEP 3: Fetch Market Data ──
    logger.info(`Fetching ${config.symbol} data [${config.primaryTimeframe}]...`);
    const candles = await marketData.fetchCandles(config.primaryTimeframe, 250);
    if (!candles || candles.length < 50) {
      logger.error('Insufficient candle data for analysis');
      stats.errors++;
      return;
    }

    // Also fetch secondary timeframe for trend alignment
    let secondaryCandles = null;
    try {
      secondaryCandles = await marketData.fetchCandles(config.secondaryTimeframe, 100);
    } catch (err) {
      logger.warn(`Secondary timeframe fetch failed: ${err.message}`);
    }

    // ── STEP 4: Compute Indicators ──
    const indData = indicators.compute(candles);
    let secondaryTrend = 'neutral';

    if (secondaryCandles && secondaryCandles.length > 50) {
      const secInd = indicators.compute(secondaryCandles);
      const secEma50 = indicators.latest(secInd.ema50);
      const secEma200 = indicators.latest(secInd.ema200);
      if (secEma50 && secEma200) {
        secondaryTrend = secEma50 > secEma200 ? 'bullish' : 'bearish';
      }
    }

    const currentPrice = candles[candles.length - 1].close;
    logger.info(`Current price: ${currentPrice.toFixed(2)} | H1 trend: ${secondaryTrend}`);

    // ── STEP 5: Run All Strategies ──
    const signals = strategies.runAll(indData);
    const bestSignal = strategies.getBestSignal(signals);

    if (!bestSignal) {
      logger.info('No valid signals generated this cycle');
      logger.info(`Cycle completed in ${Date.now() - cycleStart}ms`);
      return;
    }

    // ── STEP 6: Trend Alignment Check ──
    if (secondaryTrend !== 'neutral') {
      const aligned =
        (bestSignal.signal === 'BUY' && secondaryTrend === 'bullish') ||
        (bestSignal.signal === 'SELL' && secondaryTrend === 'bearish');

      if (!aligned) {
        // Don't block, but reduce confidence
        bestSignal.confidence = Math.max(bestSignal.confidence - 15, 25);
        logger.warn(
          `[Trend Alignment] Signal ${bestSignal.signal} conflicts with H1 trend (${secondaryTrend}). ` +
            `Confidence reduced to ${bestSignal.confidence}%`
        );
      } else {
        bestSignal.confidence = Math.min(bestSignal.confidence + 5, 98);
        logger.info(`[Trend Alignment] Confirmed - H1 trend is ${secondaryTrend}`);
      }
    }

    // Minimum confidence threshold
    if (bestSignal.confidence < 50) {
      logger.info(
        `Signal confidence too low (${bestSignal.confidence}%), skipping`
      );
      return;
    }

    // ── STEP 7: Risk Management ──
    const riskParams = riskManager.calculate(
      bestSignal.signal,
      currentPrice,
      indData.atr
    );

    if (!riskParams || !riskManager.validate(riskParams)) {
      logger.warn('Risk validation failed, signal discarded');
      stats.errors++;
      return;
    }

    // ── STEP 8: Send Alert ──
    await telegram.sendSignal(bestSignal, riskParams, config.primaryTimeframe);

    // Update stats
    stats.totalSignals++;
    if (bestSignal.signal === 'BUY') stats.buySignals++;
    else stats.sellSignals++;
    stats.confidenceSum += bestSignal.confidence;
    stats.strategyCounts[bestSignal.strategy] =
      (stats.strategyCounts[bestSignal.strategy] || 0) + 1;

    logger.info(
      `✓ Signal sent: ${bestSignal.signal} @ ${currentPrice.toFixed(2)} | ` +
        `Strategy: ${bestSignal.strategy} | Confidence: ${bestSignal.confidence}%`
    );
  } catch (err) {
    stats.errors++;
    logger.error(`Analysis cycle error: ${err.message}`, { stack: err.stack });
    await telegram.sendMessage(`⚠️ Bot error: ${err.message}`).catch(() => {});
  }

  logger.info(`Cycle completed in ${Date.now() - cycleStart}ms`);
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
      avgConfidence: avgConf,
      topStrategy: topStrategy ? `${topStrategy[0]} (${topStrategy[1]})` : 'N/A',
    });

    // Reset daily stats
    stats.totalSignals = 0;
    stats.buySignals = 0;
    stats.sellSignals = 0;
    stats.newsBlocked = 0;
    stats.sessionBlocked = 0;
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

  // Initialize Telegram
  telegram.init();

  // Pre-fetch news events
  logger.info('Loading economic calendar...');
  await newsFilter.fetchEvents();
  logger.info(newsFilter.getSummary());

  // Send startup notification
  await telegram.sendStartup();

  // Schedule main analysis
  logger.info(`Scheduling analysis: ${config.cronSchedule}`);
  cron.schedule(config.cronSchedule, runAnalysis);

  // Schedule daily summary
  scheduleDailySummary();

  // Run initial analysis
  logger.info('Running initial analysis...');
  await runAnalysis();

  logger.info('Bot is running. Waiting for next scheduled cycle...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  process.exit(0);
});

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
