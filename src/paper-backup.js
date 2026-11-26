// Versioned browser-local paper trading backup.
// Version 2 adds record counts and a deterministic integrity checksum.
// Account balances, risk settings and credentials are intentionally excluded.
export const PAPER_BACKUP_VERSION = 2;
export const PAPER_BACKUP_KEYS = Object.freeze({
  orders: 'tradelab_demo_orders',
  autoTrades: 'tradelab_auto_trades_v1',
  autoLog: 'tradelab_auto_log_v1'
});
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_RECORDS = 50000;
const FORMAT = 'TradeLabAI.PaperTradingBackup';

function readArray(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null || raw === '') return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${key} must contain an array.`);
  return value;
}
function stableDataString(data) {
  // The data object is constructed in a fixed key order; JSON.stringify preserves
  // each record's original property order so exports can be checked consistently.
  return JSON.stringify({
    orders: data.orders,
    autoTrades: data.autoTrades,
    autoLog: data.autoLog
  });
}
function checksum(data) {
  const input = stableDataString(data);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function recordCounts(data) {
  return Object.fromEntries(Object.keys(PAPER_BACKUP_KEYS).map(name => [name, data[name].length]));
}
function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Backup data section is missing.';
  for (const name of Object.keys(PAPER_BACKUP_KEYS)) {
    if (!Array.isArray(data[name])) return `Backup section '${name}' must be an array.`;
    if (data[name].some(row => !row || typeof row !== 'object' || Array.isArray(row))) return `Backup section '${name}' contains an invalid record.`;
  }
  for (const name of ['orders', 'autoTrades']) {
    const ids = data[name].map(row => row.id).filter(id => id != null).map(String);
    if (new Set(ids).size !== ids.length) return `Backup section '${name}' contains duplicate IDs.`;
  }
  return null;
}
function migrateV1ToV2(backup) {
  const data = {
    orders: backup.data.orders,
    autoTrades: backup.data.autoTrades,
    autoLog: backup.data.autoLog
  };
  return {
    format: FORMAT,
    version: 2,
    createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : null,
    scope: 'browser-local-paper-records',
    data,
    manifest: {
      recordCounts: recordCounts(data),
      integrity: { algorithm: 'fnv1a32', digest: checksum(data) }
    }
  };
}
export function createPaperBackup(storage = globalThis.localStorage, createdAt = new Date().toISOString()) {
  if (!storage) throw new Error('Browser storage is unavailable.');
  const data = {};
  for (const [name, key] of Object.entries(PAPER_BACKUP_KEYS)) data[name] = readArray(storage, key);
  return {
    format: FORMAT,
    version: PAPER_BACKUP_VERSION,
    createdAt,
    scope: 'browser-local-paper-records',
    data,
    manifest: {
      recordCounts: recordCounts(data),
      integrity: { algorithm: 'fnv1a32', digest: checksum(data) }
    }
  };
}
export function validatePaperBackup(input) {
  let backup = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_BACKUP_BYTES) return { ok: false, reason: 'Backup exceeds the 10 MB limit.' };
    try { backup = JSON.parse(input); } catch { return { ok: false, reason: 'File is not valid JSON.' }; }
  } else if (input && typeof input === 'object') {
    // Apply the same byte ceiling to direct object callers, not only uploaded files.
    // JSON.stringify also rejects cyclic or otherwise non-serialisable input safely.
    try {
      const serialized = JSON.stringify(input);
      if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > MAX_BACKUP_BYTES) {
        return { ok: false, reason: 'Backup exceeds the 10 MB limit.' };
      }
    } catch {
      return { ok: false, reason: 'Backup object cannot be safely serialized.' };
    }
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return { ok: false, reason: 'Backup must be a JSON object.' };
  if (backup.format !== FORMAT || backup.scope !== 'browser-local-paper-records') return { ok: false, reason: 'Unsupported backup format.' };
  if (![1, 2].includes(backup.version)) return { ok: false, reason: `Unsupported backup version: ${String(backup.version)}.` };
  const dataError = validateData(backup.data);
  if (dataError) return { ok: false, reason: dataError };
  const totalRecords = Object.values(recordCounts(backup.data)).reduce((sum, count) => sum + count, 0);
  if (totalRecords > MAX_BACKUP_RECORDS) return { ok: false, reason: `Backup exceeds the ${MAX_BACKUP_RECORDS.toLocaleString()} record limit.` };
  if (backup.version === 1) {
    const migrated = migrateV1ToV2(backup);
    return { ok: true, backup: migrated, sourceVersion: 1, migrated: true, warnings: ['Version 1 backup was migrated in memory to version 2. The source file was not modified.'] };
  }
  if (!backup.manifest || !backup.manifest.recordCounts || !backup.manifest.integrity) return { ok: false, reason: 'Version 2 backup manifest is missing.' };
  const counts = recordCounts(backup.data);
  for (const name of Object.keys(PAPER_BACKUP_KEYS)) {
    if (backup.manifest.recordCounts[name] !== counts[name]) return { ok: false, reason: `Backup manifest count mismatch for '${name}'.` };
  }
  if (backup.manifest.integrity.algorithm !== 'fnv1a32' || typeof backup.manifest.integrity.digest !== 'string') return { ok: false, reason: 'Unsupported or missing backup integrity metadata.' };
  if (backup.manifest.integrity.digest !== checksum(backup.data)) return { ok: false, reason: 'Backup integrity check failed. The file may be corrupted or modified.' };
  return { ok: true, backup, sourceVersion: 2, migrated: false, warnings: [] };
}
function recordKey(row) {
  if (row.id != null && String(row.id)) return `id:${String(row.id)}`;
  return `json:${JSON.stringify(row)}`;
}
export function previewPaperRestore(input, storage = globalThis.localStorage) {
  const checked = validatePaperBackup(input);
  if (!checked.ok) return checked;
  if (!storage) return { ok: false, reason: 'Browser storage is unavailable.' };
  try {
    const counts = {};
    for (const [name, key] of Object.entries(PAPER_BACKUP_KEYS)) {
      const current = readArray(storage, key);
      const keys = new Set(current.map(recordKey));
      const incoming = checked.backup.data[name];
      const uniqueIncoming = new Set(incoming.map(recordKey));
      const duplicates = incoming.length - uniqueIncoming.size + [...uniqueIncoming].filter(k => keys.has(k)).length;
      counts[name] = { current: current.length, incoming: incoming.length, added: incoming.length - duplicates, duplicates };
    }
    return { ok: true, createdAt: checked.backup.createdAt, counts, sourceVersion: checked.sourceVersion, targetVersion: PAPER_BACKUP_VERSION, migrated: checked.migrated, warnings: checked.warnings };
  } catch (error) { return { ok: false, reason: error.message || 'Could not read current browser records.' }; }
}
export function restorePaperBackup(input, storage = globalThis.localStorage) {
  const checked = validatePaperBackup(input);
  if (!checked.ok) return checked;
  if (!storage) return { ok: false, reason: 'Browser storage is unavailable.' };
  const previous = {};
  const next = {};
  try {
    for (const [name, key] of Object.entries(PAPER_BACKUP_KEYS)) {
      previous[key] = storage.getItem(key);
      const current = readArray(storage, key);
      const seen = new Set(current.map(recordKey));
      const merged = [...current];
      for (const row of checked.backup.data[name]) {
        const id = recordKey(row);
        if (!seen.has(id)) { merged.push(row); seen.add(id); }
      }
      next[key] = JSON.stringify(merged);
    }
    for (const key of Object.values(PAPER_BACKUP_KEYS)) storage.setItem(key, next[key]);
    return { ok: true, counts: Object.fromEntries(Object.entries(PAPER_BACKUP_KEYS).map(([name, key]) => [name, JSON.parse(next[key]).length])), sourceVersion: checked.sourceVersion, migrated: checked.migrated };
  } catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* best-effort rollback */ }
    }
    return { ok: false, reason: error.message || 'Restore failed; previous records were preserved where browser storage allowed.' };
  }
}
