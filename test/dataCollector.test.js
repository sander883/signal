const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// dataCollector writes to `${cwd}/data/...` at call time, so chdir to a temp
// dir before requiring it. Keeps real data/ untouched during tests.
const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-dc-'));
process.chdir(TMP);

delete require.cache[require.resolve('../src/dataCollector')];
const dataCollector = require('../src/dataCollector');

test.after(() => {
  process.chdir(ORIGINAL_CWD);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function todayFile(prefix) {
  const date = new Date().toISOString().split('T')[0];
  return path.join(TMP, 'data', `${prefix}-${date}.jsonl`);
}

test('dataCollector.generateId: produces short unique ids', () => {
  const a = dataCollector.generateId();
  const b = dataCollector.generateId();
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9]+-[a-z0-9]+$/);
});

test('dataCollector.logSignal: writes JSONL line to dated file', () => {
  dataCollector.logSignal({
    timeframe: '15min',
    decision: 'sent',
    price: 2345.67,
    strategy: 'trend',
    final_confidence: 72,
  });
  const rows = readJsonl(todayFile('signals'));
  const mine = rows[rows.length - 1];
  assert.equal(mine.decision, 'sent');
  assert.equal(mine.price, 2345.67);
  assert.ok(mine.ts, 'ts should be auto-added');
});

test('dataCollector.logSignal: appends (does not overwrite)', () => {
  const before = readJsonl(todayFile('signals')).length;
  dataCollector.logSignal({ timeframe: '1h', decision: 'no_signal' });
  dataCollector.logSignal({ timeframe: '1h', decision: 'blocked_news', reason: 'NFP' });
  const after = readJsonl(todayFile('signals')).length;
  assert.equal(after, before + 2);
});

test('dataCollector.logTrade: writes to trades file with MFE/MAE', () => {
  dataCollector.logTrade({
    id: 7,
    signal_id: 'abc-123',
    direction: 'BUY',
    result: 'WIN',
    entry: 2300,
    exit: 2310,
    mfe: 12.5,
    mae: 2.1,
    mfe_r: 2.5,
    mae_r: 0.42,
    pnl: 100,
  });
  const rows = readJsonl(todayFile('trades'));
  const last = rows[rows.length - 1];
  assert.equal(last.signal_id, 'abc-123');
  assert.equal(last.mfe_r, 2.5);
  assert.equal(last.mae_r, 0.42);
});

test('dataCollector.extractFeatures: handles null / missing indicators gracefully', () => {
  const features = dataCollector.extractFeatures({
    ema9: [1.1, 1.2, 1.3],
    rsi: [50, 55, 60],
    atr: [2.0],
    bb: [{ upper: 105, middle: 100, lower: 95 }],
    macd: [{ MACD: 0.5, signal: 0.3, histogram: 0.2 }],
    regime: { type: 'trending', strength: 75, direction: 'up' },
  }, { session: 'london' });

  assert.equal(features.ema9, 1.3);
  assert.equal(features.rsi, 60);
  assert.equal(features.bb_upper, 105);
  assert.equal(features.macd_hist, 0.2);
  assert.equal(features.regime_type, 'trending');
  assert.equal(features.session, 'london');
});

test('dataCollector.extractFeatures: returns extras only when indData is null', () => {
  const features = dataCollector.extractFeatures(null, { session: 'asian' });
  assert.equal(features.session, 'asian');
  assert.equal(features.ema9, undefined);
});

test('dataCollector.compactCandles: trims to last N with short keys', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({
    time: `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`,
    open: 2000 + i,
    high: 2005 + i,
    low: 1995 + i,
    close: 2003 + i,
    volume: 100,
  }));
  const compact = dataCollector.compactCandles(candles, 10);
  assert.equal(compact.length, 10);
  assert.equal(compact[0].c, 2093); // close of 90th candle
  assert.equal(compact[9].c, 2102); // close of 99th candle
  // Short keys
  assert.ok('o' in compact[0]);
  assert.ok('h' in compact[0]);
  assert.ok(!('open' in compact[0]));
});

test('dataCollector.logSignal: respects logBlocks=false for blocked decisions', () => {
  dataCollector.logBlocks = false;
  const before = readJsonl(todayFile('signals')).length;
  dataCollector.logSignal({ timeframe: '15min', decision: 'blocked_news' });
  dataCollector.logSignal({ timeframe: '15min', decision: 'sent' });
  const after = readJsonl(todayFile('signals')).length;
  // Only 'sent' should be written
  assert.equal(after, before + 1);
  dataCollector.logBlocks = true; // restore
});

test('dataCollector.logSignal: writes nothing when disabled', () => {
  dataCollector.enabled = false;
  const before = readJsonl(todayFile('signals')).length;
  dataCollector.logSignal({ timeframe: '15min', decision: 'sent' });
  const after = readJsonl(todayFile('signals')).length;
  assert.equal(after, before);
  dataCollector.enabled = true; // restore
});
