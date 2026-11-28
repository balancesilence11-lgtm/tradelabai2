import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const request = (path, method = 'GET') => new Request(`https://tradelab.test${path}`, { method });

test('public health endpoint reports Worker liveness without authentication', async () => {
  const response = await worker.fetch(request('/api/health'), {});
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.status, 'healthy');
  assert.equal(data.service, 'TradeLab AI');
  assert.ok(Number.isFinite(Date.parse(data.timestamp)));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('health endpoint supports HEAD without returning a body', async () => {
  const response = await worker.fetch(request('/api/health', 'HEAD'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('health endpoint rejects unsupported methods', async () => {
  const response = await worker.fetch(request('/api/health', 'POST'), {});
  const data = await response.json();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal(data.ok, false);
});


test('health endpoint answers OPTIONS without exposing runtime details', async () => {
  const response = await worker.fetch(request('/api/health', 'OPTIONS'), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal(await response.text(), '');
});
