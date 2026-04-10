const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Lightweight JSON state persistence.
 *
 * Purpose: survive bot restarts without "forgetting" critical state like
 * duplicate cooldowns, running metrics, and open paper positions.
 *
 * Storage: single JSON file at state/bot-state.json (gitignored).
 * Write strategy: atomic (write temp + rename) to avoid corruption mid-write.
 */

const STATE_DIR = path.join(process.cwd(), 'state');
const STATE_FILE = path.join(STATE_DIR, 'bot-state.json');
const TMP_FILE = STATE_FILE + '.tmp';

class StateStore {
  constructor() {
    this.data = {
      version: 1,
      lastSignalSent: {},      // { "15min": { direction, time, price } }
      metricCounters: {},      // carries over across restarts
      paperPositions: [],      // open virtual positions
      paperClosed: [],         // last 100 closed (capped)
      paperBalance: null,
      aiDecisionSources: {},   // cumulative decision-source counts
      savedAt: 0,
    };
    this.loaded = false;
  }

  load() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        logger.info('[State] No existing state file — starting fresh');
        this.loaded = true;
        return this.data;
      }
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        this.data = { ...this.data, ...parsed };
        const ageMin = parsed.savedAt
          ? Math.round((Date.now() - parsed.savedAt) / 60000)
          : -1;
        logger.info(`[State] Restored from ${STATE_FILE} (age: ${ageMin}min)`);
      } else {
        logger.warn('[State] Version mismatch or invalid data, starting fresh');
      }
    } catch (err) {
      logger.error(`[State] Load failed: ${err.message} — starting fresh`);
    }
    this.loaded = true;
    return this.data;
  }

  save() {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      this.data.savedAt = Date.now();
      // Cap paperClosed to last 100 to prevent unbounded growth
      if (Array.isArray(this.data.paperClosed) && this.data.paperClosed.length > 100) {
        this.data.paperClosed = this.data.paperClosed.slice(-100);
      }
      // Atomic write: temp + rename
      fs.writeFileSync(TMP_FILE, JSON.stringify(this.data, null, 2));
      fs.renameSync(TMP_FILE, STATE_FILE);
    } catch (err) {
      logger.error(`[State] Save failed: ${err.message}`);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  /**
   * Merge an object into a keyed state slot, useful for counters.
   */
  merge(key, patch) {
    this.data[key] = { ...(this.data[key] || {}), ...patch };
  }
}

module.exports = new StateStore();
