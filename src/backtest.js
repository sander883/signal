const config = require('./config');
const logger = require('./logger');
const marketData = require('./data');
const indicators = require('./indicators');
const strategies = require('./strategies');
const riskManager = require('./risk');

/**
 * Simple backtesting engine.
 * Runs strategies against historical data and reports performance.
 *
 * Usage: node src/backtest.js
 */

class Backtester {
  constructor() {
    this.trades = [];
    this.balance = 10000;
    this.initialBalance = 10000;
  }

  async run() {
    console.log('\n=== XAUUSD Backtesting Engine ===\n');

    // Fetch maximum historical data
    logger.info('Fetching historical data...');
    const candles = await marketData.fetchCandles(config.primaryTimeframe, 250);

    if (!candles || candles.length < 100) {
      console.log('ERROR: Insufficient data for backtesting. Need at least 100 candles.');
      return;
    }

    console.log(`Loaded ${candles.length} candles\n`);
    console.log(`Timeframe: ${config.primaryTimeframe}`);
    console.log(`Period: ${candles[0].time} to ${candles[candles.length - 1].time}\n`);

    // Walk forward through data, simulating real-time analysis
    const windowSize = 100; // Minimum candles needed for indicators

    for (let i = windowSize; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const indData = indicators.compute(slice);
      const signals = strategies.runAll(indData);
      const bestSignal = strategies.getBestSignal(signals);

      if (!bestSignal || bestSignal.confidence < 50) continue;

      const entryPrice = slice[slice.length - 1].close;
      const riskParams = riskManager.calculate(bestSignal.signal, entryPrice, indData.atr);

      if (!riskParams || !riskManager.validate(riskParams)) continue;

      // Simulate trade outcome using future candles
      const outcome = this._simulateTrade(
        bestSignal.signal,
        entryPrice,
        riskParams.stopLoss,
        riskParams.takeProfit,
        candles.slice(i + 1)
      );

      if (outcome) {
        this.trades.push({
          index: i,
          time: slice[slice.length - 1].time,
          signal: bestSignal.signal,
          strategy: bestSignal.strategy,
          confidence: bestSignal.confidence,
          entry: entryPrice,
          sl: riskParams.stopLoss,
          tp: riskParams.takeProfit,
          ...outcome,
        });

        // Apply P&L
        const riskAmount = this.balance * (config.riskPercent / 100);
        if (outcome.result === 'WIN') {
          this.balance += riskAmount * config.rewardRatio;
        } else {
          this.balance -= riskAmount;
        }

        // Skip forward to avoid overlapping trades
        i += outcome.barsHeld;
      }
    }

    this._printReport();
  }

  /**
   * Simulate a trade forward from entry.
   */
  _simulateTrade(direction, entry, sl, tp, futureCandles) {
    if (!futureCandles.length) return null;

    for (let i = 0; i < Math.min(futureCandles.length, 50); i++) {
      const candle = futureCandles[i];

      if (direction === 'BUY') {
        // Check SL hit (low touches SL)
        if (candle.low <= sl) {
          return { result: 'LOSS', exitPrice: sl, barsHeld: i + 1 };
        }
        // Check TP hit (high touches TP)
        if (candle.high >= tp) {
          return { result: 'WIN', exitPrice: tp, barsHeld: i + 1 };
        }
      } else {
        // SELL
        if (candle.high >= sl) {
          return { result: 'LOSS', exitPrice: sl, barsHeld: i + 1 };
        }
        if (candle.low <= tp) {
          return { result: 'WIN', exitPrice: tp, barsHeld: i + 1 };
        }
      }
    }

    // Timeout - close at last price
    const lastPrice = futureCandles[Math.min(futureCandles.length, 50) - 1].close;
    const pnl = direction === 'BUY' ? lastPrice - entry : entry - lastPrice;
    return {
      result: pnl > 0 ? 'WIN' : 'LOSS',
      exitPrice: lastPrice,
      barsHeld: Math.min(futureCandles.length, 50),
    };
  }

  _printReport() {
    console.log('\n' + '='.repeat(50));
    console.log('          BACKTEST RESULTS');
    console.log('='.repeat(50));

    if (this.trades.length === 0) {
      console.log('\nNo trades were generated during the backtest period.');
      return;
    }

    const wins = this.trades.filter((t) => t.result === 'WIN');
    const losses = this.trades.filter((t) => t.result === 'LOSS');
    const winRate = ((wins.length / this.trades.length) * 100).toFixed(1);
    const pnlPercent = (((this.balance - this.initialBalance) / this.initialBalance) * 100).toFixed(2);

    console.log(`\nTotal Trades:     ${this.trades.length}`);
    console.log(`Wins:             ${wins.length}`);
    console.log(`Losses:           ${losses.length}`);
    console.log(`Win Rate:         ${winRate}%`);
    console.log(`\nInitial Balance:  $${this.initialBalance.toFixed(2)}`);
    console.log(`Final Balance:    $${this.balance.toFixed(2)}`);
    console.log(`P&L:              ${pnlPercent}%`);

    // Strategy breakdown
    const stratStats = {};
    for (const trade of this.trades) {
      if (!stratStats[trade.strategy]) {
        stratStats[trade.strategy] = { wins: 0, losses: 0 };
      }
      if (trade.result === 'WIN') stratStats[trade.strategy].wins++;
      else stratStats[trade.strategy].losses++;
    }

    console.log('\n--- Strategy Breakdown ---');
    for (const [name, s] of Object.entries(stratStats)) {
      const total = s.wins + s.losses;
      const wr = ((s.wins / total) * 100).toFixed(1);
      console.log(`  ${name}: ${total} trades | ${s.wins}W / ${s.losses}L | WR: ${wr}%`);
    }

    // Avg confidence of winners vs losers
    const avgWinConf =
      wins.length > 0
        ? (wins.reduce((s, t) => s + t.confidence, 0) / wins.length).toFixed(1)
        : 'N/A';
    const avgLossConf =
      losses.length > 0
        ? (losses.reduce((s, t) => s + t.confidence, 0) / losses.length).toFixed(1)
        : 'N/A';

    console.log(`\nAvg Confidence (Winners): ${avgWinConf}%`);
    console.log(`Avg Confidence (Losers):  ${avgLossConf}%`);

    // Max drawdown
    let peak = this.initialBalance;
    let maxDD = 0;
    let runningBal = this.initialBalance;
    for (const trade of this.trades) {
      const riskAmount = this.initialBalance * (config.riskPercent / 100);
      if (trade.result === 'WIN') runningBal += riskAmount * config.rewardRatio;
      else runningBal -= riskAmount;

      if (runningBal > peak) peak = runningBal;
      const dd = ((peak - runningBal) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    console.log(`Max Drawdown:     ${maxDD.toFixed(2)}%`);
    console.log('\n' + '='.repeat(50));

    // Print last 10 trades
    console.log('\n--- Last 10 Trades ---');
    const recent = this.trades.slice(-10);
    for (const t of recent) {
      const emoji = t.result === 'WIN' ? '✅' : '❌';
      console.log(
        `  ${emoji} ${t.signal} | ${t.strategy} | Entry: ${t.entry.toFixed(2)} | ` +
          `Exit: ${t.exitPrice.toFixed(2)} | Bars: ${t.barsHeld} | Conf: ${t.confidence}%`
      );
    }
  }
}

// Run backtest
new Backtester().run().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
