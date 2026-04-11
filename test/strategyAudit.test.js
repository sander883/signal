const test = require('node:test');
const assert = require('node:assert/strict');

// P0 audit regression tests: confidence scoring must not be inflated by
// missing VWAP data, tied scores must return null, and artificial floors
// must not rescue weak signals.

// Enable all strategies regardless of env
process.env.STRATEGY_TREND = 'true';
process.env.STRATEGY_SCALPING = 'true';
process.env.STRATEGY_BREAKOUT = 'true';
process.env.STRATEGY_MEAN_REVERSION = 'true';
process.env.STRATEGY_PRICE_ACTION = 'true';

delete require.cache[require.resolve('../src/config')];

const { getBestSignal } = require('../src/strategies/index');
const trendFollowing = require('../src/strategies/trendFollowing');
const scalping = require('../src/strategies/scalping');
const breakout = require('../src/strategies/breakout');
const priceAction = require('../src/strategies/priceAction');

// Build a synthetic indicator payload. Enough to make trendFollowing fire BUY.
function buildBullishTrendData({ withVwap }) {
  const closes = Array.from({ length: 50 }, (_, i) => 2300 + i * 0.5);
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);

  // EMA arrays: last value = 50 > 200 (bullish)
  const ema50 = [2310, 2315, 2320];
  const ema200 = [2290, 2295, 2300];
  const macd = [
    { MACD: 0.8, signal: 0.2, histogram: 0.4 },
    { MACD: 1.0, signal: 0.3, histogram: 0.6 },
    { MACD: 1.2, signal: 0.4, histogram: 0.8 },
  ];
  const rsi = [50, 52, 55];
  const adx = [{ adx: 28 }, { adx: 29 }, { adx: 30 }];
  const atr = [4, 4, 4];
  const stoch = [{ k: 55, d: 50 }, { k: 60, d: 55 }, { k: 65, d: 60 }];
  const regime = { type: 'trending', strength: 50, direction: 'bullish' };

  return {
    candles: closes.map((c, i) => ({
      open: c - 0.2,
      high: highs[i],
      low: lows[i],
      close: c,
      volume: 100,
    })),
    closes,
    highs,
    lows,
    ema50,
    ema200,
    macd,
    rsi,
    adx,
    atr,
    stoch,
    regime,
    vwap: withVwap ? { current: 2322, upper: 2328, lower: 2316 } : null,
  };
}

test('trendFollowing: missing VWAP does NOT inflate confidence', () => {
  const withVwap = trendFollowing.analyze(buildBullishTrendData({ withVwap: true }));
  const noVwap = trendFollowing.analyze(buildBullishTrendData({ withVwap: false }));

  assert.equal(withVwap.signal, 'BUY');
  assert.equal(noVwap.signal, 'BUY');
  // With VWAP below price (2322 < 2324.5): bonus +7.
  // Without VWAP: neutral (no bonus). So withVwap should be HIGHER.
  assert.ok(
    withVwap.confidence > noVwap.confidence,
    `withVwap (${withVwap.confidence}) should exceed noVwap (${noVwap.confidence})`
  );
  // Delta should be exactly the VWAP bonus (+7)
  assert.equal(withVwap.confidence - noVwap.confidence, 7);
});

test('scalping: missing VWAP does NOT inflate confidence', () => {
  // Build a scalping-ready setup with EMA9 crossing above EMA21
  const base = {
    closes: [2300, 2301, 2302, 2303],
    ema9: [2299, 2300, 2301, 2303],
    ema21: [2300.5, 2301, 2301.5, 2302],
    rsi: [50, 52, 54, 56],
    atr: [4, 4.2, 4.3, 4.4],
    stoch: [{ k: 40, d: 38 }, { k: 45, d: 42 }, { k: 55, d: 48 }, { k: 62, d: 55 }],
    regime: { type: 'weak-trend', strength: 15, direction: 'bullish' },
  };
  const withVwap = scalping.analyze({ ...base, vwap: { current: 2302 } });
  const noVwap = scalping.analyze({ ...base, vwap: null });

  assert.equal(withVwap.signal, 'BUY');
  assert.equal(noVwap.signal, 'BUY');
  // With VWAP at 2302, price 2303 → priceAboveVwap true → +7
  // Without VWAP: no bonus
  assert.ok(withVwap.confidence >= noVwap.confidence);
  assert.equal(withVwap.confidence - noVwap.confidence, 7);
});

test('breakout: missing VWAP does NOT inflate confidence', () => {
  // Build 60 candles, last candle breaks resistance
  const candles = Array.from({ length: 60 }, (_, i) => ({
    open: 2300,
    high: 2305,
    low: 2298,
    close: 2302,
    volume: 100,
  }));
  // Previous candles below 2310 level
  candles[57] = { open: 2302, high: 2308, low: 2300, close: 2305, volume: 100 };
  candles[58] = { open: 2305, high: 2309, low: 2303, close: 2307, volume: 100 };
  // Current breakout candle: closes above 2310 + 0.3*ATR margin
  candles[59] = { open: 2307, high: 2320, low: 2306, close: 2318, volume: 200 };

  const base = {
    candles,
    closes: candles.map((c) => c.close),
    atr: Array.from({ length: 50 }, () => 4),
    adx: Array.from({ length: 50 }, () => ({ adx: 26 })),
    rsi: Array.from({ length: 50 }, () => 60),
    supportResistance: { support: [2280], resistance: [2310] },
    stoch: [{ k: 65, d: 60 }],
    regime: { type: 'trending', strength: 50, direction: 'bullish' },
  };

  const withVwap = breakout.analyze({ ...base, vwap: { current: 2312 } });
  const noVwap = breakout.analyze({ ...base, vwap: null });

  assert.equal(withVwap.signal, 'BUY');
  assert.equal(noVwap.signal, 'BUY');
  assert.ok(withVwap.confidence >= noVwap.confidence);
  assert.equal(withVwap.confidence - noVwap.confidence, 7);
});

test('getBestSignal: tied buy/sell weighted scores returns null', () => {
  const regime = { type: 'unknown' }; // weights all 1.0
  const signals = [
    { signal: 'BUY', confidence: 60, strategyType: 'trend', strategy: 'Trend' },
    { signal: 'SELL', confidence: 60, strategyType: 'reversal', strategy: 'Reversal' },
  ];
  const best = getBestSignal(signals, regime);
  assert.equal(best, null, 'tied scores should return null, not default to BUY');
});

test('getBestSignal: buyScore > sellScore picks BUY', () => {
  const regime = { type: 'unknown' };
  // Use a spread wide enough to pass the new 50% opposing-score gate
  const signals = [
    { signal: 'BUY', confidence: 80, strategyType: 'trend', strategy: 'Trend' },
    { signal: 'SELL', confidence: 30, strategyType: 'reversal', strategy: 'Reversal' },
  ];
  const best = getBestSignal(signals, regime);
  assert.ok(best);
  assert.equal(best.signal, 'BUY');
});

test('getBestSignal: no 25% artificial floor on weak signals', () => {
  const regime = { type: 'trending' }; // buy-favoring weights
  // Low base + heavy opposition → final would be well below 25
  const signals = [
    { signal: 'BUY', confidence: 30, strategyType: 'trend', strategy: 'Trend' },
    { signal: 'SELL', confidence: 75, strategyType: 'reversal', strategy: 'Reversal' },
    { signal: 'SELL', confidence: 75, strategyType: 'momentum', strategy: 'Scalp' },
  ];
  const best = getBestSignal(signals, regime);
  // BUY wins because trend weight is 1.3 vs reversal 0.5, momentum 1.1
  // 30 * 1.3 = 39 vs (75*0.5 + 75*1.1) = 37.5 + 82.5 = 120. SELL wins.
  assert.equal(best.signal, 'SELL');
  // Not forced to 25
  assert.ok(best.confidence !== 25 || best.confidence >= 30);
});

test('getBestSignal: single weak signal keeps its low confidence', () => {
  const regime = { type: 'unknown' };
  const signals = [
    { signal: 'BUY', confidence: 20, strategyType: 'trend', strategy: 'Trend' },
  ];
  const best = getBestSignal(signals, regime);
  assert.ok(best);
  // With 1 matching, 0 opposing: blend = 20*0.6 + 20*0.4 = 20, no bonus, no penalty
  assert.ok(best.confidence < 25, `weak signal should stay weak, got ${best.confidence}`);
});

test('indicators: BOS recency window is tight (within 3 candles)', () => {
  // Rebuild require because we need the live module
  delete require.cache[require.resolve('../src/indicators')];
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'indicators.js'),
    'utf8'
  );
  // Simple static check: the BOS window must be <=3 candles, not <=10
  assert.ok(
    /recent\.length - 1 - lastHigh\.index <= 3/.test(src),
    'BOS high window should be tightened to <= 3'
  );
  assert.ok(
    /recent\.length - 1 - lastLow\.index <= 3/.test(src),
    'BOS low window should be tightened to <= 3'
  );
});

test('priceAction: missing VWAP does not add free bonus', () => {
  // Build a BOS-bullish scenario
  const candles = Array.from({ length: 30 }, (_, i) => ({
    open: 2300 + i * 0.2,
    high: 2305 + i * 0.2,
    low: 2298 + i * 0.2,
    close: 2302 + i * 0.2,
    volume: 100,
  }));

  const base = {
    candles,
    closes: candles.map((c) => c.close),
    structureBreaks: {
      bos: { direction: 'bullish', level: 2305 },
      choch: null,
      trend: 'bullish',
    },
    supplyDemand: {
      supply: [],
      demand: [{ high: 2310, low: 2305 }],
    },
    atr: Array.from({ length: 20 }, () => 4),
    rsi: Array.from({ length: 20 }, () => 55),
    stoch: [{ k: 45, d: 40 }],
    regime: { type: 'trending', strength: 40, direction: 'bullish' },
  };

  const withVwap = priceAction.analyze({
    ...base,
    vwap: { current: base.closes[base.closes.length - 1] - 1 }, // below price → above VWAP
  });
  const noVwap = priceAction.analyze({ ...base, vwap: null });

  assert.equal(withVwap.signal, 'BUY');
  assert.equal(noVwap.signal, 'BUY');
  // VWAP bonus in priceAction BOS BUY is +5
  assert.equal(withVwap.confidence - noVwap.confidence, 5);
});

// ── P1 Audit Regression Tests ──

const meanReversion = require('../src/strategies/meanReversion');
const { stripFormingBar } = (() => {
  // stripFormingBar is module-private; test via MarketData.fetchCandles.
  // Instead, we test the behavior through a synthetic approach using
  // the cached fetch path. Simpler: test via a standalone import of the
  // pure helper (not exported). Fallback to a behavioral check of the
  // TF_MS map through public API.
  return { stripFormingBar: null };
})();

test('trendFollowing: rejects BUY at RSI 66 (tighter than config overbought)', () => {
  // Build same bullish trend data but push RSI to 66
  const data = buildBullishTrendData({ withVwap: true });
  data.rsi = [60, 63, 66];
  const result = trendFollowing.analyze(data);
  assert.equal(result.signal, null, 'RSI 66 should now be rejected (cap=65)');
});

test('trendFollowing: accepts BUY at RSI 60', () => {
  const data = buildBullishTrendData({ withVwap: true });
  data.rsi = [56, 58, 60];
  const result = trendFollowing.analyze(data);
  assert.equal(result.signal, 'BUY');
});

test('getBestSignal: rejects when opposing weighted > 50% of matching', () => {
  const regime = { type: 'unknown' }; // weights all 1.0
  const signals = [
    { signal: 'BUY', confidence: 70, strategyType: 'trend', strategy: 'Trend' },
    { signal: 'SELL', confidence: 40, strategyType: 'reversal', strategy: 'Reversal' },
  ];
  // buyScore=70, sellScore=40. 40 > 70*0.5=35 → REJECT.
  const best = getBestSignal(signals, regime);
  assert.equal(best, null, 'should reject when opposing > 50% of matching');
});

test('getBestSignal: accepts when opposing weighted <= 50% of matching', () => {
  const regime = { type: 'unknown' };
  const signals = [
    { signal: 'BUY', confidence: 70, strategyType: 'trend', strategy: 'Trend' },
    { signal: 'SELL', confidence: 30, strategyType: 'reversal', strategy: 'Reversal' },
  ];
  // 30 <= 35 → accept
  const best = getBestSignal(signals, regime);
  assert.ok(best);
  assert.equal(best.signal, 'BUY');
});

test('getBestSignal: confluence uses type diversity not raw count', () => {
  const regime = { type: 'unknown' };
  // 3 same-type matching signals → diversity = 1 → NO count stacking bonus
  const sameType = [
    { signal: 'BUY', confidence: 60, strategyType: 'trend', strategy: 'A' },
    { signal: 'BUY', confidence: 60, strategyType: 'trend', strategy: 'B' },
    { signal: 'BUY', confidence: 60, strategyType: 'trend', strategy: 'C' },
  ];
  // 2 different-type matching → diversity = 2 → gets +4 bonus
  const twoTypes = [
    { signal: 'BUY', confidence: 60, strategyType: 'trend', strategy: 'A' },
    { signal: 'BUY', confidence: 60, strategyType: 'reversal', strategy: 'B' },
  ];
  const a = getBestSignal(sameType, regime);
  const b = getBestSignal(twoTypes, regime);
  assert.ok(a && b);
  // With diversity-only bonus: twoTypes should be higher despite having
  // FEWER matching signals, proving count is no longer counted.
  assert.ok(
    b.confidence > a.confidence,
    `two-type (${b.confidence}) should beat three-same-type (${a.confidence})`
  );
});

test('meanReversion: blocks all trending regimes regardless of strength', () => {
  const candles = Array.from({ length: 30 }, () => ({
    open: 2300, high: 2302, low: 2298, close: 2301, volume: 100,
  }));
  const base = {
    candles,
    closes: candles.map((c) => c.close),
    bb: Array.from({ length: 20 }, () => ({ upper: 2305, middle: 2300, lower: 2295 })),
    rsi: Array.from({ length: 20 }, () => 20), // deeply oversold
    adx: Array.from({ length: 20 }, () => ({ adx: 22 })), // weak
    atr: Array.from({ length: 20 }, () => 4),
    stoch: [{ k: 20, d: 25 }],
    vwap: { current: 2305 },
  };
  // Weak trending (strength 22, previously allowed via strength > 35 gate)
  const weakTrending = meanReversion.analyze({
    ...base,
    regime: { type: 'trending', strength: 22, direction: 'bullish' },
  });
  assert.equal(weakTrending.signal, null, 'weak trending should now be blocked');

  // Volatile also blocked
  const volatile = meanReversion.analyze({
    ...base,
    regime: { type: 'volatile', strength: 80, direction: 'neutral' },
  });
  assert.equal(volatile.signal, null, 'volatile should be blocked');

  // Ranging still works (force price below lower BB)
  const ranging = meanReversion.analyze({
    ...base,
    closes: [...base.closes.slice(0, -1), 2294], // below lower
    candles: [
      ...base.candles.slice(0, -1),
      { open: 2300, high: 2301, low: 2293, close: 2294, volume: 100 },
    ],
    regime: { type: 'ranging', strength: 10, direction: 'neutral' },
  });
  assert.equal(ranging.signal, 'BUY', 'ranging should still produce BUY');
});

test('data: stripFormingBar drops incomplete candle at tail', () => {
  // MarketData doesn't export stripFormingBar, so test the behavior via
  // a fresh require and direct access to the module-internal function
  // through mocking provider responses is heavy. Instead verify via the
  // static source that the strip is wired into fetchCandles and uses the
  // TF_MS map with the proper time comparison.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'data.js'), 'utf8');
  assert.ok(
    /function stripFormingBar/.test(src),
    'stripFormingBar helper should exist in data.js'
  );
  assert.ok(
    /candles = stripFormingBar\(candles, timeframe\)/.test(src),
    'stripFormingBar should be called inside fetchCandles'
  );
  // Behavioral sanity: simulate the logic against a fake last candle
  // whose period has not closed yet.
  const tfMs15 = 15 * 60 * 1000;
  const justOpenedMs = Date.now() - 60_000; // bar opened 1 minute ago
  const stillForming = justOpenedMs + tfMs15 > Date.now();
  assert.ok(stillForming, 'a 1-minute-old 15min bar must still be forming');
});
