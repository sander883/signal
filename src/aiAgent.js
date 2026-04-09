const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * AI Agent Module — Minimax Integration (Token-Optimized)
 *
 * TOKEN SAVING STRATEGIES:
 * 1. Smart Gate: Only call AI for "grey zone" signals (50-84% confidence).
 *    High confidence (>=85%) auto-approved. Low (<50%) already filtered out.
 * 2. Rate Limiter: Max N calls per hour.
 * 3. Deduplication: Same direction+timeframe skipped within N minutes.
 * 4. Compact Prompts: Minimal tokens, no filler text.
 * 5. Low max_tokens (150): Forces short JSON responses.
 * 6. Sentiment Cache: Reused for 10 min, not re-fetched per signal.
 * 7. System prompt cached (sent once, reused by Minimax internally).
 */

const SYSTEM_PROMPT = 'XAUUSD analyst. JSON only.';

class AIAgent {
  constructor() {
    this.enabled = false;
    this.sentimentCache = { data: null, ts: 0 };
    this.sentimentCacheTTL = 10 * 60 * 1000;

    // Token-saving state
    this.callLog = [];        // timestamps of recent API calls
    this.dedupeCache = {};    // { "BUY_15min": timestamp }
    this.totalCalls = 0;
    this.totalSkipped = 0;
  }

  init() {
    if (!config.ai.enabled) {
      logger.info('[AI Agent] Disabled via config');
      return;
    }
    if (!config.ai.minimax.apiKey) {
      logger.warn('[AI Agent] No Minimax API key — bypass mode');
      return;
    }
    this.enabled = true;
    logger.info(
      `[AI Agent] Minimax OK | model: ${config.ai.minimax.model} | ` +
        `gate: ${config.ai.smartGateMin}-${config.ai.smartGateMax}% | ` +
        `limit: ${config.ai.maxCallsPerHour}/hr | dedupe: ${config.ai.dedupeMinutes}min`
    );
  }

  /**
   * Validate a trading signal. Returns { approved, confidence, reason, sentiment, adjustedSignal }
   *
   * SMART GATE LOGIC (saves ~60-70% of tokens):
   * - confidence >= 85%  → AUTO APPROVE (no API call)
   * - confidence < 50%   → never reaches here (filtered in index.js)
   * - confidence 50-84%  → ASK AI (the uncertain zone)
   */
  async validateSignal(signal, riskParams, marketContext) {
    if (!this.enabled) {
      return this._bypassResult(signal, 'AI disabled');
    }

    const { smartGateMin, smartGateMax } = config.ai;

    // ── CHECK 1: Smart Gate — skip AI for high-confidence signals ──
    if (signal.confidence >= smartGateMax + 1) {
      this.totalSkipped++;
      logger.info(`[AI] AUTO-APPROVE: confidence ${signal.confidence}% >= ${smartGateMax + 1}% threshold`);
      return {
        approved: true,
        confidence: signal.confidence,
        sentiment: 'neutral',
        reason: `Auto-approved (high confidence ${signal.confidence}%)`,
        adjustedSignal: null,
      };
    }

    // ── CHECK 2: Deduplication — same signal recently? ──
    const dedupeKey = `${signal.signal}_${marketContext.timeframe}`;
    const lastCall = this.dedupeCache[dedupeKey];
    if (lastCall && Date.now() - lastCall < config.ai.dedupeMinutes * 60 * 1000) {
      this.totalSkipped++;
      const minAgo = Math.round((Date.now() - lastCall) / 60000);
      logger.info(`[AI] DEDUPE SKIP: same ${dedupeKey} was checked ${minAgo}min ago`);
      return this._bypassResult(signal, `Dedupe: same signal checked ${minAgo}min ago`);
    }

    // ── CHECK 3: Rate limiter ──
    if (config.ai.maxCallsPerHour > 0) {
      const oneHourAgo = Date.now() - 3600000;
      this.callLog = this.callLog.filter((t) => t > oneHourAgo);
      if (this.callLog.length >= config.ai.maxCallsPerHour) {
        this.totalSkipped++;
        logger.warn(`[AI] RATE LIMITED: ${this.callLog.length}/${config.ai.maxCallsPerHour} calls this hour`);
        return this._bypassResult(signal, 'Rate limited');
      }
    }

    // ── CALL AI ──
    try {
      const prompt = this._buildCompactPrompt(signal, riskParams, marketContext);
      const response = await this._chat(prompt);
      const result = this._parseValidationResponse(response, signal);

      // Track
      this.callLog.push(Date.now());
      this.dedupeCache[dedupeKey] = Date.now();
      this.totalCalls++;

      logger.info(
        `[AI] ${result.approved ? 'APPROVED' : 'REJECTED'} | conf: ${result.confidence}% | ` +
          `${result.reason} | calls today: ${this.totalCalls} | skipped: ${this.totalSkipped}`
      );

      return result;
    } catch (err) {
      logger.error(`[AI] Error: ${err.message}`);
      return this._bypassResult(signal, `Error: ${err.message}`);
    }
  }

  /**
   * Sentiment analysis (cached for 10 min).
   */
  async analyzeSentiment(candles, newsEvents) {
    if (!this.enabled) {
      return { sentiment: 'neutral', score: 0, analysis: 'AI disabled' };
    }
    if (Date.now() - this.sentimentCache.ts < this.sentimentCacheTTL && this.sentimentCache.data) {
      return this.sentimentCache.data;
    }

    // Rate check — sentiment counts toward hourly limit too
    if (config.ai.maxCallsPerHour > 0) {
      const oneHourAgo = Date.now() - 3600000;
      this.callLog = this.callLog.filter((t) => t > oneHourAgo);
      if (this.callLog.length >= config.ai.maxCallsPerHour) {
        return { sentiment: 'neutral', score: 0, analysis: 'Rate limited' };
      }
    }

    try {
      const prompt = this._buildCompactSentimentPrompt(candles, newsEvents);
      const response = await this._chat(prompt);
      const result = this._parseSentimentResponse(response);

      this.sentimentCache = { data: result, ts: Date.now() };
      this.callLog.push(Date.now());
      this.totalCalls++;
      logger.info(`[AI] Sentiment: ${result.sentiment} (${result.score})`);
      return result;
    } catch (err) {
      logger.error(`[AI] Sentiment error: ${err.message}`);
      return { sentiment: 'neutral', score: 0, analysis: `Error: ${err.message}` };
    }
  }

  /**
   * COMPACT validation prompt (~300 tokens input vs ~800 before = 60% saving).
   * Uses abbreviated format, no filler, only essential data.
   */
  _buildCompactPrompt(signal, risk, ctx) {
    // Condense last 5 candles into one line each (not 10)
    const prices = ctx.recentCandles.slice(-5).map(
      (c) => `${c.close.toFixed(1)}`
    ).join(',');

    return `XAUUSD ${signal.signal} ${ctx.timeframe}
P:${ctx.currentPrice.toFixed(1)} EMA50:${ctx.ema50?.toFixed(1)||'-'} EMA200:${ctx.ema200?.toFixed(1)||'-'} RSI:${ctx.rsi?.toFixed(0)||'-'} ATR:${ctx.atr?.toFixed(1)||'-'}
BB:${ctx.bbLower?.toFixed(1)||'-'}/${ctx.bbUpper?.toFixed(1)||'-'} Trend:${ctx.alignmentTrend} Sess:${ctx.session}
Last5Close:${prices}
Strat:${signal.strategy} Conf:${signal.confidence}% Confl:${signal.confluence||1}
E:${risk.entryPrice} SL:${risk.stopLoss} TP:${risk.takeProfit} RR:${risk.riskRewardRatio}
Reply JSON:{"ok":bool,"c":0-100,"s":"bull/bear/neut","r":"reason max 60ch"}`;
  }

  /**
   * COMPACT sentiment prompt (~200 tokens).
   */
  _buildCompactSentimentPrompt(candles, newsEvents) {
    const r = candles.slice(-10);
    const closes = r.map((c) => c.close.toFixed(1)).join(',');
    const hi = Math.max(...r.map((c) => c.high)).toFixed(1);
    const lo = Math.min(...r.map((c) => c.low)).toFixed(1);
    const chg = (((r[r.length - 1].close - r[0].close) / r[0].close) * 100).toFixed(2);
    const news = newsEvents?.length
      ? newsEvents.slice(0, 3).map((e) => e.title).join(';')
      : 'none';

    return `XAUUSD sentiment. Close10:${closes} Hi:${hi} Lo:${lo} Chg:${chg}%
News:${news}
JSON:{"s":"bull/bear/neut","sc":-100to100,"a":"analysis 60ch","r":"BUY/SELL/WAIT"}`;
  }

  /**
   * Call Minimax API with minimal tokens.
   * M2 series uses OpenAI-compatible /chat/completions endpoint.
   */
  async _chat(prompt) {
    const { apiKey, model, baseUrl } = config.ai.minimax;

    // M2 models use /chat/completions; legacy abab uses /text/chatcompletion_v2
    const isM2 = model.toLowerCase().startsWith('minimax-m');
    const endpoint = isM2
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/text/chatcompletion_v2`;

    const resp = await axios.post(
      endpoint,
      {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    // Error handling for both API formats
    if (resp.data.base_resp && resp.data.base_resp.status_code !== 0) {
      throw new Error(`Minimax: ${resp.data.base_resp.status_msg}`);
    }
    if (resp.data.error) {
      throw new Error(`Minimax: ${resp.data.error.message}`);
    }

    const content = resp.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty Minimax response');
    return content;
  }

  _parseValidationResponse(text, originalSignal) {
    try {
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(jsonStr);

      // Support both verbose and compact keys
      const approved = data.ok ?? data.approved ?? false;
      const confidence = Math.max(0, Math.min(100, parseInt(data.c ?? data.confidence) || 0));
      const sentiment = data.s ?? data.sentiment ?? 'neutral';
      const reason = String(data.r ?? data.reason ?? 'No reason').slice(0, 200);

      // Normalize sentiment
      const sentimentMap = { bull: 'bullish', bear: 'bearish', neut: 'neutral' };
      const normSentiment = sentimentMap[sentiment] || sentiment;

      const result = {
        approved: Boolean(approved),
        confidence,
        sentiment: normSentiment,
        reason,
        adjustedSignal: null,
      };

      if (result.confidence < config.ai.minConfidence) {
        result.approved = false;
        result.reason = `AI conf ${result.confidence}% < ${config.ai.minConfidence}% min`;
      }

      // Compact format doesn't include adjustments (saves tokens)
      // If AI uses verbose format with adjustEntry/SL/TP, still support it
      if (result.approved && (data.adjustEntry || data.adjustSL || data.adjustTP)) {
        result.adjustedSignal = {};
        if (typeof data.adjustEntry === 'number') result.adjustedSignal.entryPrice = Math.round(data.adjustEntry * 100) / 100;
        if (typeof data.adjustSL === 'number') result.adjustedSignal.stopLoss = Math.round(data.adjustSL * 100) / 100;
        if (typeof data.adjustTP === 'number') result.adjustedSignal.takeProfit = Math.round(data.adjustTP * 100) / 100;
      }

      return result;
    } catch (err) {
      logger.warn(`[AI] Parse error: ${err.message} | raw: ${text.slice(0, 100)}`);
      return {
        approved: config.ai.fallbackAllow,
        confidence: 50,
        sentiment: 'neutral',
        reason: 'Parse error — fallback',
        adjustedSignal: null,
      };
    }
  }

  _parseSentimentResponse(text) {
    try {
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(jsonStr);
      const sentimentMap = { bull: 'bullish', bear: 'bearish', neut: 'neutral' };
      return {
        sentiment: sentimentMap[data.s] || data.s || data.sentiment || 'neutral',
        score: Math.max(-100, Math.min(100, parseInt(data.sc ?? data.score) || 0)),
        analysis: String(data.a ?? data.analysis ?? '').slice(0, 200),
        recommendation: data.r ?? data.recommendation ?? 'WAIT',
      };
    } catch (err) {
      logger.warn(`[AI] Sentiment parse error: ${err.message}`);
      return { sentiment: 'neutral', score: 0, analysis: 'Parse error' };
    }
  }

  _bypassResult(signal, reason) {
    return {
      approved: config.ai.fallbackAllow,
      confidence: signal.confidence,
      sentiment: 'neutral',
      reason,
      adjustedSignal: null,
    };
  }

  /**
   * Get usage stats for logging/debugging.
   */
  getStats() {
    return {
      totalCalls: this.totalCalls,
      totalSkipped: this.totalSkipped,
      savingsPercent: this.totalCalls + this.totalSkipped > 0
        ? Math.round((this.totalSkipped / (this.totalCalls + this.totalSkipped)) * 100)
        : 0,
      callsThisHour: this.callLog.filter((t) => t > Date.now() - 3600000).length,
    };
  }
}

module.exports = new AIAgent();
