const config = require('../config');
const logger = require('../logger');

/**
 * Session Filter
 *
 * Only allows trading during active market sessions:
 * - London Session:   07:00 - 16:00 UTC
 * - New York Session: 12:00 - 21:00 UTC
 * - Overlap (best):   12:00 - 16:00 UTC
 *
 * Blocks trading during:
 * - Asian session (low gold volatility)
 * - Market rollover (00:00 - 01:00 UTC)
 * - Weekend (Saturday/Sunday)
 */

class SessionFilter {
  /**
   * Check if current time is within an active trading session.
   * @returns {{allowed: boolean, session: string, reason: string}}
   */
  check() {
    if (!config.sessionFilter.enabled) {
      return { allowed: true, session: 'all', reason: 'Session filter disabled' };
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

    // Rollover period (avoid)
    if (utcHour >= 0 && utcHour < 1) {
      const reason = 'Market rollover period (00:00-01:00 UTC)';
      logger.info(`[Session Filter] ${reason}`);
      return { allowed: false, session: 'rollover', reason };
    }

    const { london, newYork } = config.sessionFilter;

    // London + New York overlap (best time)
    if (utcHour >= newYork.start && utcHour < london.end) {
      return {
        allowed: true,
        session: 'london-newyork-overlap',
        reason: 'London/NY overlap - optimal trading',
      };
    }

    // London session
    if (utcHour >= london.start && utcHour < london.end) {
      return {
        allowed: true,
        session: 'london',
        reason: 'London session active',
      };
    }

    // New York session
    if (utcHour >= newYork.start && utcHour < newYork.end) {
      return {
        allowed: true,
        session: 'newyork',
        reason: 'New York session active',
      };
    }

    // Outside active sessions (Asian / late NY)
    const reason = `Outside active sessions (current UTC hour: ${utcHour})`;
    logger.info(`[Session Filter] ${reason}`);
    return { allowed: false, session: 'inactive', reason };
  }

  /**
   * Get the current session name for display.
   */
  getCurrentSession() {
    const now = new Date();
    const h = now.getUTCHours();

    if (h >= 12 && h < 16) return 'London/NY Overlap';
    if (h >= 7 && h < 16) return 'London';
    if (h >= 12 && h < 21) return 'New York';
    if (h >= 0 && h < 7) return 'Asian (inactive)';
    return 'Off-hours';
  }
}

module.exports = new SessionFilter();
