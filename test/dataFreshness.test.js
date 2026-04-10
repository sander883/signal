const test = require('node:test');
const assert = require('node:assert/strict');
const marketData = require('../src/data');

test('data.getMaxStaleMs: returns 3x the interval', () => {
  assert.equal(marketData.getMaxStaleMs('15min'), 3 * 15 * 60_000);
  assert.equal(marketData.getMaxStaleMs('1h'), 3 * 60 * 60_000);
  assert.equal(marketData.getMaxStaleMs('4h'), 3 * 4 * 60 * 60_000);
});

test('data.getMaxStaleMs: unknown timeframe falls back to 15min default', () => {
  assert.equal(marketData.getMaxStaleMs('7min'), 3 * 15 * 60_000);
});

test('data.getFreshnessStatus: unfetched timeframe is not fresh', () => {
  const status = marketData.getFreshnessStatus('__neverfetched__');
  assert.equal(status.fresh, false);
  assert.equal(status.ageMs, Infinity);
});

test('data.getFreshnessStatus: recent fetch is marked fresh', () => {
  marketData.lastSuccessfulFetch['15min'] = { ts: Date.now(), provider: 'test' };
  const status = marketData.getFreshnessStatus('15min');
  assert.equal(status.fresh, true);
  assert.ok(status.ageMs < 1000);
});

test('data.getFreshnessStatus: old fetch is not fresh', () => {
  marketData.lastSuccessfulFetch['15min'] = { ts: Date.now() - 60 * 60 * 1000, provider: 'test' };
  const status = marketData.getFreshnessStatus('15min');
  assert.equal(status.fresh, false);
});
