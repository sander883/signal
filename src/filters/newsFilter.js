const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

/**
 * NEWS FILTER - MANDATORY
 *
 * This filter blocks all signal generation during high-impact economic events.
 * It fetches economic calendar data and checks if any USD-impacting high-impact
 * events are scheduled within the configured buffer window.
 *
 * Data Sources (tried in order):
 * 1. ForexFactory calendar (XML/HTML scraping)
 * 2. FXStreet economic calendar API
 * 3. Fallback: Hardcoded known recurring events (NFP, FOMC, CPI)
 *
 * Filter Logic:
 * - Fetches today's high-impact USD news events
 * - For each event, creates a "blocked window":
 *   [event_time - buffer_before, event_time + buffer_after]
 * - If current time falls within ANY blocked window, trading is blocked
 */

class NewsFilter {
  constructor() {
    this.events = [];
    this.lastFetch = 0;
    this.lastSuccessfulFetch = 0; // last time we got REAL (non-fallback) data
    this.lastSourceOk = false;
    this.fetchInterval = 30 * 60 * 1000; // Refresh every 30 minutes
    this.isBlocked = false;
    this.blockReason = '';
  }

  /**
   * Freshness status based on last successful (real) fetch.
   * - fresh     : < 30 min
   * - degraded  : 30-120 min
   * - stale     : > 120 min
   */
  getFreshnessStatus() {
    if (!this.lastSuccessfulFetch) return 'unknown';
    const ageMin = (Date.now() - this.lastSuccessfulFetch) / 60000;
    if (ageMin < 30) return 'fresh';
    if (ageMin < 120) return 'degraded';
    return 'stale';
  }

  /**
   * Main check: Is trading currently blocked by news?
   * @returns {Promise<{blocked: boolean, reason: string, nextEvent: Object|null}>}
   */
  async check() {
    if (!config.newsFilter.enabled) {
      return { blocked: false, reason: 'News filter disabled', nextEvent: null };
    }

    // Refresh events periodically
    if (Date.now() - this.lastFetch > this.fetchInterval) {
      await this.fetchEvents();
    }

    const now = new Date();
    const freshness = this.getFreshnessStatus();

    // Widen buffers automatically when source is degraded/stale
    // (we're less certain about exact event times, be more conservative)
    let bufferMultiplier = 1;
    if (freshness === 'degraded') bufferMultiplier = 1.5;
    else if (freshness === 'stale' || freshness === 'unknown') bufferMultiplier = 2;

    const bufferBefore = config.newsFilter.bufferBeforeMin * 60 * 1000 * bufferMultiplier;
    const bufferAfter = config.newsFilter.bufferAfterMin * 60 * 1000 * bufferMultiplier;

    if (bufferMultiplier > 1) {
      logger.warn(
        `[News] Freshness: ${freshness} → buffers widened ${bufferMultiplier}x`
      );
    }

    let blocked = false;
    let reason = '';
    let nextEvent = null;
    let nearestTime = Infinity;

    for (const event of this.events) {
      const eventTime = new Date(event.time);
      const windowStart = new Date(eventTime.getTime() - bufferBefore);
      const windowEnd = new Date(eventTime.getTime() + bufferAfter);

      // Currently in blocked window?
      if (now >= windowStart && now <= windowEnd) {
        blocked = true;
        reason = `NEWS BLOCK ACTIVE: ${event.title} (${event.impact}) at ${eventTime.toUTCString()}`;

        if (now < eventTime) {
          reason += ` | Starts in ${Math.round((eventTime - now) / 60000)} min`;
        } else {
          reason += ` | Released ${Math.round((now - eventTime) / 60000)} min ago`;
        }

        nextEvent = event;
        break;
      }

      // Track nearest upcoming event
      const timeUntil = eventTime.getTime() - now.getTime();
      if (timeUntil > 0 && timeUntil < nearestTime) {
        nearestTime = timeUntil;
        nextEvent = event;
      }
    }

    this.isBlocked = blocked;
    this.blockReason = reason;

    if (blocked) {
      logger.warn(reason);
    } else if (nextEvent) {
      const minutesUntil = Math.round(nearestTime / 60000);
      logger.info(`Next high-impact news: ${nextEvent.title} in ${minutesUntil} min`);
    }

    return { blocked, reason, nextEvent };
  }

  /**
   * Fetch economic events from multiple sources.
   */
  async fetchEvents() {
    logger.info('Fetching economic calendar events...');

    try {
      // Try primary source: Forex Factory style via noebs/FXCalendar API
      const events = await this._fetchFromForexFactory();
      if (events.length > 0) {
        this.events = this._sortAndNormalize(events);
        this.lastFetch = Date.now();
        this.lastSuccessfulFetch = Date.now();
        this.lastSourceOk = true;
        logger.info(`Loaded ${events.length} high-impact events (source: ForexFactory)`);
        return;
      }
    } catch (err) {
      logger.warn(`ForexFactory fetch failed: ${err.message}`);
    }

    try {
      // Fallback: construct events from known schedule
      const events = this._getKnownScheduledEvents();
      this.events = this._sortAndNormalize(events);
      this.lastFetch = Date.now();
      this.lastSourceOk = false; // fallback data, don't mark as successful source
      logger.warn(`Using ${events.length} known scheduled events (fallback, source unreliable)`);
    } catch (err) {
      logger.error(`All news sources failed: ${err.message}`);
      // SAFETY: If we can't fetch news, block trading as precaution
      this.events = [
        {
          title: 'UNKNOWN - News data unavailable (safety block)',
          impact: 'High',
          currency: 'USD',
          time: new Date().toISOString(),
        },
      ];
      this.lastFetch = Date.now();
    }
  }

  /**
   * Fetch from a public economic calendar API.
   * Uses the Forex Factory calendar endpoint.
   */
  async _fetchFromForexFactory() {
    // Use the public ForexFactory weekly JSON calendar
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday

    const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

    const resp = await axios.get(url, { timeout: 10000 });
    const data = resp.data;

    if (!Array.isArray(data)) {
      throw new Error('Invalid calendar data format');
    }

    // Filter for high-impact USD events
    const highImpact = data
      .filter((event) => {
        const isUSD = event.country === 'USD';
        const isHigh = event.impact === 'High';
        const isRelevant = this._isHighImpactEvent(event.title);
        return isUSD && (isHigh || isRelevant);
      })
      .map((event) => ({
        title: event.title,
        impact: event.impact,
        currency: event.country,
        time: event.date,
        forecast: event.forecast,
        previous: event.previous,
      }));

    return highImpact;
  }

  /**
   * Check if event title matches high-impact keywords.
   */
  _isHighImpactEvent(title) {
    if (!title) return false;
    const titleLower = title.toLowerCase();
    return config.newsFilter.highImpactKeywords.some((kw) =>
      titleLower.includes(kw.toLowerCase())
    );
  }

  /**
   * Fallback: Generate known recurring economic events.
   * These are approximate dates for major events.
   */
  _getKnownScheduledEvents() {
    const now = new Date();
    const events = [];

    // NFP: First Friday of the month at 13:30 UTC
    const nfpDate = this._getFirstWeekday(now.getFullYear(), now.getMonth(), 5); // Friday
    nfpDate.setUTCHours(13, 30, 0, 0);
    if (this._isWithinDays(nfpDate, 2)) {
      events.push({
        title: 'Non-Farm Payrolls (NFP)',
        impact: 'High',
        currency: 'USD',
        time: nfpDate.toISOString(),
      });
    }

    // CPI: Usually around 10th-15th of month at 13:30 UTC
    const cpiDate = new Date(now.getFullYear(), now.getMonth(), 13);
    cpiDate.setUTCHours(13, 30, 0, 0);
    if (this._isWithinDays(cpiDate, 2)) {
      events.push({
        title: 'CPI - Consumer Price Index',
        impact: 'High',
        currency: 'USD',
        time: cpiDate.toISOString(),
      });
    }

    // FOMC: 8 meetings per year, roughly every 6 weeks. Wed at 19:00 UTC
    // We check if today is a potential FOMC day (Wed, mid-month)
    if (now.getDay() === 3 && now.getDate() >= 12 && now.getDate() <= 20) {
      const fomcDate = new Date(now);
      fomcDate.setUTCHours(19, 0, 0, 0);
      events.push({
        title: 'FOMC Interest Rate Decision',
        impact: 'High',
        currency: 'USD',
        time: fomcDate.toISOString(),
      });
    }

    // GDP: Last Thursday of month at 13:30 UTC
    const gdpDate = this._getLastWeekday(now.getFullYear(), now.getMonth(), 4); // Thursday
    gdpDate.setUTCHours(13, 30, 0, 0);
    if (this._isWithinDays(gdpDate, 2)) {
      events.push({
        title: 'GDP (Gross Domestic Product)',
        impact: 'High',
        currency: 'USD',
        time: gdpDate.toISOString(),
      });
    }

    // Jobless Claims: Every Thursday at 13:30 UTC
    if (now.getDay() === 4) {
      const claimsDate = new Date(now);
      claimsDate.setUTCHours(13, 30, 0, 0);
      events.push({
        title: 'Initial Jobless Claims',
        impact: 'High',
        currency: 'USD',
        time: claimsDate.toISOString(),
      });
    }

    return events;
  }

  _getFirstWeekday(year, month, dayOfWeek) {
    const date = new Date(year, month, 1);
    while (date.getDay() !== dayOfWeek) {
      date.setDate(date.getDate() + 1);
    }
    return date;
  }

  _getLastWeekday(year, month, dayOfWeek) {
    const date = new Date(year, month + 1, 0); // Last day of month
    while (date.getDay() !== dayOfWeek) {
      date.setDate(date.getDate() - 1);
    }
    return date;
  }

  _isWithinDays(eventDate, days) {
    const diff = Math.abs(Date.now() - eventDate.getTime());
    return diff < days * 24 * 60 * 60 * 1000;
  }

  /**
   * Sort events ascending by time and normalize timestamps to UTC ISO strings.
   * Filters out invalid/unparseable timestamps.
   */
  _sortAndNormalize(events) {
    return events
      .map((e) => {
        const t = new Date(e.time);
        if (Number.isNaN(t.getTime())) return null;
        return { ...e, time: t.toISOString() };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  /**
   * Get a summary of today's events for Telegram notification.
   */
  getSummary() {
    if (this.events.length === 0) return 'No high-impact news events loaded.';

    const today = new Date().toISOString().split('T')[0];
    const todayEvents = this.events.filter((e) => e.time && e.time.startsWith(today));

    if (todayEvents.length === 0) return 'No high-impact news events today.';

    let summary = `📰 Today's High-Impact Events (${todayEvents.length}):\n`;
    for (const event of todayEvents) {
      const time = new Date(event.time).toUTCString().split(' ')[4];
      summary += `  ⚠️ ${time} UTC - ${event.title}\n`;
    }
    return summary;
  }
}

module.exports = new NewsFilter();
