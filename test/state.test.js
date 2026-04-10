const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// State module reads cwd at require-time to resolve its JSON file path,
// so we chdir into a throwaway temp dir before requiring it.
const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-state-'));
process.chdir(TMP);

// Force a fresh require so STATE_DIR resolves under TMP
delete require.cache[require.resolve('../src/state')];
const state = require('../src/state');

test.after(() => {
  process.chdir(ORIGINAL_CWD);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

test('state: load() on empty dir returns fresh defaults', () => {
  const data = state.load();
  assert.equal(data.version, 1);
  assert.deepEqual(data.lastSignalSent, {});
  assert.ok(Array.isArray(data.paperPositions));
});

test('state: set / save / reload round-trip preserves data', () => {
  state.set('lastSignalSent', { '15min': { direction: 'BUY', time: 1000, price: 2345 } });
  state.set('metricCounters', { cycles: 42, signalsSent: 7 });
  state.save();

  // File should now exist
  const stateFile = path.join(TMP, 'state', 'bot-state.json');
  assert.ok(fs.existsSync(stateFile), 'state file should exist after save');

  // Re-read by loading a brand new instance via fresh require
  delete require.cache[require.resolve('../src/state')];
  const fresh = require('../src/state');
  fresh.load();
  assert.equal(fresh.get('lastSignalSent')['15min'].direction, 'BUY');
  assert.equal(fresh.get('metricCounters').cycles, 42);
});

test('state: save() caps paperClosed to last 100 entries', () => {
  const bigList = Array.from({ length: 200 }, (_, i) => ({ id: i, result: 'WIN', pnl: 1 }));
  state.set('paperClosed', bigList);
  state.save();
  assert.equal(state.get('paperClosed').length, 100);
  // Should keep the LAST 100 (ids 100-199)
  assert.equal(state.get('paperClosed')[0].id, 100);
  assert.equal(state.get('paperClosed')[99].id, 199);
});
