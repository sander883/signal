const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Redirect data/ writes to a temp dir so we don't pollute the real one.
const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-pt-'));
process.chdir(TMP);

// Enable paper trading for this test (config reads env at require-time)
process.env.PAPER_TRADING_ENABLED = 'true';
process.env.PAPER_INITIAL_BALANCE = '10000';
process.env.PAPER_MAX_OPEN_POSITIONS = '5';

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/dataCollector')];
delete require.cache[require.resolve('../src/paperTrader')];
const paperTrader = require('../src/paperTrader');

test.after(() => {
  process.chdir(ORIGINAL_CWD);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

test('paperTrader.open: stores signal_id and initializes mfe/mae at 0', () => {
  const signal = {
    id: 'test-sig-1',
    signal: 'BUY',
    strategy: 'trend',
    confidence: 70,
  };
  const risk = { entryPrice: 2300, stopLoss: 2290, takeProfit: 2320, lots: 0.1, riskAmount: 100, slDistance: 10 };
  const result = paperTrader.open(signal, risk, '15min');
  assert.equal(result.opened, true);
  assert.equal(result.position.signal_id, 'test-sig-1');
  assert.equal(result.position.mfe, 0);
  assert.equal(result.position.mae, 0);
  assert.equal(result.position.slDistance, 10);
});

test('paperTrader: tracks MFE/MAE across non-hitting candles', () => {
  // Clear positions from previous tests
  paperTrader.positions = [];
  const risk = { entryPrice: 2300, stopLoss: 2290, takeProfit: 2320, lots: 0.1, riskAmount: 100, slDistance: 10 };
  paperTrader.open({ id: 's2', signal: 'BUY', strategy: 'trend', confidence: 70 }, risk, '15min');

  // Candle 1: high 2307 (favor=7), low 2297 (adverse=3)
  paperTrader.updateWithCandle('15min', { high: 2307, low: 2297, open: 2300, close: 2305 });
  let pos = paperTrader.positions[0];
  assert.equal(pos.mfe, 7, 'mfe tracks best favorable');
  assert.equal(pos.mae, 3, 'mae tracks worst adverse');

  // Candle 2: high 2305 (favor=5), low 2292 (adverse=8 — new worst)
  paperTrader.updateWithCandle('15min', { high: 2305, low: 2292, open: 2300, close: 2295 });
  pos = paperTrader.positions[0];
  assert.equal(pos.mfe, 7, 'mfe stays at prior high');
  assert.equal(pos.mae, 8, 'mae updates to new worst');

  // Candle 3: high 2315 (favor=15 — new best), low 2310 (adverse stays)
  paperTrader.updateWithCandle('15min', { high: 2315, low: 2310, open: 2311, close: 2314 });
  pos = paperTrader.positions[0];
  assert.equal(pos.mfe, 15);
  assert.equal(pos.mae, 8);
});

test('paperTrader: on WIN close, emits trade record with mfe_r and mae_r', () => {
  paperTrader.positions = [];
  paperTrader.closed = [];
  const risk = { entryPrice: 2300, stopLoss: 2290, takeProfit: 2320, lots: 0.1, riskAmount: 100, slDistance: 10 };
  paperTrader.open({ id: 's3', signal: 'BUY', strategy: 'trend', confidence: 70 }, risk, '15min');

  // First build up excursion (high 2318, low 2293 → mfe=18, mae=7)
  paperTrader.updateWithCandle('15min', { high: 2318, low: 2293, open: 2300, close: 2316 });
  // Then hit the TP (high 2322 ≥ 2320)
  const closed = paperTrader.updateWithCandle('15min', { high: 2322, low: 2315, open: 2316, close: 2320 });

  assert.equal(closed.length, 1, 'one position closed');
  const record = closed[0];
  assert.equal(record.result, 'WIN');
  assert.equal(record.exit, 2320);
  // mfe_r = 22/10 = 2.2 (the final candle hit 2322, which is 22 above entry)
  // mae_r = 7/10 = 0.7
  assert.equal(record.mfe_r, 2.2);
  assert.equal(record.mae_r, 0.7);
  assert.equal(record.signal_id, 's3');
  assert.ok(record.durationMin >= 0);
});

test('paperTrader: SELL direction excursion math', () => {
  paperTrader.positions = [];
  const risk = { entryPrice: 2300, stopLoss: 2310, takeProfit: 2280, lots: 0.1, riskAmount: 100, slDistance: 10 };
  paperTrader.open({ id: 's4', signal: 'SELL', strategy: 'trend', confidence: 70 }, risk, '15min');

  // For SELL: favor = entry - low, adverse = high - entry
  paperTrader.updateWithCandle('15min', { high: 2305, low: 2294, open: 2300, close: 2296 });
  let pos = paperTrader.positions[0];
  assert.equal(pos.mfe, 6, 'SELL favor = 2300 - 2294 = 6');
  assert.equal(pos.mae, 5, 'SELL adverse = 2305 - 2300 = 5');
});

test('paperTrader: trade record is written to data/trades JSONL', () => {
  paperTrader.positions = [];
  const risk = { entryPrice: 2300, stopLoss: 2290, takeProfit: 2320, lots: 0.1, riskAmount: 100, slDistance: 10 };
  paperTrader.open({ id: 'linked-sig', signal: 'BUY', strategy: 'trend', confidence: 70 }, risk, '15min');
  paperTrader.updateWithCandle('15min', { high: 2325, low: 2298, open: 2300, close: 2320 });

  const date = new Date().toISOString().split('T')[0];
  const file = path.join(TMP, 'data', `trades-${date}.jsonl`);
  assert.ok(fs.existsSync(file), 'trades file should exist');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.signal_id, 'linked-sig');
  assert.ok('mfe_r' in last);
  assert.ok('mae_r' in last);
});

test('paperTrader.restore: backfills mfe/mae on positions saved pre-dataset', () => {
  const oldState = {
    paperBalance: 9500,
    paperPositions: [
      // Legacy position without mfe/mae
      {
        id: 99, timeframe: '15min', direction: 'BUY', entry: 2300,
        sl: 2290, tp: 2320, lots: 0.1, riskAmount: 100, openedAt: new Date().toISOString(),
      },
    ],
    paperClosed: [],
  };
  paperTrader.restore(oldState);
  const restored = paperTrader.positions.find((p) => p.id === 99);
  assert.ok(restored);
  assert.equal(restored.mfe, 0);
  assert.equal(restored.mae, 0);
});
