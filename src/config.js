require('dotenv').config();

const config = {
  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // Data Provider
  dataProvider: process.env.DATA_PROVIDER || 'twelvedata',
  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY || '',
    baseUrl: 'https://api.twelvedata.com',
  },
  alphavantage: {
    apiKey: process.env.ALPHAVANTAGE_API_KEY || '',
    baseUrl: 'https://www.alphavantage.co/query',
  },

  // Trading
  symbol: 'XAU/USD',
  // Multi-timeframe: bot runs independent analysis on each enabled TF
  timeframes: (process.env.TIMEFRAMES || '15min,1h,4h').split(',').map((t) => t.trim()),
  primaryTimeframe: process.env.PRIMARY_TIMEFRAME || '15min',
  secondaryTimeframe: process.env.SECONDARY_TIMEFRAME || '1h',
  riskPercent: parseFloat(process.env.RISK_PERCENT) || 1.5,
  rewardRatio: parseFloat(process.env.REWARD_RATIO) || 2,

  // News Filter
  newsFilter: {
    enabled: process.env.NEWS_FILTER_ENABLED !== 'false',
    bufferBeforeMin: parseInt(process.env.NEWS_BUFFER_BEFORE_MIN) || 30,
    bufferAfterMin: parseInt(process.env.NEWS_BUFFER_AFTER_MIN) || 60,
    highImpactKeywords: [
      'Non-Farm', 'NFP', 'Nonfarm',
      'CPI', 'Consumer Price Index',
      'FOMC', 'Federal Reserve',
      'Interest Rate', 'Fed Rate',
      'GDP', 'Gross Domestic Product',
      'PPI', 'Producer Price Index',
      'Unemployment', 'Jobless Claims',
      'Retail Sales',
      'PMI',
      'Core PCE',
    ],
  },

  // Session Filter
  sessionFilter: {
    enabled: process.env.SESSION_FILTER_ENABLED !== 'false',
    // UTC hours
    asian: { start: 0, end: 8 },     // Tokyo 09:00-17:00 JST / Sydney 10:00-16:00 AEST
    london: { start: 7, end: 16 },    // London 07:00-16:00 UTC
    newYork: { start: 12, end: 21 },  // New York 12:00-21:00 UTC
    // Asian session: lower gold volatility, allowed with confidence penalty
    asianEnabled: process.env.SESSION_ASIAN_ENABLED !== 'false',
    asianConfPenalty: parseInt(process.env.SESSION_ASIAN_PENALTY) || 10,
  },

  // Strategies
  strategies: {
    trend: process.env.STRATEGY_TREND !== 'false',
    scalping: process.env.STRATEGY_SCALPING !== 'false',
    breakout: process.env.STRATEGY_BREAKOUT !== 'false',
    meanReversion: process.env.STRATEGY_MEAN_REVERSION !== 'false',
    priceAction: process.env.STRATEGY_PRICE_ACTION !== 'false',
  },

  // Indicator Defaults
  indicators: {
    ema: { fast: 9, medium: 21, slow: 50, trend: 200 },
    rsi: { period: 14, overbought: 70, oversold: 30 },
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stdDev: 2 },
    atr: { period: 14 },
  },

  // AI Agent (Minimax)
  ai: {
    enabled: process.env.AI_AGENT_ENABLED !== 'false',
    provider: process.env.AI_PROVIDER || 'minimax',
    minimax: {
      apiKey: process.env.MINIMAX_API_KEY || '',
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed',
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1',
    },
    // Minimum AI confidence to keep signal (0-100). Below this = reject.
    minConfidence: parseInt(process.env.AI_MIN_CONFIDENCE) || 40,
    // When AI is unavailable, should signals still pass?
    fallbackAllow: process.env.AI_FALLBACK_ALLOW !== 'false',
    // Fallback mode: 'strict' (reject 50-65 on AI fail) or 'normal' (pass with penalty)
    fallbackMode: process.env.AI_FALLBACK_MODE || 'strict',
    // Confidence penalty applied to bypassed signals in normal mode (0-30)
    fallbackPenalty: parseInt(process.env.AI_FALLBACK_PENALTY) || 10,
    // Alert when bypass rate exceeds this % (0 = disabled)
    bypassAlertThreshold: parseInt(process.env.AI_BYPASS_ALERT_PCT) || 20,

    // ── Token-saving settings ──
    // Only call AI when confidence is in this "uncertain" range.
    // High confidence (>=85) = auto-approve. Low (<50) = already filtered.
    // AI only reviews the grey zone in between.
    smartGateMin: parseInt(process.env.AI_GATE_MIN) || 50,
    smartGateMax: parseInt(process.env.AI_GATE_MAX) || 84,
    // Max AI calls per hour (0 = unlimited)
    maxCallsPerHour: parseInt(process.env.AI_MAX_CALLS_HOUR) || 10,
    // Cache identical signal direction for N minutes (skip duplicate calls)
    dedupeMinutes: parseInt(process.env.AI_DEDUPE_MIN) || 15,
  },

  // DXY Correlation Filter
  dxyFilter: {
    enabled: process.env.DXY_FILTER_ENABLED !== 'false',
    symbol: process.env.DXY_SYMBOL || 'DXY',
    timeframe: process.env.DXY_TIMEFRAME || '1h',
  },

  // Risk Management
  risk: {
    accountBalance: parseFloat(process.env.ACCOUNT_BALANCE) || 10000,
    atrMultiplierSL: 1.5,
    atrMultiplierTP: 3.0,
    trailingStopEnabled: true,
    breakEvenEnabled: true,
    spreadPoints: parseFloat(process.env.SPREAD_POINTS) || 0.30, // typical XAUUSD spread
  },

  // Cron - separate schedules per timeframe
  cronSchedule: process.env.CRON_SCHEDULE || '*/15 * * * 1-5',
  cronSchedules: {
    '1min': '*/1 * * * 1-5',
    '5min': '*/5 * * * 1-5',
    '15min': '*/15 * * * 1-5',
    '30min': '*/30 * * * 1-5',
    '1h': '0 * * * 1-5',        // Every hour on the hour
    '4h': '0 */4 * * 1-5',      // Every 4 hours
    '1day': '0 0 * * 1-5',      // Daily at midnight
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Observability
  observability: {
    heartbeatMinutes: parseInt(process.env.HEARTBEAT_MINUTES) || 60,
  },

  // Paper Trading (virtual execution; no real orders)
  paperTrading: {
    enabled: process.env.PAPER_TRADING_ENABLED === 'true',
    maxOpenPositions: parseInt(process.env.PAPER_MAX_OPEN_POSITIONS) || 3,
    initialBalance: parseFloat(process.env.PAPER_INITIAL_BALANCE) || 10000,
  },

  // Data Collection (ML dataset building)
  // Writes append-only JSONL files to data/ for future training.
  // Logs EVERY signal decision (sent AND blocked) to avoid survivorship bias.
  dataCollection: {
    enabled: process.env.DATA_COLLECTION_ENABLED !== 'false',
    logBlocks: process.env.DATA_LOG_BLOCKS !== 'false',
    candleWindow: parseInt(process.env.DATA_CANDLE_WINDOW) || 50,
  },
};

module.exports = config;
