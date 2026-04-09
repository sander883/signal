const config = require('./config');
const indicators = require('./indicators');
const logger = require('./logger');

/**
 * Risk Management Module
 *
 * Calculates:
 * - ATR-based Stop Loss
 * - Take Profit based on Risk:Reward ratio
 * - Position sizing (lot size) based on risk percentage
 * - Trailing stop levels
 * - Break-even levels
 */

// XAUUSD pip/lot constants
const PIP_SIZE = 0.01;           // 1 pip = $0.01 price movement
const LOT_PIP_VALUE = 1.0;       // $1 per pip per standard lot (100 oz)
const MIN_LOT = 0.01;
const MAX_LOT = 100;

class RiskManager {
  /**
   * Calculate stop loss, take profit, position size, and risk info.
   * @param {string} direction - 'BUY' or 'SELL'
   * @param {number} entryPrice - Current entry price
   * @param {Array} atrValues - ATR array from indicators
   * @param {Object} options - Optional overrides
   * @returns {Object} risk parameters
   */
  calculate(direction, entryPrice, atrValues, options = {}) {
    const atr = indicators.latest(atrValues);
    if (!atr || !entryPrice) {
      logger.error('Cannot calculate risk: missing ATR or entry price');
      return null;
    }

    const slMultiplier = options.slMultiplier || config.risk.atrMultiplierSL;
    const rrRatio = options.rrRatio || config.rewardRatio;
    const riskPercent = options.riskPercent || config.riskPercent;
    const accountBalance = options.accountBalance || config.risk.accountBalance;
    const spread = options.spread || config.risk.spreadPoints;

    let stopLoss, takeProfit, takeProfit2, takeProfit3;

    if (direction === 'BUY') {
      stopLoss = entryPrice - atr * slMultiplier;
      takeProfit = entryPrice + atr * slMultiplier * rrRatio;
      takeProfit2 = entryPrice + atr * slMultiplier * (rrRatio + 1);
      takeProfit3 = entryPrice + atr * slMultiplier * (rrRatio + 2);
    } else {
      stopLoss = entryPrice + atr * slMultiplier;
      takeProfit = entryPrice - atr * slMultiplier * rrRatio;
      takeProfit2 = entryPrice - atr * slMultiplier * (rrRatio + 1);
      takeProfit3 = entryPrice - atr * slMultiplier * (rrRatio + 2);
    }

    const slDistance = Math.abs(entryPrice - stopLoss);
    const tpDistance = Math.abs(takeProfit - entryPrice);
    const slPips = slDistance / PIP_SIZE;

    // ── Position Sizing ──
    // risk$ = balance * risk% / 100
    // lots = risk$ / (sl_pips * pip_value_per_lot)
    const riskAmount = accountBalance * (riskPercent / 100);
    const rawLots = slPips > 0 ? riskAmount / (slPips * LOT_PIP_VALUE) : 0;
    const lots = Math.max(MIN_LOT, Math.min(MAX_LOT, Math.floor(rawLots * 100) / 100)); // round down to 0.01

    const result = {
      direction,
      entryPrice: this._round(entryPrice),
      stopLoss: this._round(stopLoss),
      takeProfit: this._round(takeProfit),
      takeProfit2: this._round(takeProfit2),
      takeProfit3: this._round(takeProfit3),
      slDistance: this._round(slDistance),
      tpDistance: this._round(tpDistance),
      riskRewardRatio: `1:${rrRatio}`,
      atr: this._round(atr),
      slPips: Math.round(slPips),
      riskPercent,

      // Position sizing
      accountBalance,
      riskAmount: this._round(riskAmount),
      lots,
      potentialLoss: this._round(lots * slPips * LOT_PIP_VALUE),
      potentialProfit: this._round(lots * (tpDistance / PIP_SIZE) * LOT_PIP_VALUE),

      // Spread info
      spread,
      spreadCost: this._round(lots * (spread / PIP_SIZE) * LOT_PIP_VALUE),
    };

    // Trailing stop
    if (config.risk.trailingStopEnabled) {
      result.trailingStop = {
        enabled: true,
        activationDistance: this._round(tpDistance * 0.5),
        trailDistance: this._round(slDistance * 0.5),
      };
    }

    // Break-even
    if (config.risk.breakEvenEnabled) {
      result.breakEven = {
        enabled: true,
        activationDistance: this._round(slDistance * 1.5),
      };
    }

    logger.info(
      `[Risk] ${direction} @ ${result.entryPrice} | SL: ${result.stopLoss} | ` +
        `TP1: ${result.takeProfit} | Lots: ${lots} | Risk: $${result.riskAmount} | ` +
        `RR: ${result.riskRewardRatio} | ATR: ${result.atr}`
    );

    return result;
  }

  /**
   * Validate that risk parameters are reasonable.
   */
  validate(riskParams) {
    if (!riskParams) return false;

    const { entryPrice, stopLoss, takeProfit, direction, lots } = riskParams;

    // SL must be on correct side
    if (direction === 'BUY' && stopLoss >= entryPrice) return false;
    if (direction === 'SELL' && stopLoss <= entryPrice) return false;

    // TP must be on correct side
    if (direction === 'BUY' && takeProfit <= entryPrice) return false;
    if (direction === 'SELL' && takeProfit >= entryPrice) return false;

    // SL distance shouldn't exceed 2% of price
    const slPercent = (riskParams.slDistance / entryPrice) * 100;
    if (slPercent > 2) {
      logger.warn(`[Risk] SL too wide: ${slPercent.toFixed(2)}% of price`);
      return false;
    }

    // Lot size sanity check
    if (lots < MIN_LOT) {
      logger.warn(`[Risk] Lot size too small: ${lots}`);
      return false;
    }

    return true;
  }

  _round(val) {
    return Math.round(val * 100) / 100;
  }
}

module.exports = new RiskManager();
