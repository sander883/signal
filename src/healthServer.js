const http = require('http');
const config = require('./config');
const logger = require('./logger');
const metrics = require('./metrics');
const paperTrader = require('./paperTrader');
const aiAgent = require('./aiAgent');
const newsFilter = require('./filters/newsFilter');
const marketData = require('./data');

/**
 * Lightweight HTTP health / metrics endpoint.
 *
 * Endpoints:
 *   GET /health   → { status, uptimeSec, lastCycleAgoSec, staleness, news }
 *   GET /metrics  → counters snapshot (for Prometheus-style scraping)
 *
 * No dependencies — pure Node http. Binds to 0.0.0.0:<port>.
 * Disabled by default; enable with HEALTH_SERVER_ENABLED=true.
 */

class HealthServer {
  constructor() {
    this.server = null;
    this.startedAt = Date.now();
    this.lastCycleAt = 0;
    this.lastCycleDurationMs = 0;
  }

  /**
   * Called by the main loop each time a cycle completes (success OR failure).
   */
  markCycle(durationMs) {
    this.lastCycleAt = Date.now();
    this.lastCycleDurationMs = durationMs || 0;
  }

  start() {
    const port = parseInt(process.env.HEALTH_PORT) || 8080;
    const enabled = process.env.HEALTH_SERVER_ENABLED === 'true';
    if (!enabled) {
      logger.info('[Health] HTTP server disabled (set HEALTH_SERVER_ENABLED=true to enable)');
      return;
    }

    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      logger.error(`[Health] Server error: ${err.message}`);
    });
    this.server.listen(port, '0.0.0.0', () => {
      logger.info(`[Health] Listening on :${port} (/health, /metrics)`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  _handle(req, res) {
    try {
      if (req.url === '/health') return this._sendJson(res, 200, this._healthPayload());
      if (req.url === '/metrics') return this._sendJson(res, 200, this._metricsPayload());
      if (req.url === '/' || req.url === '/status') return this._sendJson(res, 200, this._healthPayload());
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      logger.error(`[Health] Handler error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error');
    }
  }

  _healthPayload() {
    const now = Date.now();
    const uptimeSec = Math.round((now - this.startedAt) / 1000);
    const lastCycleAgoSec = this.lastCycleAt ? Math.round((now - this.lastCycleAt) / 1000) : null;

    // Status derivation:
    //   healthy   = last cycle within 2 × primary interval
    //   degraded  = last cycle within 5 × primary interval OR news stale
    //   unhealthy = no cycle yet, or > 5 × interval
    const primaryTf = config.primaryTimeframe;
    const tfSec = this._tfToSec(primaryTf);
    let status = 'healthy';
    if (lastCycleAgoSec === null) {
      status = 'starting';
    } else if (lastCycleAgoSec > tfSec * 5) {
      status = 'unhealthy';
    } else if (lastCycleAgoSec > tfSec * 2) {
      status = 'degraded';
    }

    const newsFresh = newsFilter.getFreshnessStatus ? newsFilter.getFreshnessStatus() : 'unknown';
    if (newsFresh === 'stale' || newsFresh === 'unknown') status = status === 'healthy' ? 'degraded' : status;

    const dataFreshness = {};
    for (const tf of config.timeframes) {
      dataFreshness[tf] = marketData.getFreshnessStatus(tf);
    }

    return {
      status,
      uptimeSec,
      startedAt: new Date(this.startedAt).toISOString(),
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastCycleAgoSec,
      lastCycleDurationMs: this.lastCycleDurationMs,
      newsFreshness: newsFresh,
      dataFreshness,
      paperTrading: paperTrader.enabled ? paperTrader.stats() : { enabled: false },
    };
  }

  _metricsPayload() {
    return {
      ...metrics.snapshot(),
      ai: aiAgent.getStats ? aiAgent.getStats() : {},
      paper: paperTrader.enabled ? paperTrader.stats() : null,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  _tfToSec(tf) {
    const map = {
      '1min': 60, '5min': 300, '15min': 900, '30min': 1800,
      '1h': 3600, '4h': 14400, '1day': 86400,
    };
    return map[tf] || 900;
  }

  _sendJson(res, status, body) {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
    });
    res.end(json);
  }
}

module.exports = new HealthServer();
