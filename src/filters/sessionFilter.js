const config = require('../config');
const logger = require('../logger');

/**
 * Session Filter
 *
 * Active sessions for gold trading:
 * - Asian Session:    00:00 - 08:00 UTC (Tokyo/Sydney — lower volatility)
 * - London Session:   07:00 - 16:00 UTC
 * - New York Session: 12:00 - 21:00 UTC
 * - London/NY Overlap: 12:00 - 16:00 UTC (best time)
 *
 * Blocks trading during:
 * - Market rollover (00:00 - 01:00 UTC)
 * - Weekend (Saturday/Sunday)
 * - Friday late session (20:00+ UTC)
 *
 * Asian session is allowed but signals get a confidence penalty
 * because gold volatility is typically lower during Asian hours.
 */

class SessionFilter {
  /**
   * Check if current time is within an active trading session.
   * @returns {{allowed: boolean, session: string, reason: string, confPenalty?: number}}
   */
  check() {
    if (!config.sessionFilter.enabled) {
      return { allowed: true, session: 'all', reason: 'Session filter disabled', confPenalty: 0 };
    }

    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat

    // Weekend check
    if (utcDay === 0 || utcDay === 6) {
      const reason = 'Market closed (weekend)';
      logger.info(`[Session Filter] ${reason}`);
      return { allowed: false, session: 'weekend', reason };
    }

    // Friday late session — liquidity drops, wider spreads
    if (utcDay === 5 && utcHour >= 20) {
      const reason = 'Friday late session — market closing';
      logger.info(`[Session Filter] ${reason}`);
      return { allowed: false, session: 'friday-close', reason };
    }

    // Rollover period (avoid)
    if (utcHour >= 0 && utcHour < 1) {
      const reason = 'Market rollover period (00:00-01:00 UTC)';
      logger.info(`[Session Filter] ${reason}`);
      return { allowed: false, session: 'rollover', reason };
    }

    const { asian, london, newYork, asianEnabled, asianConfPenalty } = config.sessionFilter;

    // Compute London/NY overlap dynamically
    const overlapStart = Math.max(london.start, newYork.start);
    const overlapEnd = Math.min(london.end, newYork.end);

    // London + New York overlap (best time for gold)
    if (overlapStart < overlapEnd && utcHour >= overlapStart && utcHour < overlapEnd) {
      return {
        allowed: true,
        session: 'london-newyork-overlap',
        reason: `London/NY overlap (${overlapStart}:00-${overlapEnd}:00 UTC) — optimal`,
        confPenalty: 0,
      };
    }

    // London session
    if (utcHour >= london.start && utcHour < london.end) {
      return {
        allowed: true,
        session: 'london',
        reason: 'London session active',
        confPenalty: 0,
      };
    }

    // New York session
    if (utcHour >= newYork.start && utcHour < newYork.end) {
      return {
        allowed: true,
        session: 'newyork',
        reason: 'New York session active',
        confPenalty: 0,
      };
    }

    // Asian session (allowed with confidence penalty)
    if (asianEnabled && utcHour >= asian.start && utcHour < asian.end) {
      return {
        allowed: true,
        session: 'asian',
        reason: `Asian session active (Tokyo/Sydney) — lower volatility, -${asianConfPenalty}% confidence`,
        confPenalty: asianConfPenalty,
      };
    }

    // Outside active sessions
    const reason = `Outside active sessions (UTC ${utcHour}:00)`;
    logger.info(`[Session Filter] ${reason}`);
    return { allowed: false, session: 'inactive', reason };
  }

  /**
   * Get the current session name for display.
   */
  getCurrentSession() {
    const { asian, london, newYork } = config.sessionFilter;
    const now = new Date();
    const h = now.getUTCHours();

    const overlapStart = Math.max(london.start, newYork.start);
    const overlapEnd = Math.min(london.end, newYork.end);

    if (h >= overlapStart && h < overlapEnd) return 'London/NY Overlap';
    if (h >= london.start && h < london.end) return 'London';
    if (h >= newYork.start && h < newYork.end) return 'New York';
    if (h >= asian.start && h < asian.end) return 'Asian (Tokyo/Sydney)';
    return 'Off-hours';
  }
}

module.exports = new SessionFilter();
