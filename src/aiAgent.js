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

    // Decision-source tracking for audit/SLO
    // decisionSources: { model: N, auto_approve: N, bypass: N, rate_limited: N,
    //                    dedupe: N, error: N, strict_reject: N }
    this.decisionSources = {};
    this.bypassCount = 0;   // bypassed (not model-decided) in current window
    this.decisionCount = 0; // total decisions in current window
    this.lastBypassAlert = 0;
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
    this.decisionCount++;

    if (!this.enabled) {
      return this._bypassResult(signal, 'AI disabled', 'bypass');
    }

    const { smartGateMin, smartGateMax } = config.ai;

    // ── CHECK 1: Smart Gate — skip AI for high-confidence signals ──
    if (signal.confidence >= smartGateMax + 1) {
      this.totalSkipped++;
      this._trackDecision('auto_approve');
      logger.info(`[AI] AUTO-APPROVE: confidence ${signal.confidence}% >= ${smartGateMax + 1}% threshold`);
      return {
        approved: true,
        confidence: signal.confidence,
        sentiment: 'neutral',
        reason: `Auto-approved (high confidence ${signal.confidence}%)`,
        adjustedSignal: null,
        decisionSource: 'auto_approve',
      };
    }

    // ── CHECK 2: Deduplication — same signal recently? ──
    const dedupeKey = `${signal.signal}_${marketContext.timeframe}`;
    const lastCall = this.dedupeCache[dedupeKey];
    if (lastCall && Date.now() - lastCall < config.ai.dedupeMinutes * 60 * 1000) {
      this.totalSkipped++;
      const minAgo = Math.round((Date.now() - lastCall) / 60000);
      logger.info(`[AI] DEDUPE SKIP: same ${dedupeKey} was checked ${minAgo}min ago`);
      return this._bypassResult(signal, `Dedupe: same signal checked ${minAgo}min ago`, 'dedupe');
    }

    // ── CHECK 3: Rate limiter ──
    if (config.ai.maxCallsPerHour > 0) {
      const oneHourAgo = Date.now() - 3600000;
      this.callLog = this.callLog.filter((t) => t > oneHourAgo);
      if (this.callLog.length >= config.ai.maxCallsPerHour) {
        this.totalSkipped++;
        logger.warn(`[AI] RATE LIMITED: ${this.callLog.length}/${config.ai.maxCallsPerHour} calls this hour`);
        return this._fallbackResult(signal, 'Rate limited', 'rate_limited');
      }
    }

    // ── CALL AI ──
    try {
      const prompt = this._buildCompactPrompt(signal, riskParams, marketContext);
      const response = await this._chat(prompt);
      const result = this._parseValidationResponse(response, signal);
      result.decisionSource = 'model';

      // Track
      this.callLog.push(Date.now());
      this.dedupeCache[dedupeKey] = Date.now();
      this.totalCalls++;
      this._trackDecision('model');

      logger.info(
        `[AI] ${result.approved ? 'APPROVED' : 'REJECTED'} | conf: ${result.confidence}% | ` +
          `${result.reason} | source: model | calls today: ${this.totalCalls} | skipped: ${this.totalSkipped}`
      );

      return result;
    } catch (err) {
      logger.error(`[AI] Error: ${err.message}`);
      return this._fallbackResult(signal, `Error: ${err.message}`, 'error');
    }
  }

  /**
   * Tiered fallback behavior when AI cannot decide (error/rate-limit).
   *
   * STRICT mode (default):
   * - confidence 50-65 → AUTO-REJECT (too uncertain to trust fallback)
   * - confidence 66-84 → APPROVE with penalty
   *
   * NORMAL mode:
   * - confidence 50-84 → APPROVE with penalty
   *
   * Penalty reduces confidence to discourage over-reliance on fallback.
   */
  _fallbackResult(signal, reason, source) {
    const { smartGateMin, smartGateMax, fallbackMode, fallbackPenalty, fallbackAllow } = config.ai;
    this._trackDecision(source);
    this.bypassCount++;
    this._maybeCheckBypassRate();

    // fallbackAllow=false → always reject
    if (!fallbackAllow) {
      return {
        approved: false,
        confidence: signal.confidence,
        sentiment: 'neutral',
        reason: `${reason} (fallback_allow=false)`,
        adjustedSignal: null,
        decisionSource: source,
      };
    }

    // Strict mode: reject the low-confidence grey zone
    const strictRejectCutoff = Math.floor((smartGateMin + smartGateMax) / 2); // default: 67
    if (fallbackMode === 'strict' && signal.confidence < strictRejectCutoff) {
      this._trackDecision('strict_reject');
      logger.warn(
        `[AI] STRICT REJECT: conf ${signal.confidence}% < ${strictRejectCutoff}% cutoff (source: ${source})`
      );
      return {
        approved: false,
        confidence: signal.confidence,
        sentiment: 'neutral',
        reason: `Strict fallback reject: ${reason}`,
        adjustedSignal: null,
        decisionSource: 'strict_reject',
      };
    }

    // Normal mode or strict-but-above-cutoff: approve with penalty
    const penalized = Math.max(signal.confidence - fallbackPenalty, 25);
    logger.info(
      `[AI] FALLBACK PASS: ${signal.confidence}% → ${penalized}% (-${fallbackPenalty}, source: ${source})`
    );
    return {
      approved: true,
      confidence: penalized,
      sentiment: 'neutral',
      reason: `${reason} — fallback pass (-${fallbackPenalty}%)`,
      adjustedSignal: null,
      decisionSource: source,
    };
  }

  _trackDecision(source) {
    if (!(source in this.decisionSources)) this.decisionSources[source] = 0;
    this.decisionSources[source] += 1;
  }

  _maybeCheckBypassRate() {
    const threshold = config.ai.bypassAlertThreshold;
    if (!threshold || this.decisionCount < 10) return;

    const pct = Math.round((this.bypassCount / this.decisionCount) * 100);
    if (pct > threshold && Date.now() - this.lastBypassAlert > 3600000) {
      logger.warn(
        `[AI] BYPASS RATE HIGH: ${pct}% (${this.bypassCount}/${this.decisionCount}) exceeds ${threshold}% threshold`
      );
      this.lastBypassAlert = Date.now();
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
      const safeSignal = {
        signal: originalSignal?.signal || 'UNKNOWN',
        confidence: Number.isFinite(Number(originalSignal?.confidence))
          ? Number(originalSignal.confidence)
          : config.ai.smartGateMin,
      };
      return this._fallbackResult(safeSignal, 'Parse error', 'error');
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

  _bypassResult(signal, reason, source = 'bypass') {
    this._trackDecision(source);
    return {
      approved: config.ai.fallbackAllow,
      confidence: signal.confidence,
      sentiment: 'neutral',
      reason,
      adjustedSignal: null,
      decisionSource: source,
    };
  }

  /**
   * Conservative confidence blending.
   * - Model decision: weighted blend (60% strategy, 40% AI).
   * - Fallback/bypass decision: use the lower confidence to avoid over-trusting non-model paths.
   */
  deriveFinalConfidence(strategyConfidence, aiResult) {
    const base = Math.max(0, Math.min(100, Number(strategyConfidence) || 0));
    // If AI confidence is missing/invalid, keep base instead of collapsing to 0.
    const aiRaw = Number(aiResult?.confidence);
    const aiConf = Number.isFinite(aiRaw)
      ? Math.max(0, Math.min(100, aiRaw))
      : base;
    const source = aiResult?.decisionSource || 'unknown';

    if (source === 'model') {
      // Conservative: blended score can only maintain/reduce base confidence, never inflate it.
      const blended = Math.round(base * 0.6 + aiConf * 0.4);
      return Math.min(base, blended);
    }

    return Math.min(base, aiConf);
  }

  /**
   * Get usage stats for logging/debugging.
   */
  getStats() {
    const bypassRate = this.decisionCount > 0
      ? Math.round((this.bypassCount / this.decisionCount) * 100)
      : 0;
    return {
      totalCalls: this.totalCalls,
      totalSkipped: this.totalSkipped,
      savingsPercent: this.totalCalls + this.totalSkipped > 0
        ? Math.round((this.totalSkipped / (this.totalCalls + this.totalSkipped)) * 100)
        : 0,
      callsThisHour: this.callLog.filter((t) => t > Date.now() - 3600000).length,
      bypassRate,
      decisionSources: { ...this.decisionSources },
    };
  }
}

module.exports = new AIAgent();
