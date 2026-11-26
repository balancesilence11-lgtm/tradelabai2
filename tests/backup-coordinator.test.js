import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkspaceRestore, restoreWorkspaceEntries } from '../src/backup-coordinator.js';

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    dump: key => map.get(key)
  };
}
const allowed = ['tradelab_demo_orders','tradelab_auto_trades_v1','tradelab_auto_log_v1','tradelab_user_settings','tradelab_account_label'];

test('workspace restore merges paper orders and keeps existing records', () => {
  const s = storage({ tradelab_demo_orders: JSON.stringify([{id:'old'}]) });
  const result = restoreWorkspaceEntries([['tradelab_demo_orders', JSON.stringify([{id:'old'},{id:'new'}])]], allowed, s);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(s.dump('tradelab_demo_orders')), [{id:'old'},{id:'new'}]);
});

test('workspace restore merges automation trades and logs', () => {
  const s = storage({ tradelab_auto_trades_v1: '[{"id":1}]', tradelab_auto_log_v1: '[{"id":"a"}]' });
  const result = restoreWorkspaceEntries([
    ['tradelab_auto_trades_v1','[{"id":1},{"id":2}]'],
    ['tradelab_auto_log_v1','[{"id":"a"},{"id":"b"}]']
  ], allowed, s);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(s.dump('tradelab_auto_trades_v1')).length, 2);
  assert.equal(JSON.parse(s.dump('tradelab_auto_log_v1')).length, 2);
});

test('duplicate paper records in incoming backup are added only once', () => {
  const s = storage();
  restoreWorkspaceEntries([['tradelab_demo_orders','[{"id":"x"},{"id":"x"}]']], allowed, s);
  assert.equal(JSON.parse(s.dump('tradelab_demo_orders')).length, 1);
});

test('non-paper workspace values retain replacement behaviour', () => {
  const s = storage({ tradelab_user_settings: '{"theme":"dark"}' });
  const result = restoreWorkspaceEntries([['tradelab_user_settings','{"theme":"light"}']], allowed, s);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(s.dump('tradelab_user_settings')), {theme:'light'});
});

test('rejects unsupported keys without changing storage', () => {
  const s = storage({ tradelab_demo_orders: '[{"id":"safe"}]' });
  const result = restoreWorkspaceEntries([['not-a-key','{}']], allowed, s);
  assert.equal(result.ok, false);
  assert.equal(s.dump('tradelab_demo_orders'), '[{"id":"safe"}]');
});

test('rejects malformed paper arrays before writing anything', () => {
  const s = storage({ tradelab_user_settings: '{"x":1}' });
  const result = restoreWorkspaceEntries([
    ['tradelab_user_settings','{"x":2}'],
    ['tradelab_demo_orders','{"not":"array"}']
  ], allowed, s);
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(s.dump('tradelab_user_settings')), {x:1});
});

test('rejects invalid existing paper ledger instead of overwriting it', () => {
  const s = storage({ tradelab_demo_orders: '{broken' });
  const result = restoreWorkspaceEntries([['tradelab_demo_orders','[{"id":"incoming"}]']], allowed, s);
  assert.equal(result.ok, false);
  assert.equal(s.dump('tradelab_demo_orders'), '{broken');
});

test('prepare reports writes without mutating storage', () => {
  const s = storage({ tradelab_demo_orders: '[{"id":"a"}]' });
  const result = prepareWorkspaceRestore([['tradelab_demo_orders','[{"id":"b"}]']], allowed, s);
  assert.equal(result.ok, true);
  assert.equal(s.dump('tradelab_demo_orders'), '[{"id":"a"}]');
});

test('rejects duplicate keys in one workspace backup', () => {
  const s = storage();
  const result = restoreWorkspaceEntries([
    ['tradelab_user_settings','{}'],
    ['tradelab_user_settings','{"x":1}']
  ], allowed, s);
  assert.equal(result.ok, false);
  assert.equal(s.dump('tradelab_user_settings'), undefined);
});
