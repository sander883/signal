const logger = require('./logger');

class Metrics {
  constructor() {
    this.counters = {
      cycles: 0,
      signalsSent: 0,
      signalsRejected: 0,
      newsBlocked: 0,
      sessionBlocked: 0,
      aiRejected: 0,
      errors: 0,
      dataFallbacks: 0,
      staleDataAlerts: 0,
    };
    this.lastHeartbeat = Date.now();
  }

  /**
   * Restore counters from persisted state.
   */
  restore(saved) {
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'number') this.counters[k] = v;
      }
      logger.info(`[Metrics] Restored ${Object.keys(saved).length} counters from state`);
    }
  }

  inc(key, amount = 1) {
    if (!(key in this.counters)) this.counters[key] = 0;
    this.counters[key] += amount;
  }

  snapshot(extra = {}) {
    return {
      ts: new Date().toISOString(),
      ...this.counters,
      ...extra,
    };
  }

  heartbeat(extra = {}) {
    const snap = this.snapshot(extra);
    logger.info(`[Metrics] ${JSON.stringify(snap)}`);
    this.lastHeartbeat = Date.now();
  }
}

module.exports = new Metrics();
