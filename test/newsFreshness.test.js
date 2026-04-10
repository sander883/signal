const test = require('node:test');
const assert = require('node:assert/strict');
const newsFilter = require('../src/filters/newsFilter');

test('newsFilter.getFreshnessStatus: unknown when never fetched', () => {
  newsFilter.lastSuccessfulFetch = 0;
  assert.equal(newsFilter.getFreshnessStatus(), 'unknown');
});

test('newsFilter.getFreshnessStatus: fresh when <30min old', () => {
  newsFilter.lastSuccessfulFetch = Date.now() - 5 * 60 * 1000;
  assert.equal(newsFilter.getFreshnessStatus(), 'fresh');
});

test('newsFilter.getFreshnessStatus: degraded between 30-120min', () => {
  newsFilter.lastSuccessfulFetch = Date.now() - 60 * 60 * 1000;
  assert.equal(newsFilter.getFreshnessStatus(), 'degraded');
});

test('newsFilter.getFreshnessStatus: stale after 120min', () => {
  newsFilter.lastSuccessfulFetch = Date.now() - 3 * 60 * 60 * 1000;
  assert.equal(newsFilter.getFreshnessStatus(), 'stale');
});

test('newsFilter._sortAndNormalize: sorts ascending and drops invalid', () => {
  const input = [
    { title: 'A', time: '2026-01-01T10:00:00Z' },
    { title: 'B', time: '2026-01-01T08:00:00Z' },
    { title: 'C', time: 'not-a-date' },
    { title: 'D', time: '2026-01-01T09:00:00Z' },
  ];
  const sorted = newsFilter._sortAndNormalize(input);
  assert.equal(sorted.length, 3, 'drops unparseable entries');
  assert.equal(sorted[0].title, 'B');
  assert.equal(sorted[1].title, 'D');
  assert.equal(sorted[2].title, 'A');
});
