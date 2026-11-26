import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPaperTradingStorage } from '../src/paper-backup-health.js';
class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
}
const keys = { orders: 'tradelab_demo_orders', autoTrades: 'tradelab_auto_trades_v1', autoLog: 'tradelab_auto_log_v1' };
test('reports healthy empty paper storage', () => {
  const result = inspectPaperTradingStorage(new MemoryStorage());
  assert.equal(result.healthy, true);
  assert.equal(result.totalRecords, 0);
});
test('counts valid records and detects duplicate IDs without changing storage', () => {
  const storage = new MemoryStorage({ [keys.orders]: '[{"id":"a"},{"id":"a"}]' });
  const before = storage.getItem(keys.orders);
  const result = inspectPaperTradingStorage(storage);
  assert.equal(result.healthy, false);
  assert.equal(result.sections.orders.duplicates, 1);
  assert.equal(storage.getItem(keys.orders), before);
});
test('reports malformed JSON and non-array sections', () => {
  const result = inspectPaperTradingStorage(new MemoryStorage({ [keys.orders]: '{', [keys.autoTrades]: '{}' }));
  assert.equal(result.sections.orders.status, 'error');
  assert.equal(result.sections.autoTrades.status, 'error');
  assert.equal(result.issues.length, 2);
});
test('reports unavailable storage', () => {
  const result = inspectPaperTradingStorage(null);
  assert.equal(result.ok, false);
  assert.equal(result.healthy, false);
});
