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
    london: { start: 7, end: 16 },
    newYork: { start: 12, end: 21 },
    // Combined active window: 07:00 - 21:00 UTC
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

  // Risk Management
  risk: {
    atrMultiplierSL: 1.5,
    atrMultiplierTP: 3.0,
    trailingStopEnabled: true,
    breakEvenEnabled: true,
  },

  // Cron
  cronSchedule: process.env.CRON_SCHEDULE || '*/15 * * * 1-5',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
