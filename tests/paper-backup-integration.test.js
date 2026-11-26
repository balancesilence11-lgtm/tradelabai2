import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperBackup, previewPaperRestore, restorePaperBackup, PAPER_BACKUP_KEYS } from '../src/paper-backup.js';
import { inspectPaperTradingStorage } from '../src/paper-backup-health.js';
import { recordPaperBackupAudit, readPaperBackupAudit } from '../src/paper-backup-audit.js';
class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
test('integrates backup creation, audit, preview, safe merge restore and integrity inspection', () => {
  const source = new MemoryStorage({
    [PAPER_BACKUP_KEYS.orders]: JSON.stringify([{ id: 'order-1', status: 'closed' }]),
    [PAPER_BACKUP_KEYS.autoTrades]: JSON.stringify([{ id: 'auto-1' }]),
    [PAPER_BACKUP_KEYS.autoLog]: JSON.stringify([{ message: 'source event' }])
  });
  const destination = new MemoryStorage({
    [PAPER_BACKUP_KEYS.orders]: JSON.stringify([{ id: 'existing-order' }])
  });
  const audit = new MemoryStorage();
  const backup = createPaperBackup(source, '2026-11-26T13:00:00.000Z');
  assert.equal(recordPaperBackupAudit('backup_created', { sourceVersion: backup.version, records: 3 }, audit).ok, true);
  const preview = previewPaperRestore(JSON.stringify(backup), destination);
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.orders.added, 1);
  assert.equal(preview.counts.autoTrades.added, 1);
  assert.equal(restorePaperBackup(backup, destination).verified, true);
  const health = inspectPaperTradingStorage(destination);
  assert.equal(health.healthy, true);
  assert.equal(health.totalRecords, 4);
  assert.equal(readPaperBackupAudit(audit).length, 1);
});
test('integrity inspection blocks treating corrupted current data as a clean restore target', () => {
  const storage = new MemoryStorage({ [PAPER_BACKUP_KEYS.orders]: 'not-json' });
  const health = inspectPaperTradingStorage(storage);
  assert.equal(health.healthy, false);
  assert.match(health.issues[0], /orders/);
  const backup = createPaperBackup(new MemoryStorage());
  assert.equal(previewPaperRestore(backup, storage).ok, false);
});
