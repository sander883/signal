const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../src/risk');

test('risk.validate: rejects when spread eats >15% of SL distance', () => {
  const params = risk.calculate('BUY', 2300, Array.from({ length: 20 }, () => 3.5), {
    accountBalance: 10000,
    riskPercent: 1,
  });
  // Override spread to be absurdly wide vs the SL distance
  params.spread = params.slDistance * 0.25;
  assert.equal(risk.validate(params), false, 'should reject wide-spread trades');
});

test('risk.validate: rejects when ATR is in the bottom 10% (noise zone)', () => {
  // Build an ATR series where recent values are very low vs history
  const atrValues = [
    ...Array.from({ length: 50 }, () => 5.0), // normal historic volatility
    ...Array.from({ length: 10 }, () => 0.5), // current (bottom of history)
  ];
  const params = risk.calculate('BUY', 2300, atrValues, { accountBalance: 10000, riskPercent: 1 });
  // Ensure spread is fine so spread gate isn't the one triggering
  params.spread = 0.3;
  assert.equal(risk.validate(params, { atrValues }), false, 'should reject noise-zone trades');
});

test('risk.validate: accepts healthy parameters', () => {
  const atrValues = Array.from({ length: 60 }, () => 3.5);
  const params = risk.calculate('BUY', 2300, atrValues, { accountBalance: 10000, riskPercent: 1 });
  params.spread = 0.3;
  assert.equal(risk.validate(params, { atrValues }), true);
});

test('risk.validate: rejects SL on wrong side of entry', () => {
  const atrValues = Array.from({ length: 20 }, () => 3.5);
  const params = risk.calculate('BUY', 2300, atrValues, { accountBalance: 10000, riskPercent: 1 });
  params.stopLoss = params.entryPrice + 10; // flip to invalid side
  assert.equal(risk.validate(params), false);
});
