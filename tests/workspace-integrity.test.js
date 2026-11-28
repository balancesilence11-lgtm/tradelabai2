import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkspaceStorageIntegrity, RAW_WORKSPACE_KEYS } from '../src/workspace-integrity.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
}

test('accepts the two documented plain-string settings without JSON parsing', () => {
  const storage = new MemoryStorage({
    tradelab_account_label: 'Demo account',
    tradelab_auto_last_candle_v1: '2026-11-28T07:00:00.000Z'
  });
  const result = inspectWorkspaceStorageIntegrity(storage, RAW_WORKSPACE_KEYS);
  assert.deepEqual(result, { valid: 2, invalid: 0, invalidKeys: [], checked: 2 });
});

test('detects malformed JSON and identifies the exact affected storage keys', () => {
  const storage = new MemoryStorage({
    tradelab_demo_orders: '[{"id":"ok"}]',
    tradelab_trade_journal_v1: '{broken',
    tradelab_user_settings: 'not-json'
  });
  const result = inspectWorkspaceStorageIntegrity(storage, [
    'tradelab_demo_orders',
    'tradelab_trade_journal_v1',
    'tradelab_user_settings'
  ]);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 2);
  assert.deepEqual(result.invalidKeys, ['tradelab_trade_journal_v1', 'tradelab_user_settings']);
});

test('counts missing entries as valid and reports the complete check count', () => {
  const result = inspectWorkspaceStorageIntegrity(new MemoryStorage(), ['a', 'b', 'c']);
  assert.deepEqual(result, { valid: 3, invalid: 0, invalidKeys: [], checked: 3 });
});
