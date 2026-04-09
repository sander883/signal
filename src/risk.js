const config = require('./config');
const indicators = require('./indicators');
const logger = require('./logger');

/**
 * Risk Management Module
 *
 * Calculates:
 * - ATR-based Stop Loss
 * - Take Profit based on Risk:Reward ratio
 * - Position sizing based on risk percentage
 * - Trailing stop levels
 * - Break-even levels
 */

class RiskManager {
  /**
   * Calculate stop loss, take profit, and position info for a signal.
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

    let stopLoss, takeProfit, takeProfit2, takeProfit3;

    if (direction === 'BUY') {
      stopLoss = entryPrice - atr * slMultiplier;
      takeProfit = entryPrice + atr * slMultiplier * rrRatio;          // TP1 (1:2)
      takeProfit2 = entryPrice + atr * slMultiplier * (rrRatio + 1);   // TP2 (1:3)
      takeProfit3 = entryPrice + atr * slMultiplier * (rrRatio + 2);   // TP3 (1:4)
    } else {
      stopLoss = entryPrice + atr * slMultiplier;
      takeProfit = entryPrice - atr * slMultiplier * rrRatio;
      takeProfit2 = entryPrice - atr * slMultiplier * (rrRatio + 1);
      takeProfit3 = entryPrice - atr * slMultiplier * (rrRatio + 2);
    }

    const slDistance = Math.abs(entryPrice - stopLoss);
    const tpDistance = Math.abs(takeProfit - entryPrice);

    // Pip value for XAUUSD (1 pip = $0.01, 1 lot = 100 oz)
    const pipValue = 0.01;
    const lotPipValue = 1; // $1 per pip per 1 lot for XAUUSD

    // Position size based on risk
    // risk$ = account_balance * risk_percent / 100
    // lots = risk$ / (sl_pips * pip_value_per_lot)
    const slPips = slDistance / pipValue;

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
    };

    // Trailing stop info
    if (config.risk.trailingStopEnabled) {
      result.trailingStop = {
        enabled: true,
        activationDistance: this._round(tpDistance * 0.5), // Activate at 50% of TP
        trailDistance: this._round(slDistance * 0.5),       // Trail at 50% of SL
      };
    }

    // Break-even info
    if (config.risk.breakEvenEnabled) {
      result.breakEven = {
        enabled: true,
        activationDistance: this._round(slDistance * 1.5), // Move SL to BE after 1.5x SL distance
      };
    }

    logger.info(
      `[Risk] ${direction} @ ${result.entryPrice} | SL: ${result.stopLoss} | ` +
        `TP1: ${result.takeProfit} | TP2: ${result.takeProfit2} | ` +
        `RR: ${result.riskRewardRatio} | ATR: ${result.atr}`
    );

    return result;
  }

  /**
   * Validate that risk parameters are reasonable.
   */
  validate(riskParams) {
    if (!riskParams) return false;

    const { entryPrice, stopLoss, takeProfit, direction } = riskParams;

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

    return true;
  }

  _round(val) {
    return Math.round(val * 100) / 100;
  }
}

module.exports = new RiskManager();
