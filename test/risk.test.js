const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../src/risk');

test('risk calculate should return valid BUY parameters', () => {
  const atr = Array.from({ length: 20 }, () => 3.5);
  const out = risk.calculate('BUY', 2300, atr, { accountBalance: 10000, riskPercent: 1 });
  assert.ok(out);
  assert.equal(out.direction, 'BUY');
  assert.ok(out.stopLoss < out.entryPrice);
  assert.ok(out.takeProfit > out.entryPrice);
  assert.ok(risk.validate(out));
});

