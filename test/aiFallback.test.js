const test = require('node:test');
const assert = require('node:assert/strict');

// Force a known config before requiring aiAgent so its defaults match the test expectations.
process.env.AI_FALLBACK_ALLOW = 'true';
process.env.AI_FALLBACK_MODE = 'strict';
process.env.AI_FALLBACK_PENALTY = '10';
process.env.AI_GATE_MIN = '50';
process.env.AI_GATE_MAX = '84';

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/aiAgent')];
const aiAgent = require('../src/aiAgent');

test('AI fallback (strict): rejects grey-zone signal below cutoff', () => {
  // smartGateMin=50, smartGateMax=84, cutoff = floor((50+84)/2) = 67
  const result = aiAgent._fallbackResult(
    { signal: 'BUY', confidence: 60 },
    'Simulated error',
    'error'
  );
  assert.equal(result.approved, false);
  assert.equal(result.decisionSource, 'strict_reject');
});

test('AI fallback (strict): approves with penalty when confidence >= cutoff', () => {
  const result = aiAgent._fallbackResult(
    { signal: 'BUY', confidence: 75 },
    'Simulated error',
    'error'
  );
  assert.equal(result.approved, true);
  assert.equal(result.confidence, 65, 'should apply 10 point penalty');
  assert.equal(result.decisionSource, 'error');
});

test('AI decision tracking increments decisionSources', () => {
  const before = aiAgent.decisionSources.error || 0;
  aiAgent._fallbackResult({ signal: 'SELL', confidence: 80 }, 'test', 'error');
  assert.equal(aiAgent.decisionSources.error, before + 1);
});

test('AI getStats() returns bypassRate and decisionSources', () => {
  const stats = aiAgent.getStats();
  assert.equal(typeof stats.bypassRate, 'number');
  assert.equal(typeof stats.decisionSources, 'object');
});

test('AI fallback (normal mode): approves grey zone with penalty', async () => {
  // Re-import with normal mode
  process.env.AI_FALLBACK_ALLOW = 'true';
  process.env.AI_FALLBACK_MODE = 'normal';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/aiAgent')];
  const normalAgent = require('../src/aiAgent');

  const result = normalAgent._fallbackResult(
    { signal: 'BUY', confidence: 55 },
    'Simulated error',
    'error'
  );
  assert.equal(result.approved, true, 'normal mode approves grey zone');
  assert.equal(result.confidence, 45, 'should apply 10 point penalty');
});

test('AI parse error follows strict fallback (rejects low confidence)', () => {
  process.env.AI_FALLBACK_ALLOW = 'true';
  process.env.AI_FALLBACK_MODE = 'strict';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/aiAgent')];
  const strictAgent = require('../src/aiAgent');

  const result = strictAgent._parseValidationResponse('invalid-json', {
    signal: 'BUY',
    confidence: 60,
  });
  assert.equal(result.approved, false);
  assert.equal(result.decisionSource, 'strict_reject');
});

test('AI confidence blend: model source uses weighted average', () => {
  const result = aiAgent.deriveFinalConfidence(80, { confidence: 60, decisionSource: 'model' });
  assert.equal(result, 72);
});

test('AI confidence blend: fallback source takes lower confidence', () => {
  const result = aiAgent.deriveFinalConfidence(82, { confidence: 68, decisionSource: 'rate_limited' });
  assert.equal(result, 68);
});

test('AI confidence blend: model source cannot inflate above strategy confidence', () => {
  const result = aiAgent.deriveFinalConfidence(70, { confidence: 95, decisionSource: 'model' });
  assert.equal(result, 70);
});

test('AI parse error: handles missing original signal safely', () => {
  const result = aiAgent._parseValidationResponse('invalid-json');
  assert.equal(typeof result.approved, 'boolean');
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
});
