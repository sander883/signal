const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logger = require('./logger');

class TelegramService {
  constructor() {
    this.bot = null;
    this.enabled = false;
  }

  /**
   * Initialize the Telegram bot.
   */
  init() {
    if (!config.telegram.botToken || !config.telegram.chatId) {
      logger.warn('Telegram not configured - alerts will only be logged');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
      this.enabled = true;
      logger.info('Telegram bot initialized successfully');
    } catch (err) {
      logger.error(`Telegram init failed: ${err.message}`);
    }
  }

  /**
   * Send a trading signal alert.
   */
  async sendSignal(signal, riskParams, timeframe) {
    const emoji = signal.signal === 'BUY' ? '🟢' : '🔴';
    const arrow = signal.signal === 'BUY' ? '⬆️' : '⬇️';

    const message = `
${emoji} *XAUUSD ${signal.signal} SIGNAL* ${arrow}

📊 *Strategy:* ${signal.strategy}
${signal.allStrategies ? `🔗 *Confluence:* ${signal.allStrategies}` : ''}
⏱ *Timeframe:* ${timeframe}
📈 *Confidence:* ${signal.confidence}%
${signal.confluence ? `🎯 *Strategies Agreeing:* ${signal.confluence}` : ''}

💰 *Entry:* ${riskParams.entryPrice}
🛑 *Stop Loss:* ${riskParams.stopLoss}
✅ *Take Profit 1:* ${riskParams.takeProfit} (${riskParams.riskRewardRatio})
✅ *Take Profit 2:* ${riskParams.takeProfit2} (1:${parseInt(riskParams.riskRewardRatio.split(':')[1]) + 1})
✅ *Take Profit 3:* ${riskParams.takeProfit3}

📏 *SL Distance:* ${riskParams.slDistance} (${riskParams.slPips} pips)
📐 *ATR:* ${riskParams.atr}
⚠️ *Risk:* ${riskParams.riskPercent}% ($${riskParams.riskAmount})
📦 *Lot Size:* ${riskParams.lots}
💵 *Potential Profit:* $${riskParams.potentialProfit} | Loss: $${riskParams.potentialLoss}

${riskParams.trailingStop?.enabled ? '🔄 *Trailing Stop:* Active' : ''}
${riskParams.breakEven?.enabled ? '⚖️ *Break Even:* Active' : ''}
${signal.aiConfidence ? `\n🤖 *AI Validation:* ${signal.aiConfidence}% (${signal.aiSentiment})\n💬 ${signal.aiReason}` : ''}

🕐 ${new Date().toUTCString()}
    `.trim();

    await this._send(message);
  }

  /**
   * Send a news block notification.
   */
  async sendNewsBlock(reason) {
    const message = `
⚠️ *TRADING PAUSED - NEWS FILTER*

🚫 Signal generation blocked
📰 ${reason}

⏳ Trading will resume after the news buffer period ends.

���� ${new Date().toUTCString()}
    `.trim();

    await this._send(message);
  }

  /**
   * Send session filter notification.
   */
  async sendSessionBlock(reason) {
    const message = `
🕐 *SESSION FILTER ACTIVE*

${reason}

Trading will resume during London or New York session.
    `.trim();

    await this._send(message);
  }

  /**
   * Send AI rejection notification.
   */
  async sendAIReject(signal, aiResult, timeframe) {
    const message = `
🤖 *AI SIGNAL REVIEW — REJECTED*

❌ ${signal.signal} signal rejected by AI
📊 Strategy: ${signal.strategy}
⏱ Timeframe: ${timeframe}
📈 Strategy Confidence: ${signal.confidence}%
🤖 AI Confidence: ${aiResult.confidence}%
🧠 Sentiment: ${aiResult.sentiment}
💬 Reason: ${aiResult.reason}

🕐 ${new Date().toUTCString()}
    `.trim();

    await this._send(message);
  }

  /**
   * Send daily summary.
   */
  async sendDailySummary(stats) {
    const message = `
📊 *DAILY SUMMARY - XAUUSD*

📈 Signals Generated: ${stats.totalSignals}
🟢 Buy Signals: ${stats.buySignals}
🔴 Sell Signals: ${stats.sellSignals}
🚫 Blocked by News: ${stats.newsBlocked}
🕐 Blocked by Session: ${stats.sessionBlocked}
🤖 Rejected by AI: ${stats.aiRejected || 0}
📊 Avg Confidence: ${stats.avgConfidence}%

🏆 Top Strategy: ${stats.topStrategy || 'N/A'}

🕐 ${new Date().toUTCString()}
    `.trim();

    await this._send(message);
  }

  /**
   * Send startup notification.
   */
  async sendStartup() {
    const strategies = Object.entries(config.strategies)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');

    const tfList = config.timeframes.join(', ');

    const message = `
🚀 *XAUUSD Signal Bot Started*

⚙️ *Configuration:*
📊 Timeframes: ${tfList}
🔧 Strategies: ${strategies}
📰 News Filter: ${config.newsFilter.enabled ? '✅ ON' : '❌ OFF'}
🕐 Session Filter: ${config.sessionFilter.enabled ? '✅ ON' : '❌ OFF'}
🤖 AI Agent: ${config.ai.enabled && config.ai.minimax.apiKey ? '✅ Minimax (' + config.ai.minimax.model + ')' : '❌ OFF'}
⚠️ Risk: ${config.riskPercent}% | RR: 1:${config.rewardRatio}

🕐 ${new Date().toUTCString()}
    `.trim();

    await this._send(message);
  }

  /**
   * Send a raw text message.
   */
  async sendMessage(text) {
    await this._send(text);
  }

  /**
   * Internal send with retry and error handling.
   */
  async _send(message, retries = 3) {
    // Always log the message
    logger.info(`[Telegram] ${message.replace(/\*/g, '').replace(/\n/g, ' | ')}`);

    if (!this.enabled || !this.bot) return;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.bot.sendMessage(config.telegram.chatId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        return;
      } catch (err) {
        logger.error(`Telegram send failed (attempt ${attempt}/${retries}): ${err.message}`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
  }
}

module.exports = new TelegramService();
