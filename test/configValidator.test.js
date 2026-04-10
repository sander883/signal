const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/configValidator')];
  return require('../src/configValidator');
}

test('configValidator: fails without telegram token', () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChatId = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  const { validate } = freshRequire();
  const result = validate();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('TELEGRAM_BOT_TOKEN')));

  if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
  if (savedChatId) process.env.TELEGRAM_CHAT_ID = savedChatId;
});

test('configValidator: fails when RISK_PERCENT out of range', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TWELVEDATA_API_KEY = 'test';
  process.env.RISK_PERCENT = '999';

  const { validate } = freshRequire();
  const result = validate();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('RISK_PERCENT')));

  delete process.env.RISK_PERCENT;
});

test('configValidator: fails when AI_GATE_MIN >= AI_GATE_MAX', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TWELVEDATA_API_KEY = 'test';
  process.env.AI_GATE_MIN = '80';
  process.env.AI_GATE_MAX = '60';

  const { validate } = freshRequire();
  const result = validate();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /AI_GATE_MIN.*<.*AI_GATE_MAX/.test(e)));

  delete process.env.AI_GATE_MIN;
  delete process.env.AI_GATE_MAX;
});

test('configValidator: fails on invalid timeframe', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TWELVEDATA_API_KEY = 'test';
  process.env.TIMEFRAMES = '15min,banana';

  const { validate } = freshRequire();
  const result = validate();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('banana')));

  delete process.env.TIMEFRAMES;
});

test('configValidator: passes with all required fields', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TWELVEDATA_API_KEY = 'test';
  process.env.TIMEFRAMES = '15min,1h';

  const { validate } = freshRequire();
  const result = validate();
  assert.equal(result.ok, true, `unexpected errors: ${result.errors.join('; ')}`);
});
