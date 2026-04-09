const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * AI Agent Module — Minimax Integration
 *
 * Two main functions:
 * 1. Sentiment Analysis: Analyze gold market sentiment from recent price action
 * 2. Signal Validation: AI reviews the signal with full context before sending
 *
 * The AI acts as a final gate — it can CONFIRM, ADJUST, or REJECT a signal.
 */

class AIAgent {
  constructor() {
    this.enabled = false;
    this.sentimentCache = { data: null, ts: 0 };
    this.sentimentCacheTTL = 10 * 60 * 1000; // 10 min cache
  }

  init() {
    if (!config.ai.enabled) {
      logger.info('[AI Agent] Disabled via config');
      return;
    }

    if (!config.ai.minimax.apiKey) {
      logger.warn('[AI Agent] No Minimax API key configured — running in bypass mode');
      return;
    }

    this.enabled = true;
    logger.info(`[AI Agent] Minimax initialized (model: ${config.ai.minimax.model})`);
  }

  /**
   * Validate a trading signal using AI.
   * Returns { approved, confidence, reason, sentiment, adjustedSignal }
   */
  async validateSignal(signal, riskParams, marketContext) {
    if (!this.enabled) {
      return this._bypassResult(signal, 'AI agent disabled');
    }

    try {
      const prompt = this._buildValidationPrompt(signal, riskParams, marketContext);
      const response = await this._chat(prompt);
      const result = this._parseValidationResponse(response, signal);

      logger.info(
        `[AI Agent] Signal ${signal.signal} → ${result.approved ? 'APPROVED' : 'REJECTED'} ` +
          `| AI Confidence: ${result.confidence}% | ${result.reason}`
      );

      return result;
    } catch (err) {
      logger.error(`[AI Agent] Validation failed: ${err.message}`);
      return this._bypassResult(signal, `AI error: ${err.message}`);
    }
  }

  /**
   * Get market sentiment analysis from AI.
   */
  async analyzeSentiment(candles, newsEvents) {
    if (!this.enabled) {
      return { sentiment: 'neutral', score: 0, analysis: 'AI agent disabled' };
    }

    // Use cache if fresh
    if (Date.now() - this.sentimentCache.ts < this.sentimentCacheTTL && this.sentimentCache.data) {
      return this.sentimentCache.data;
    }

    try {
      const prompt = this._buildSentimentPrompt(candles, newsEvents);
      const response = await this._chat(prompt);
      const result = this._parseSentimentResponse(response);

      this.sentimentCache = { data: result, ts: Date.now() };
      logger.info(`[AI Agent] Sentiment: ${result.sentiment} (score: ${result.score})`);
      return result;
    } catch (err) {
      logger.error(`[AI Agent] Sentiment analysis failed: ${err.message}`);
      return { sentiment: 'neutral', score: 0, analysis: `Error: ${err.message}` };
    }
  }

  /**
   * Build the signal validation prompt.
   */
  _buildValidationPrompt(signal, riskParams, ctx) {
    const recentPrices = ctx.recentCandles
      .slice(-10)
      .map((c) => `  ${c.time}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`)
      .join('\n');

    return `You are a professional XAUUSD (Gold) trading analyst AI. Your job is to validate a trading signal before it is sent to a trader.

MARKET CONTEXT:
- Current Price: ${ctx.currentPrice.toFixed(2)}
- Timeframe: ${ctx.timeframe}
- Higher TF Trend: ${ctx.alignmentTrend}
- Session: ${ctx.session}
- RSI: ${ctx.rsi !== null ? ctx.rsi.toFixed(1) : 'N/A'}
- ATR: ${ctx.atr !== null ? ctx.atr.toFixed(2) : 'N/A'}
- EMA50: ${ctx.ema50 !== null ? ctx.ema50.toFixed(2) : 'N/A'}
- EMA200: ${ctx.ema200 !== null ? ctx.ema200.toFixed(2) : 'N/A'}
- Bollinger Upper: ${ctx.bbUpper !== null ? ctx.bbUpper.toFixed(2) : 'N/A'}
- Bollinger Lower: ${ctx.bbLower !== null ? ctx.bbLower.toFixed(2) : 'N/A'}

RECENT CANDLES (last 10):
${recentPrices}

SIGNAL TO VALIDATE:
- Direction: ${signal.signal}
- Strategy: ${signal.strategy}
- Confidence: ${signal.confidence}%
- Confluence: ${signal.confluence || 1} strategies agree
${signal.allStrategies ? `- Agreeing: ${signal.allStrategies}` : ''}

RISK PARAMETERS:
- Entry: ${riskParams.entryPrice}
- Stop Loss: ${riskParams.stopLoss}
- Take Profit 1: ${riskParams.takeProfit}
- Risk:Reward: ${riskParams.riskRewardRatio}

Analyze this signal and respond in EXACTLY this JSON format (no other text):
{
  "approved": true or false,
  "confidence": 0-100,
  "sentiment": "bullish" or "bearish" or "neutral",
  "reason": "Brief explanation (max 100 chars)",
  "adjustEntry": null or number,
  "adjustSL": null or number,
  "adjustTP": null or number
}

Rules:
- APPROVE if technical setup is solid and market context supports the direction
- REJECT if signal contradicts market structure, sentiment, or if risk is poor
- Adjust entry/SL/TP only if you see a clearly better level nearby
- Be decisive. Give clear yes/no.`;
  }

  /**
   * Build the sentiment analysis prompt.
   */
  _buildSentimentPrompt(candles, newsEvents) {
    const recent = candles.slice(-20);
    const priceData = recent
      .map((c) => `${c.time}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`)
      .join('\n');

    const firstClose = recent[0].close;
    const lastClose = recent[recent.length - 1].close;
    const change = ((lastClose - firstClose) / firstClose * 100).toFixed(2);

    const highestHigh = Math.max(...recent.map((c) => c.high));
    const lowestLow = Math.min(...recent.map((c) => c.low));

    const newsStr = newsEvents && newsEvents.length > 0
      ? newsEvents.map((e) => `- ${e.title} (${e.impact}) at ${e.time}`).join('\n')
      : 'No upcoming high-impact events';

    return `You are a Gold (XAUUSD) market sentiment analyst. Analyze the current market conditions.

PRICE DATA (last 20 candles):
${priceData}

STATISTICS:
- Price Change: ${change}%
- Range High: ${highestHigh.toFixed(2)}
- Range Low: ${lowestLow.toFixed(2)}
- Current: ${lastClose.toFixed(2)}

UPCOMING NEWS EVENTS:
${newsStr}

Respond in EXACTLY this JSON format (no other text):
{
  "sentiment": "bullish" or "bearish" or "neutral",
  "score": -100 to 100 (negative=bearish, positive=bullish),
  "analysis": "Brief market analysis (max 150 chars)",
  "keyLevels": {
    "support": number,
    "resistance": number
  },
  "recommendation": "BUY" or "SELL" or "WAIT"
}`;
  }

  /**
   * Call Minimax chat completion API.
   */
  async _chat(prompt) {
    const { apiKey, groupId, model, baseUrl } = config.ai.minimax;

    const url = `${baseUrl}/text/chatcompletion_v2`;

    const resp = await axios.post(
      url,
      {
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a professional quantitative trading analyst specializing in XAUUSD (Gold). Respond only in valid JSON format.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    if (resp.data.base_resp && resp.data.base_resp.status_code !== 0) {
      throw new Error(`Minimax API error: ${resp.data.base_resp.status_msg}`);
    }

    const content = resp.data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from Minimax');
    }

    return content;
  }

  /**
   * Parse the AI validation response.
   */
  _parseValidationResponse(text, originalSignal) {
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(jsonStr);

      const result = {
        approved: Boolean(data.approved),
        confidence: Math.max(0, Math.min(100, parseInt(data.confidence) || 0)),
        sentiment: data.sentiment || 'neutral',
        reason: String(data.reason || 'No reason given').slice(0, 200),
        adjustedSignal: null,
      };

      // Apply confidence threshold
      if (result.confidence < config.ai.minConfidence) {
        result.approved = false;
        result.reason = `AI confidence too low (${result.confidence}% < ${config.ai.minConfidence}% threshold)`;
      }

      // Build adjusted signal if AI suggests changes
      if (result.approved && (data.adjustEntry || data.adjustSL || data.adjustTP)) {
        result.adjustedSignal = {};
        if (data.adjustEntry && typeof data.adjustEntry === 'number') {
          result.adjustedSignal.entryPrice = Math.round(data.adjustEntry * 100) / 100;
        }
        if (data.adjustSL && typeof data.adjustSL === 'number') {
          result.adjustedSignal.stopLoss = Math.round(data.adjustSL * 100) / 100;
        }
        if (data.adjustTP && typeof data.adjustTP === 'number') {
          result.adjustedSignal.takeProfit = Math.round(data.adjustTP * 100) / 100;
        }
      }

      return result;
    } catch (err) {
      logger.warn(`[AI Agent] Failed to parse response: ${err.message}`);
      logger.debug(`[AI Agent] Raw response: ${text}`);
      // If parse fails, let the signal through with a warning
      return {
        approved: config.ai.fallbackAllow,
        confidence: 50,
        sentiment: 'neutral',
        reason: 'AI response parse error — fallback mode',
        adjustedSignal: null,
      };
    }
  }

  /**
   * Parse sentiment response.
   */
  _parseSentimentResponse(text) {
    try {
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(jsonStr);

      return {
        sentiment: data.sentiment || 'neutral',
        score: Math.max(-100, Math.min(100, parseInt(data.score) || 0)),
        analysis: String(data.analysis || '').slice(0, 300),
        keyLevels: data.keyLevels || null,
        recommendation: data.recommendation || 'WAIT',
      };
    } catch (err) {
      logger.warn(`[AI Agent] Sentiment parse error: ${err.message}`);
      return { sentiment: 'neutral', score: 0, analysis: 'Parse error' };
    }
  }

  /**
   * Bypass result when AI is disabled or fails.
   */
  _bypassResult(signal, reason) {
    return {
      approved: config.ai.fallbackAllow,
      confidence: signal.confidence,
      sentiment: 'neutral',
      reason,
      adjustedSignal: null,
    };
  }
}

module.exports = new AIAgent();
