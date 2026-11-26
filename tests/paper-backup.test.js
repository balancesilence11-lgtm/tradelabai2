import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperBackup, validatePaperBackup, previewPaperRestore, restorePaperBackup, PAPER_BACKUP_VERSION } from '../src/paper-backup.js';
class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k,v) { this.data.set(k,String(v)); }
  removeItem(k) { this.data.delete(k); }
}
const keys = { orders:'tradelab_demo_orders', autoTrades:'tradelab_auto_trades_v1', autoLog:'tradelab_auto_log_v1' };
const emptyData = () => ({orders:[],autoTrades:[],autoLog:[]});
function v1(data = emptyData()) {
  return {format:'TradeLabAI.PaperTradingBackup',version:1,createdAt:'2026-01-01T00:00:00.000Z',scope:'browser-local-paper-records',data};
}
test('creates a version 2 backup with counts and integrity metadata', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"o1"}]',[keys.autoTrades]:'[]',[keys.autoLog]:'[]'});
  const b = createPaperBackup(s, '2026-01-01T00:00:00.000Z');
  assert.equal(b.version, PAPER_BACKUP_VERSION);
  assert.equal(b.data.orders[0].id, 'o1');
  assert.deepEqual(b.manifest.recordCounts, {orders:1,autoTrades:0,autoLog:0});
  assert.equal(b.manifest.integrity.algorithm, 'fnv1a32');
  assert.match(b.manifest.integrity.digest, /^[a-f0-9]{8}$/);
});
test('rejects malformed JSON and unsupported versions', () => {
  assert.equal(validatePaperBackup('{').ok, false);
  assert.match(validatePaperBackup({format:'TradeLabAI.PaperTradingBackup',version:99,scope:'browser-local-paper-records'}).reason, /Unsupported backup version/);
});
test('migrates a valid version 1 backup in memory to version 2', () => {
  const old = v1({orders:[{id:'legacy'}],autoTrades:[],autoLog:[{message:'old'}]});
  const result = validatePaperBackup(old);
  assert.equal(result.ok, true);
  assert.equal(result.sourceVersion, 1);
  assert.equal(result.migrated, true);
  assert.equal(result.backup.version, 2);
  assert.equal(result.backup.data.orders[0].id, 'legacy');
  assert.equal(old.version, 1);
});
test('preview identifies migration without modifying storage', () => {
  const s = new MemoryStorage();
  const result = previewPaperRestore(v1({orders:[{id:'legacy'}],autoTrades:[],autoLog:[]}), s);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.targetVersion, 2);
  assert.equal(s.getItem(keys.orders), null);
});
test('rejects missing manifest and altered data integrity', () => {
  const b = createPaperBackup(new MemoryStorage());
  const missing = structuredClone(b); delete missing.manifest;
  assert.match(validatePaperBackup(missing).reason, /manifest is missing/);
  const altered = structuredClone(b); altered.data.orders.push({id:'tampered'}); altered.manifest.recordCounts.orders += 1;
  assert.match(validatePaperBackup(altered).reason, /integrity check failed/);
});
test('rejects manifest count mismatch', () => {
  const b = createPaperBackup(new MemoryStorage());
  b.manifest.recordCounts.orders = 1;
  assert.match(validatePaperBackup(b).reason, /count mismatch/);
});
test('rejects malformed sections and duplicate record IDs', () => {
  const b = createPaperBackup(new MemoryStorage());
  b.data.orders = [{id:'x'},{id:'x'}];
  assert.match(validatePaperBackup(b).reason, /duplicate IDs/);
  b.data.orders = 'not-array';
  assert.equal(validatePaperBackup(b).ok, false);
});
test('preview reports additions and duplicate records without writing', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"existing"}]'});
  const b = createPaperBackup(new MemoryStorage());
  b.data.orders = [{id:'existing'},{id:'new'}];
  // Recreate the manifest after intentionally changing the fixture data.
  const valid = createPaperBackup(new MemoryStorage());
  valid.data = b.data;
  const rebuilt = createPaperBackupFromData(valid, b.data);
  const p = previewPaperRestore(rebuilt,s);
  assert.equal(p.counts.orders.added, 1); assert.equal(p.counts.orders.duplicates, 1);
  assert.equal(JSON.parse(s.getItem(keys.orders)).length, 1);
});
function createPaperBackupFromData(template, data) {
  // Reuse the public creator's checksum format by deriving the manifest from
  // a temporary storage instance, without relying on private implementation.
  const s = new MemoryStorage({
    [keys.orders]: JSON.stringify(data.orders),
    [keys.autoTrades]: JSON.stringify(data.autoTrades),
    [keys.autoLog]: JSON.stringify(data.autoLog)
  });
  return createPaperBackup(s, template.createdAt);
}
test('restore merges by ID and does not duplicate existing orders', () => {
  const s = new MemoryStorage({[keys.orders]:'[{"id":"a"}]'});
  const incoming = createPaperBackupFromData(createPaperBackup(new MemoryStorage()), {orders:[{id:'a'},{id:'b'}],autoTrades:[],autoLog:[]});
  assert.equal(restorePaperBackup(incoming,s).ok, true);
  assert.deepEqual(JSON.parse(s.getItem(keys.orders)).map(x=>x.id), ['a','b']);
});
test('restores a valid legacy version 1 backup', () => {
  const s = new MemoryStorage();
  const result = restorePaperBackup(v1({orders:[{id:'legacy'}],autoTrades:[],autoLog:[]}),s);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(JSON.parse(s.getItem(keys.orders)), [{id:'legacy'}]);
});
test('failed storage write rolls back previously written sections', () => {
  class FailingStorage extends MemoryStorage { setItem(k,v) { if (k===keys.autoTrades) throw new Error('quota'); super.setItem(k,v); } }
  const s = new FailingStorage({[keys.orders]:'[{"id":"old"}]'});
  const incoming = createPaperBackupFromData(createPaperBackup(new MemoryStorage()), {orders:[{id:'new'}],autoTrades:[],autoLog:[]});
  const result = restorePaperBackup(incoming,s);
  assert.equal(result.ok,false); assert.deepEqual(JSON.parse(s.getItem(keys.orders)),[{id:'old'}]);
});
test('empty or absent browser keys are backed up as empty arrays', () => {
  const b = createPaperBackup(new MemoryStorage());
  assert.deepEqual(b.data, {orders:[],autoTrades:[],autoLog:[]});
});


test('applies the 10 MB limit to direct object inputs as well as JSON strings', () => {
  const oversized = {
    format:'TradeLabAI.PaperTradingBackup', version:1,
    scope:'browser-local-paper-records',
    data:{orders:[{note:'x'.repeat(10 * 1024 * 1024)}],autoTrades:[],autoLog:[]}
  };
  assert.match(validatePaperBackup(oversized).reason, /10 MB limit/);
});

test('rejects backup objects that cannot be safely serialized', () => {
  const cyclic = {format:'TradeLabAI.PaperTradingBackup',version:1,scope:'browser-local-paper-records',data:emptyData()};
  cyclic.data.orders.push(cyclic);
  assert.match(validatePaperBackup(cyclic).reason, /cannot be safely serialized/);
});

test('rejects backups above the total record-count ceiling', () => {
  const tooMany = v1({
    orders:Array.from({length:50001}, (_, index) => ({id:`order-${index}`})),
    autoTrades:[],autoLog:[]
  });
  assert.match(validatePaperBackup(tooMany).reason, /50,000 record limit/);
});
