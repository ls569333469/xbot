const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { X6551WssConsumer } = require('../domains/x-monitor/6551/wss-consumer');

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function fakeDb(locked = true) {
  const lockClient = new EventEmitter();
  lockClient.query = async (sql) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    return { rows: [{ unlocked: true }] };
  };
  lockClient.release = () => {};
  return { pool: { connect: async () => lockClient } };
}

function with6551Env() {
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    enabled: process.env.X_6551_WSS_ENABLED,
    token: process.env.OPENNEWS_TOKEN
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.X_6551_WSS_ENABLED = 'true';
  process.env.OPENNEWS_TOKEN = 'secret-test-token';
  return () => {
    for (const [key, value] of [
      ['X_DATA_PROVIDER', previous.provider],
      ['X_6551_WSS_ENABLED', previous.enabled],
      ['OPENNEWS_TOKEN', previous.token]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('WSS consumer subscribes once and serializes provider events', async () => {
  const restore = with6551Env();
  FakeWebSocket.instances = [];
  const order = [];
  const consumer = new X6551WssConsumer({
    WebSocketImpl: FakeWebSocket,
    db: fakeDb(true),
    logger: { error: () => {} },
    clientFactory: () => ({}),
    resume: async () => ({ processed: 0, failed: 0 }),
    ingest: async (event) => {
      order.push(`start:${event.id}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`end:${event.id}`);
    },
    random: () => 0.5
  });

  try {
    const result = await consumer.start();
    assert.equal(result.started, true);
    assert.equal(FakeWebSocket.instances.length, 1);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    assert.equal(JSON.parse(ws.sent[0]).method, 'twitter.subscribe');

    ws.emit('message', Buffer.from(JSON.stringify({ id: 1, result: { success: true } })));
    ws.emit('message', Buffer.from(JSON.stringify({ method: 'twitter.event', params: { id: 1 } })));
    ws.emit('message', Buffer.from(JSON.stringify({ method: 'twitter.event', params: { id: 2 } })));
    await consumer.processingQueue;

    assert.equal(consumer.getStatus().status, 'subscribed');
    assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
    assert.equal(JSON.stringify(consumer.getStatus()).includes('secret-test-token'), false);
  } finally {
    await consumer.stop();
    restore();
  }
});

test('WSS consumer remains non-connected when another instance owns the lock', async () => {
  const restore = with6551Env();
  FakeWebSocket.instances = [];
  const consumer = new X6551WssConsumer({
    WebSocketImpl: FakeWebSocket,
    db: fakeDb(false),
    logger: { error: () => {} },
    random: () => 0.5
  });

  try {
    const result = await consumer.start();
    assert.equal(result.started, false);
    assert.equal(result.reason, 'another_instance_is_active');
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    await consumer.stop();
    restore();
  }
});

test('WSS consumer retries pending inbox events while the process remains running', async () => {
  const restore = with6551Env();
  FakeWebSocket.instances = [];
  let recoveries = 0;
  const consumer = new X6551WssConsumer({
    WebSocketImpl: FakeWebSocket,
    db: fakeDb(true),
    logger: { error: () => {} },
    clientFactory: () => ({}),
    pendingResumeIntervalMs: 5,
    resume: async () => {
      recoveries += 1;
      return { processed: 0, failed: 0 };
    }
  });

  try {
    await consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.ok(recoveries >= 2);
    assert.equal(consumer.getStatus().pendingResumeIntervalMs, 5);
  } finally {
    await consumer.stop();
    restore();
  }
});

test('WSS consumer raises one circuit alert after repeated reconnect failures', async () => {
  const errors = [];
  const consumer = new X6551WssConsumer({
    logger: { error: (...args) => errors.push(args) },
    random: () => 0.5
  });
  consumer.consecutiveFailures = 4;
  consumer.scheduleReconnect();
  assert.equal(consumer.getStatus().reconnectAlerted, true);
  assert.equal(errors.length, 1);
  consumer.scheduleReconnect();
  assert.equal(errors.length, 1);
  await consumer.stop();
});
