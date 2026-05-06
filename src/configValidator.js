const config = require('./config');

/**
 * Fail-fast config validation.
 * Called at startup. Throws with a clear, actionable error if misconfigured.
 *
 * Checks:
 * - Required credentials present (telegram, at least one data provider)
 * - Numeric ranges within safe bounds (risk, RR, AI confidence)
 * - Enum values valid (timeframes, provider)
 *
 * Return shape: { ok, errors: string[], warnings: string[] }
 */

const VALID_TIMEFRAMES = ['1min', '5min', '15min', '30min', '1h', '4h', '1day'];
const VALID_PROVIDERS = ['tradingview', 'twelvedata', 'alphavantage'];

function validate() {
  const errors = [];
  const warnings = [];

  // ── REQUIRED: Telegram ──
  if (!config.telegram.botToken) {
    errors.push('TELEGRAM_BOT_TOKEN is required. Get one from @BotFather on Telegram.');
  }
  if (!config.telegram.chatId) {
    errors.push('TELEGRAM_CHAT_ID is required. Use @userinfobot to get your chat ID.');
  }

  // ── REQUIRED: At least one data provider API key ──
  const hasTwelveData = Boolean(config.twelvedata.apiKey);
  const hasAlphaVantage = Boolean(config.alphavantage.apiKey);
  if (!hasTwelveData && !hasAlphaVantage) {
    errors.push(
      'At least one data provider API key required. Set TWELVEDATA_API_KEY (free: https://twelvedata.com) ' +
        'or ALPHAVANTAGE_API_KEY (free: https://www.alphavantage.co).'
    );
  }

  // ── ENUM: data provider ──
  if (!VALID_PROVIDERS.includes(config.dataProvider)) {
    errors.push(
      `DATA_PROVIDER="${config.dataProvider}" invalid. Must be one of: ${VALID_PROVIDERS.join(', ')}.`
    );
  }
  // Warn if selected provider has no key
  if (config.dataProvider === 'twelvedata' && !hasTwelveData) {
    warnings.push('DATA_PROVIDER=twelvedata but no TWELVEDATA_API_KEY set. Will fall back to AlphaVantage.');
  }
  if (config.dataProvider === 'alphavantage' && !hasAlphaVantage) {
    warnings.push('DATA_PROVIDER=alphavantage but no ALPHAVANTAGE_API_KEY set. Will fall back to TwelveData.');
  }

  // ── ENUM: timeframes ──
  if (!Array.isArray(config.timeframes) || config.timeframes.length === 0) {
    errors.push('TIMEFRAMES must have at least one value (e.g. "15min,1h").');
  } else {
    for (const tf of config.timeframes) {
      if (!VALID_TIMEFRAMES.includes(tf)) {
        errors.push(
          `Timeframe "${tf}" invalid. Valid values: ${VALID_TIMEFRAMES.join(', ')}.`
        );
      }
    }
  }
  if (!VALID_TIMEFRAMES.includes(config.primaryTimeframe)) {
    errors.push(
      `PRIMARY_TIMEFRAME="${config.primaryTimeframe}" invalid. Valid: ${VALID_TIMEFRAMES.join(', ')}.`
    );
  }

  // ── RANGES: risk parameters ──
  _checkRange(errors, 'RISK_PERCENT', config.riskPercent, 0.1, 3);
  _checkRange(errors, 'REWARD_RATIO', config.rewardRatio, 1.2, 10);
  _checkRange(errors, 'ACCOUNT_BALANCE', config.risk.accountBalance, 100, 10_000_000);
  _checkRange(errors, 'SPREAD_POINTS', config.risk.spreadPoints, 0, 5);

  // ── RANGES: news filter buffers ──
  _checkRange(errors, 'NEWS_BUFFER_BEFORE_MIN', config.newsFilter.bufferBeforeMin, 0, 240);
  _checkRange(errors, 'NEWS_BUFFER_AFTER_MIN', config.newsFilter.bufferAfterMin, 0, 240);

  // ── RANGES: AI ──
  _checkRange(errors, 'AI_MIN_CONFIDENCE', config.ai.minConfidence, 0, 100);
  _checkRange(errors, 'AI_GATE_MIN', config.ai.smartGateMin, 0, 100);
  _checkRange(errors, 'AI_GATE_MAX', config.ai.smartGateMax, 0, 100);
  _checkRange(errors, 'AI_MAX_CALLS_HOUR', config.ai.maxCallsPerHour, 0, 1000);
  _checkRange(errors, 'AI_DEDUPE_MIN', config.ai.dedupeMinutes, 0, 1440);

  if (config.ai.smartGateMin >= config.ai.smartGateMax) {
    errors.push(
      `AI_GATE_MIN (${config.ai.smartGateMin}) must be < AI_GATE_MAX (${config.ai.smartGateMax}).`
    );
  }

  // AI enabled but no API key
  if (config.ai.enabled && !config.ai.minimax.apiKey) {
    warnings.push('AI_AGENT_ENABLED=true but MINIMAX_API_KEY not set. AI will be bypassed.');
  }

  // ── RANGES: session ──
  _checkRange(errors, 'SESSION_ASIAN_PENALTY', config.sessionFilter.asianConfPenalty, 0, 50);

  // ── RANGES: paper trading ──
  if (config.paperTrading.enabled) {
    _checkRange(errors, 'PAPER_MAX_OPEN_POSITIONS', config.paperTrading.maxOpenPositions, 1, 50);
    _checkRange(errors, 'PAPER_INITIAL_BALANCE', config.paperTrading.initialBalance, 100, 10_000_000);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function _checkRange(errors, name, value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${name} must be a number (got ${value}).`);
    return;
  }
  if (value < min || value > max) {
    errors.push(`${name} out of range: got ${value}, expected ${min}-${max}.`);
  }
}

/**
 * Run validation and throw a formatted error on failure.
 * Called from startup. Use this in start() to fail-fast.
 */
function validateOrThrow() {
  const result = validate();

  if (result.warnings.length > 0) {
    console.warn('\n⚠️  Config warnings:');
    for (const w of result.warnings) console.warn(`   • ${w}`);
    console.warn('');
  }

  if (!result.ok) {
    const msg =
      '\n❌ Configuration errors — bot cannot start:\n' +
      result.errors.map((e) => `   • ${e}`).join('\n') +
      '\n\nFix these in your .env file and restart. See .env.example for reference.\n';
    throw new Error(msg);
  }

  return result;
}

module.exports = { validate, validateOrThrow, VALID_TIMEFRAMES, VALID_PROVIDERS };
