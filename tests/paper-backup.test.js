import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperBackup, validatePaperBackup, previewPaperRestore, restorePaperBackup } from '../src/paper-backup.js';
class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k,v) { this.data.set(k,String(v)); }
  removeItem(k) { this.data.delete(k); }
}
const keys = { orders:'tradelab_demo_orders', autoTrades:'tradelab_auto_trades_v1', autoLog:'tradelab_auto_log_v1' };
test('creates a versioned backup of paper order and automation records', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"o1"}]',[keys.autoTrades]:'[]',[keys.autoLog]:'[]'});
  const b = createPaperBackup(s, '2026-01-01T00:00:00.000Z');
  assert.equal(b.version, 1); assert.equal(b.data.orders[0].id, 'o1');
});
test('rejects malformed JSON and unsupported versions', () => {
  assert.equal(validatePaperBackup('{').ok, false);
  assert.equal(validatePaperBackup({format:'TradeLabAI.PaperTradingBackup',version:99}).ok, false);
});
test('rejects malformed sections and duplicate record IDs', () => {
  const base = createPaperBackup(new MemoryStorage());
  base.data.orders = [{id:'x'},{id:'x'}];
  assert.match(validatePaperBackup(base).reason, /duplicate IDs/);
  base.data.orders = 'not-array';
  assert.equal(validatePaperBackup(base).ok, false);
});
test('preview reports additions and duplicate records without writing', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"existing"}]'});
  const b = createPaperBackup(new MemoryStorage()); b.data.orders = [{id:'existing'},{id:'new'}];
  const p = previewPaperRestore(b,s);
  assert.equal(p.counts.orders.added, 1); assert.equal(p.counts.orders.duplicates, 1);
  assert.equal(JSON.parse(s.getItem(keys.orders)).length, 1);
});
test('restore merges by ID and does not duplicate existing orders', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"a"}]'});
  const b = createPaperBackup(new MemoryStorage()); b.data.orders = [{id:'a'},{id:'b'}];
  assert.equal(restorePaperBackup(b,s).ok, true);
  assert.deepEqual(JSON.parse(s.getItem(keys.orders)).map(x=>x.id), ['a','b']);
});
test('failed storage write rolls back previously written sections', () => {
  class FailingStorage extends MemoryStorage { setItem(k,v) { if (k===keys.autoTrades) throw new Error('quota'); super.setItem(k,v); } }
  const s = new FailingStorage({[keys.orders]:'[{"id":"old"}]'});
  const b = createPaperBackup(new MemoryStorage()); b.data.orders = [{id:'new'}];
  const result = restorePaperBackup(b,s);
  assert.equal(result.ok,false); assert.deepEqual(JSON.parse(s.getItem(keys.orders)),[{id:'old'}]);
});
test('empty or absent browser keys are backed up as empty arrays', () => {
  const b = createPaperBackup(new MemoryStorage());
  assert.deepEqual(b.data, {orders:[],autoTrades:[],autoLog:[]});
});
