const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../src/filters/sessionFilter');

test('session filter returns structured response', () => {
  const result = session.check();
  assert.equal(typeof result.allowed, 'boolean');
  assert.equal(typeof result.session, 'string');
  assert.equal(typeof result.reason, 'string');
});
