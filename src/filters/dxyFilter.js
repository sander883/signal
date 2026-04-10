const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

/**
 * DXY (US Dollar Index) Correlation Filter
 *
 * Gold and USD have a strong inverse correlation (~-0.80).
 * When DXY rises → Gold tends to fall, and vice versa.
 *
 * This filter:
 * 1. Fetches DXY price data
 * 2. Computes DXY trend (EMA-based)
 * 3. Checks if gold signal aligns with DXY inverse correlation
 * 4. Returns correlation score to adjust signal confidence
 */

const { EMA } = require('technicalindicators');

class DXYFilter {
  constructor() {
    this.cache = { data: null, ts: 0 };
    this.cacheTTL = 5 * 60 * 1000; // 5 min cache
  }

  /**
   * Check if a gold signal aligns with DXY correlation.
   * @param {string} goldDirection - 'BUY' or 'SELL'
   * @returns {Promise<{aligned: boolean, dxyTrend: string, score: number, reason: string}>}
   */
  async check(goldDirection) {
    if (!config.dxyFilter.enabled) {
      return { aligned: true, dxyTrend: 'unknown', score: 0, reason: 'DXY filter disabled' };
    }

    try {
      const dxyData = await this._fetchDXY();
      if (!dxyData || dxyData.length < 50) {
        return { aligned: true, dxyTrend: 'unknown', score: 0, reason: 'Insufficient DXY data' };
      }

      const closes = dxyData.map((c) => c.close);

      // Compute DXY EMAs
      const ema20 = EMA.calculate({ period: 20, values: closes });
      const ema50 = EMA.calculate({ period: 50, values: closes });

      if (!ema20.length || !ema50.length) {
        return { aligned: true, dxyTrend: 'unknown', score: 0, reason: 'Cannot compute DXY EMAs' };
      }

      const currEma20 = ema20[ema20.length - 1];
      const prevEma20 = ema20[ema20.length - 2];
      const currEma50 = ema50[ema50.length - 1];
      const currPrice = closes[closes.length - 1];

      // DXY trend determination
      let dxyTrend = 'neutral';
      let trendStrength = 0;

      // Primary: EMA20 vs EMA50
      if (currEma20 > currEma50) {
        dxyTrend = 'bullish';
        trendStrength = ((currEma20 - currEma50) / currEma50) * 10000; // basis points
      } else if (currEma20 < currEma50) {
        dxyTrend = 'bearish';
        trendStrength = ((currEma50 - currEma20) / currEma50) * 10000;
      }

      // Momentum: is EMA20 rising or falling?
      const ema20Rising = currEma20 > prevEma20;
      if (dxyTrend === 'bullish' && !ema20Rising) dxyTrend = 'weakening-bull';
      if (dxyTrend === 'bearish' && ema20Rising) dxyTrend = 'weakening-bear';

      // Price vs EMA20 for immediate momentum
      const priceAboveEma20 = currPrice > currEma20;

      // Inverse correlation logic:
      // Gold BUY aligns with DXY bearish (USD weakening → gold up)
      // Gold SELL aligns with DXY bullish (USD strengthening → gold down)
      const expectedDXY = goldDirection === 'BUY' ? 'bearish' : 'bullish';
      const aligned = dxyTrend.includes(expectedDXY);

      // Calculate score (-20 to +10)
      let score = 0;
      if (aligned) {
        score = Math.min(10, Math.round(trendStrength));
        // Strong alignment: DXY momentum confirms
        if (goldDirection === 'BUY' && !priceAboveEma20) score += 3; // DXY falling below EMA
        if (goldDirection === 'SELL' && priceAboveEma20) score += 3; // DXY rising above EMA
      } else if (dxyTrend === 'neutral') {
        score = 0;
      } else {
        score = -Math.min(20, Math.round(trendStrength * 1.5));
        // DXY is actively against our gold signal
        if (goldDirection === 'BUY' && priceAboveEma20) score -= 3;
        if (goldDirection === 'SELL' && !priceAboveEma20) score -= 3;
      }

      const reason = `DXY ${dxyTrend} (EMA20:${currEma20.toFixed(2)} EMA50:${currEma50.toFixed(2)} P:${currPrice.toFixed(2)})`;

      logger.info(
        `[DXY] ${goldDirection} gold vs DXY ${dxyTrend} → ${aligned ? 'ALIGNED' : 'CONFLICT'} | score: ${score > 0 ? '+' : ''}${score}`
      );

      return { aligned, dxyTrend, score, reason, dxyPrice: currPrice };
    } catch (err) {
      logger.warn(`[DXY] Fetch failed: ${err.message}`);
      return { aligned: true, dxyTrend: 'unknown', score: 0, reason: `DXY error: ${err.message}` };
    }
  }

  async _fetchDXY() {
    // Return cached if fresh
    if (this.cache.data && Date.now() - this.cache.ts < this.cacheTTL) {
      return this.cache.data;
    }

    // Use TwelveData to fetch DXY (or USDX)
    if (config.dataProvider === 'twelvedata' && config.twelvedata.apiKey) {
      const resp = await axios.get(`${config.twelvedata.baseUrl}/time_series`, {
        params: {
          symbol: config.dxyFilter.symbol,
          interval: config.dxyFilter.timeframe,
          outputsize: 100,
          apikey: config.twelvedata.apiKey,
          format: 'JSON',
        },
        timeout: 10000,
      });

      if (resp.data.status === 'error') {
        throw new Error(resp.data.message);
      }

      const data = (resp.data.values || [])
        .map((v) => ({
          time: v.datetime,
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
        }))
        .reverse();

      this.cache = { data, ts: Date.now() };
      return data;
    }

    throw new Error('No API configured for DXY data');
  }
}

module.exports = new DXYFilter();
