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
    this.initialBalance = config.risk.accountBalance || 10000;
    this.balance = this.initialBalance;
    this.equityCurve = [this.initialBalance];
    this.lookaheadBars = parseInt(process.env.BACKTEST_LOOKAHEAD_BARS) || 50;
    this.trainSplit = Math.min(0.9, Math.max(0.5, parseFloat(process.env.BACKTEST_TRAIN_SPLIT) || 0.7));
  }

  async run() {
    console.log('\n=== XAUUSD Backtesting Engine ===\n');

    // Fetch historical data
    logger.info('Fetching historical data...');
    const candles = await marketData.fetchCandles(config.primaryTimeframe, 1000);

    if (!candles || candles.length < 100) {
      console.log('ERROR: Insufficient data for backtesting. Need at least 100 candles.');
      return;
    }

    console.log(`Loaded ${candles.length} candles\n`);
    console.log(`Timeframe: ${config.primaryTimeframe}`);
    console.log(`Period: ${candles[0].time} to ${candles[candles.length - 1].time}\n`);

    // Walk forward through data, simulating real-time analysis
    const windowSize = 100; // Minimum candles needed for indicators
    const splitIndex = Math.floor(candles.length * this.trainSplit);

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
        if (outcome.result === 'WIN') this.balance += riskAmount * config.rewardRatio;
        else this.balance -= riskAmount;
        this.equityCurve.push(this.balance);

        // Skip forward to avoid overlapping trades
        i += outcome.barsHeld;
      }
    }

    this._printReport(splitIndex);
  }

  /**
   * Simulate a trade forward from entry.
   * Includes spread and slippage for realistic results.
   */
  _simulateTrade(direction, entry, sl, tp, futureCandles) {
    if (!futureCandles.length) return null;

    // Realistic adjustments
    const spread = config.risk.spreadPoints || 0.30;
    const slippage = 0.10; // typical slippage on gold

    // Adjust entry for spread (buy = ask, sell = bid)
    const realEntry = direction === 'BUY' ? entry + spread : entry - spread;
    // SL slippage makes losses slightly worse
    const realSL = direction === 'BUY' ? sl - slippage : sl + slippage;

    for (let i = 0; i < Math.min(futureCandles.length, this.lookaheadBars); i++) {
      const candle = futureCandles[i];

      if (direction === 'BUY') {
        // Check SL hit first (worst case within candle)
        if (candle.low <= realSL) {
          return { result: 'LOSS', exitPrice: realSL, barsHeld: i + 1 };
        }
        // Check TP hit
        if (candle.high >= tp) {
          return { result: 'WIN', exitPrice: tp, barsHeld: i + 1 };
        }
      } else {
        // SELL
        if (candle.high >= realSL) {
          return { result: 'LOSS', exitPrice: realSL, barsHeld: i + 1 };
        }
        if (candle.low <= tp) {
          return { result: 'WIN', exitPrice: tp, barsHeld: i + 1 };
        }
      }
    }

    // Timeout - close at last price
    const lastPrice = futureCandles[Math.min(futureCandles.length, this.lookaheadBars) - 1].close;
    const pnl = direction === 'BUY' ? lastPrice - entry : entry - lastPrice;
    return {
      result: pnl > 0 ? 'WIN' : 'LOSS',
      exitPrice: lastPrice,
      barsHeld: Math.min(futureCandles.length, this.lookaheadBars),
    };
  }

  _printReport(splitIndex) {
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
    const profitFactor = this._profitFactor();
    const expectancy = this._expectancy();
    const sharpe = this._sharpeLike();
    const sortino = this._sortinoLike();
    const monte = this._monteCarlo(200);

    console.log(`\nTotal Trades:     ${this.trades.length}`);
    console.log(`Wins:             ${wins.length}`);
    console.log(`Losses:           ${losses.length}`);
    console.log(`Win Rate:         ${winRate}%`);
    console.log(`\nInitial Balance:  $${this.initialBalance.toFixed(2)}`);
    console.log(`Final Balance:    $${this.balance.toFixed(2)}`);
    console.log(`P&L:              ${pnlPercent}%`);
    console.log(`Profit Factor:    ${profitFactor.toFixed(2)}`);
    console.log(`Expectancy/trade: $${expectancy.toFixed(2)}`);
    console.log(`Sharpe-like:      ${sharpe.toFixed(2)}`);
    console.log(`Sortino-like:     ${sortino.toFixed(2)}`);
    console.log(`Monte Carlo P50:  ${monte.p50.toFixed(2)}%`);
    console.log(`Monte Carlo P10:  ${monte.p10.toFixed(2)}%`);
    console.log(`Train/Test split: ${(this.trainSplit * 100).toFixed(0)}% / ${(100 - this.trainSplit * 100).toFixed(0)}% (index ${splitIndex})`);

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

  _tradeReturns() {
    const returns = [];
    let bal = this.initialBalance;
    for (const t of this.trades) {
      const riskAmount = bal * (config.riskPercent / 100);
      const pnl = t.result === 'WIN' ? riskAmount * config.rewardRatio : -riskAmount;
      returns.push(pnl / bal);
      bal += pnl;
    }
    return returns;
  }

  _sharpeLike() {
    const r = this._tradeReturns();
    if (r.length < 2) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
    const std = Math.sqrt(variance) || 1e-9;
    return mean / std * Math.sqrt(252);
  }

  _sortinoLike() {
    const r = this._tradeReturns();
    if (r.length < 2) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const downside = r.filter((x) => x < 0);
    if (!downside.length) return mean * Math.sqrt(252);
    const dVar = downside.reduce((s, x) => s + x ** 2, 0) / downside.length;
    const dStd = Math.sqrt(dVar) || 1e-9;
    return mean / dStd * Math.sqrt(252);
  }

  _profitFactor() {
    let grossProfit = 0;
    let grossLoss = 0;
    for (const t of this.trades) {
      const riskAmount = this.initialBalance * (config.riskPercent / 100);
      if (t.result === 'WIN') grossProfit += riskAmount * config.rewardRatio;
      else grossLoss += riskAmount;
    }
    return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  }

  _expectancy() {
    if (!this.trades.length) return 0;
    const winRate = this.trades.filter((t) => t.result === 'WIN').length / this.trades.length;
    const avgWin = this.initialBalance * (config.riskPercent / 100) * config.rewardRatio;
    const avgLoss = this.initialBalance * (config.riskPercent / 100);
    return winRate * avgWin - (1 - winRate) * avgLoss;
  }

  _monteCarlo(runs = 200) {
    if (!this.trades.length) return { p50: 0, p10: 0 };
    const pnls = this.trades.map((t) => (t.result === 'WIN' ? config.rewardRatio : -1));
    const results = [];
    for (let i = 0; i < runs; i++) {
      let bal = this.initialBalance;
      for (let j = 0; j < pnls.length; j++) {
        const pick = pnls[Math.floor(Math.random() * pnls.length)];
        bal += bal * (config.riskPercent / 100) * pick;
      }
      results.push(((bal - this.initialBalance) / this.initialBalance) * 100);
    }
    results.sort((a, b) => a - b);
    const p50 = results[Math.floor(results.length * 0.5)];
    const p10 = results[Math.floor(results.length * 0.1)];
    return { p50, p10 };
  }
}

// Run backtest
new Backtester().run().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
