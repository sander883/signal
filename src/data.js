const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

class MarketData {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 60 * 1000; // 1 minute cache
    this.providerState = {
      twelvedata: { failures: 0, blockedUntil: 0 },
      alphavantage: { failures: 0, blockedUntil: 0 },
    };
    this.breakerCooldownMs = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Fetch XAUUSD candle data from configured provider.
   * @param {string} timeframe - e.g. '15min', '1h'
   * @param {number} outputSize - number of candles
   * @returns {Promise<Array<{time:string, open:number, high:number, low:number, close:number, volume:number}>>}
   */
  async fetchCandles(timeframe = config.primaryTimeframe, outputSize = 250) {
    const cacheKey = `${timeframe}_${outputSize}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.data;
    }

    try {
      const preferred = config.dataProvider === 'alphavantage' ? 'alphavantage' : 'twelvedata';
      const order = preferred === 'twelvedata'
        ? ['twelvedata', 'alphavantage']
        : ['alphavantage', 'twelvedata'];

      let candles;
      let lastErr;
      for (const provider of order) {
        if (this._isProviderBlocked(provider)) continue;
        try {
          candles = provider === 'twelvedata'
            ? await this._fetchTwelveData(timeframe, outputSize)
            : await this._fetchAlphaVantage(timeframe, outputSize);
          this._recordProviderSuccess(provider);
          break;
        } catch (err) {
          lastErr = err;
          this._recordProviderFailure(provider);
          logger.warn(`Provider ${provider} failed: ${err.message}`);
        }
      }

      if (!candles) {
        throw lastErr || new Error('All data providers failed');
      }

      this.cache.set(cacheKey, { data: candles, ts: Date.now() });
      logger.info(`Fetched ${candles.length} candles for ${config.symbol} [${timeframe}]`);
      return candles;
    } catch (err) {
      logger.error(`Failed to fetch market data: ${err.message}`);
      // Return cached data if available, even if stale
      if (cached) {
        logger.warn('Returning stale cached data');
        return cached.data;
      }
      throw err;
    }
  }

  _isProviderBlocked(provider) {
    const state = this.providerState[provider];
    return state && state.blockedUntil > Date.now();
  }

  _recordProviderSuccess(provider) {
    const state = this.providerState[provider];
    if (!state) return;
    state.failures = 0;
    state.blockedUntil = 0;
  }

  _recordProviderFailure(provider) {
    const state = this.providerState[provider];
    if (!state) return;
    state.failures += 1;
    if (state.failures >= 3) {
      state.blockedUntil = Date.now() + this.breakerCooldownMs;
      logger.warn(`Provider ${provider} circuit breaker open for ${this.breakerCooldownMs / 60000} minutes`);
    }
  }

  async _fetchTwelveData(timeframe, outputSize) {
    const url = `${config.twelvedata.baseUrl}/time_series`;
    const resp = await axios.get(url, {
      params: {
        symbol: 'XAU/USD',
        interval: timeframe,
        outputsize: outputSize,
        apikey: config.twelvedata.apiKey,
        format: 'JSON',
      },
      timeout: 15000,
    });

    if (resp.data.status === 'error') {
      throw new Error(`TwelveData API error: ${resp.data.message}`);
    }

    const values = resp.data.values || [];
    // TwelveData returns newest first; reverse so oldest is index 0
    return values
      .map((v) => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume) || 0,
      }))
      .reverse();
  }

  async _fetchAlphaVantage(timeframe, outputSize) {
    // Map our timeframe to AV function
    const functionMap = {
      '1min': 'FX_INTRADAY',
      '5min': 'FX_INTRADAY',
      '15min': 'FX_INTRADAY',
      '30min': 'FX_INTRADAY',
      '1h': 'FX_INTRADAY',
      '4h': 'FX_INTRADAY',
      '1day': 'FX_DAILY',
    };
    const avInterval = {
      '1min': '1min',
      '5min': '5min',
      '15min': '15min',
      '30min': '30min',
      '1h': '60min',
      '4h': '60min',
    };

    const fn = functionMap[timeframe] || 'FX_INTRADAY';
    const interval = avInterval[timeframe] || '15min';

    const resp = await axios.get(config.alphavantage.baseUrl, {
      params: {
        function: fn,
        from_symbol: 'XAU',
        to_symbol: 'USD',
        interval: interval,
        outputsize: 'full',
        apikey: config.alphavantage.apiKey,
      },
      timeout: 15000,
    });

    // AV uses dynamic key names
    const seriesKey = Object.keys(resp.data).find((k) => k.includes('Time Series'));
    if (!seriesKey) {
      throw new Error('AlphaVantage: No time series data returned');
    }

    const series = resp.data[seriesKey];
    const candles = Object.entries(series)
      .map(([time, v]) => ({
        time,
        open: parseFloat(v['1. open']),
        high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
        volume: 0,
      }))
      .reverse()
      .slice(-outputSize);

    return candles;
  }

  /**
   * Get current price (latest close).
   */
  async getCurrentPrice() {
    const candles = await this.fetchCandles(config.primaryTimeframe, 5);
    return candles[candles.length - 1].close;
  }
}

module.exports = new MarketData();
