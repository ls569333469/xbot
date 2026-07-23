const WebSocket = require('ws');
const db = require('../../../lib/db');
const logger = require('../../../lib/logger');
const { X6551Client } = require('../../../lib/x-client-6551');
const {
  ingest6551Event,
  insertInboxEvent,
  processInboxEvent,
  resumePending
} = require('./event-inbox');

const LOCK_NAME = 'xbot:6551:wss-consumer';

class X6551WssConsumer {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.clientFactory = options.clientFactory || (() => new X6551Client(process.env.OPENNEWS_TOKEN));
    this.ingest = options.ingest || ingest6551Event;
    this.persist = options.persist || insertInboxEvent;
    this.process = options.process || processInboxEvent;
    this.legacyIngest = Boolean(options.ingest);
    this.resume = options.resume || resumePending;
    this.random = options.random || Math.random;
    this.ws = null;
    this.lockClient = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.processingQueue = Promise.resolve();
    this.commitQueue = Promise.resolve();
    this.commitPending = 0;
    this.processingPending = 0;
    this.stopping = false;
    this.status = 'stopped';
    this.lastMessageAt = null;
    this.lastPongAt = null;
    this.connectedAt = null;
    this.subscribedAt = null;
    this.reconnectCount = 0;
    this.consecutiveFailures = 0;
    this.reconnectAlerted = false;
    this.eventsReceived = 0;
    this.lastError = null;
    this.wsBroadcast = null;
    this.onSignals = options.onSignals || null;
  }

  enabled() {
    return process.env.X_DATA_PROVIDER === '6551'
      && String(process.env.X_6551_WSS_ENABLED || 'false').toLowerCase() === 'true';
  }

  async acquireLock() {
    const lockClient = await this.db.pool.connect();
    const result = await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [LOCK_NAME]
    );
    if (!result.rows[0].locked) {
      lockClient.release();
      return false;
    }
    this.lockClient = lockClient;
    lockClient.on?.('error', () => {
      if (this.lockClient !== lockClient) return;
      this.lastError = 'WSS advisory lock connection failed';
      this.status = 'error';
      this.lockClient = null;
      try {
        lockClient.release(true);
      } catch {
        // The pool may already have discarded the failed connection.
      }
      if (this.ws) this.ws.close();
      else if (!this.stopping) this.scheduleReconnect();
    });
    return true;
  }

  async start(options = {}) {
    this.wsBroadcast = options.wsBroadcast || this.wsBroadcast;
    this.onSignals = options.onSignals || this.onSignals;
    if (!this.enabled()) {
      this.status = 'stopped';
      return { started: false, reason: 'disabled' };
    }
    if (this.lockClient) return { started: true, reason: 'already_started' };
    if (!process.env.OPENNEWS_TOKEN) throw new Error('OPENNEWS_TOKEN is required for 6551 WSS');

    const locked = await this.acquireLock();
    if (!locked) {
      this.status = 'standby';
      this.scheduleReconnect();
      return { started: false, reason: 'another_instance_is_active' };
    }

    this.stopping = false;
    const client = this.clientFactory();
    await this.resume({ client, wsBroadcast: this.wsBroadcast, onSignals: this.onSignals }).catch((error) => {
      this.logger.error('6551-wss', `Pending event recovery failed: ${error.message}`);
    });
    this.connect();
    return { started: true };
  }

  connect() {
    if (this.stopping || !this.enabled() || !this.lockClient) return;
    this.clearSocketTimers();
    this.status = this.reconnectCount > 0 ? 'reconnecting' : 'connecting';
    const token = encodeURIComponent(process.env.OPENNEWS_TOKEN);
    let ws;
    try {
      ws = new this.WebSocketImpl(`wss://ai.6551.io/open/twitter_wss?token=${token}`);
    } catch {
      this.lastError = '6551 WSS connection initialization failed';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.status = 'connecting';
      this.connectedAt = new Date();
      this.lastPongAt = new Date();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'twitter.subscribe' }));
      this.startHeartbeat();
    });

    ws.on('message', (data) => this.handleMessage(data));
    ws.on('error', () => {
      this.lastError = '6551 WSS transport error';
      this.logger.error('6551-wss', this.lastError);
    });
    ws.on('close', () => {
      this.clearSocketTimers();
      this.ws = null;
      this.connectedAt = null;
      this.subscribedAt = null;
      if (!this.stopping) this.scheduleReconnect();
    });
  }

  handleMessage(data) {
    this.lastMessageAt = new Date();
    const raw = data.toString();
    if (raw === 'pong') {
      this.lastPongAt = new Date();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.lastError = '6551 WSS returned non-JSON data';
      return;
    }

    if (payload.id === 1) {
      if (payload.result?.success === true) {
        this.status = 'subscribed';
        this.subscribedAt = new Date();
        this.consecutiveFailures = 0;
        this.reconnectAlerted = false;
      } else {
        this.lastError = '6551 WSS subscription was rejected';
        this.ws?.close(4001, 'subscription rejected');
      }
      return;
    }
    if (payload.method !== 'twitter.event' || !payload.params) return;

    this.eventsReceived += 1;
    const client = this.clientFactory();
    const transportReceivedAt = new Date();
    if (this.legacyIngest) {
      this.processingQueue = this.processingQueue
        .then(() => this.ingest(payload.params, { client, wsBroadcast: this.wsBroadcast, transportReceivedAt }))
        .catch((error) => {
          this.lastError = error.message;
          this.logger.error('6551-wss', `Event ingestion failed: ${error.message}`);
        });
      return;
    }

    this.commitPending += 1;
    this.commitQueue = this.commitQueue.then(async () => {
      try {
        const inserted = await this.persist(payload.params, this.db, { transportReceivedAt });
        if (!inserted.row || inserted.duplicate || !inserted.identity.stable) return;
        this.processingPending += 1;
        this.processingQueue = this.processingQueue
          .then(() => this.process(inserted.row, {
            client,
            wsBroadcast: this.wsBroadcast,
            onSignals: this.onSignals
          }))
          .catch((error) => {
            this.lastError = error.message;
            this.logger.error('6551-wss', `Event processing failed: ${error.message}`);
          })
          .finally(() => { this.processingPending -= 1; });
      } catch (error) {
        this.lastError = error.message;
        this.logger.error('6551-wss', `Inbox commit failed: ${error.message}`);
      } finally {
        this.commitPending -= 1;
      }
    });
  }

  startHeartbeat() {
    const heartbeatMs = Math.max(5000, Number(process.env.X_6551_HEARTBEAT_MS || 20000));
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== (this.WebSocketImpl.OPEN ?? 1)) return;
      const staleFor = Date.now() - new Date(this.lastPongAt || 0).getTime();
      if (staleFor > heartbeatMs * 2) {
        this.status = 'stale';
        this.ws.close(4000, 'heartbeat timeout');
        return;
      }
      this.ws.send('ping');
    }, heartbeatMs);
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    this.status = 'reconnecting';
    this.reconnectCount += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 5 && !this.reconnectAlerted) {
      this.reconnectAlerted = true;
      this.logger.error(
        '6551-wss',
        `WSS reconnect circuit alert after ${this.consecutiveFailures} consecutive failures`
      );
    }
    const maxMs = Math.max(1000, Number(process.env.X_6551_RECONNECT_MAX_MS || 30000));
    const baseMs = Math.min(maxMs, 1000 * (2 ** Math.min(this.consecutiveFailures - 1, 8)));
    const delayMs = Math.round(baseMs * (0.8 + this.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.lockClient) {
        this.connect();
        return;
      }
      this.start({ wsBroadcast: this.wsBroadcast }).catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  clearSocketTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  getStatus() {
    return {
      enabled: this.enabled(),
      status: this.status,
      lockHeld: Boolean(this.lockClient),
      connectedAt: this.connectedAt,
      subscribedAt: this.subscribedAt,
      connectionAgeMs: this.connectedAt ? Date.now() - this.connectedAt.getTime() : null,
      lastMessageAt: this.lastMessageAt,
      lastPongAt: this.lastPongAt,
      reconnectCount: this.reconnectCount,
      consecutiveFailures: this.consecutiveFailures,
      reconnectAlerted: this.reconnectAlerted,
      eventsReceived: this.eventsReceived,
      commitQueueDepth: this.commitPending,
      processingQueueDepth: this.processingPending,
      lastError: this.lastError
    };
  }

  async stop() {
    this.stopping = true;
    this.clearSocketTimers();
    if (this.ws) {
      if (this.ws.readyState === (this.WebSocketImpl.OPEN ?? 1)) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'twitter.unsubscribe' }));
      }
      this.ws.close();
      this.ws = null;
    }
    await this.commitQueue.catch(() => {});
    await this.processingQueue.catch(() => {});
    if (this.lockClient) {
      await this.lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]).catch(() => {});
      this.lockClient.release();
      this.lockClient = null;
    }
    this.status = 'stopped';
    this.connectedAt = null;
    this.subscribedAt = null;
  }
}

const consumer = new X6551WssConsumer();

module.exports = { LOCK_NAME, X6551WssConsumer, consumer };
