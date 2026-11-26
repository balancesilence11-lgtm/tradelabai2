// Versioned browser-local paper trading backup. Account balances and risk settings
// are intentionally excluded: restoring them could overwrite or double-count equity.
export const PAPER_BACKUP_VERSION = 1;
export const PAPER_BACKUP_KEYS = Object.freeze({
  orders: 'tradelab_demo_orders',
  autoTrades: 'tradelab_auto_trades_v1',
  autoLog: 'tradelab_auto_log_v1'
});
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

function readArray(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null || raw === '') return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${key} must contain an array.`);
  return value;
}

export function createPaperBackup(storage = globalThis.localStorage, createdAt = new Date().toISOString()) {
  if (!storage) throw new Error('Browser storage is unavailable.');
  const data = {};
  for (const [name, key] of Object.entries(PAPER_BACKUP_KEYS)) data[name] = readArray(storage, key);
  return {
    format: 'TradeLabAI.PaperTradingBackup',
    version: PAPER_BACKUP_VERSION,
    createdAt,
    scope: 'browser-local-paper-records',
    data
  };
}

export function validatePaperBackup(input) {
  let backup = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_BACKUP_BYTES) return { ok: false, reason: 'Backup exceeds the 10 MB limit.' };
    try { backup = JSON.parse(input); } catch { return { ok: false, reason: 'File is not valid JSON.' }; }
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return { ok: false, reason: 'Backup must be a JSON object.' };
  if (backup.format !== 'TradeLabAI.PaperTradingBackup' || backup.version !== PAPER_BACKUP_VERSION || backup.scope !== 'browser-local-paper-records') return { ok: false, reason: 'Unsupported backup format or version.' };
  if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) return { ok: false, reason: 'Backup data section is missing.' };
  for (const name of Object.keys(PAPER_BACKUP_KEYS)) {
    if (!Array.isArray(backup.data[name])) return { ok: false, reason: `Backup section '${name}' must be an array.` };
    if (backup.data[name].some(row => !row || typeof row !== 'object' || Array.isArray(row))) return { ok: false, reason: `Backup section '${name}' contains an invalid record.` };
  }
  for (const name of ['orders', 'autoTrades']) {
    const ids = backup.data[name].map(row => row.id).filter(id => id != null).map(String);
    if (new Set(ids).size !== ids.length) return { ok: false, reason: `Backup section '${name}' contains duplicate IDs.` };
  }
  return { ok: true, backup };
}

function recordKey(row) {
  if (row.id != null && String(row.id)) return `id:${String(row.id)}`;
  return `json:${JSON.stringify(row)}`;
}

export function previewPaperRestore(backup, storage = globalThis.localStorage) {
  const checked = validatePaperBackup(backup);
  if (!checked.ok) return checked;
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
    return { ok: true, createdAt: checked.backup.createdAt, counts };
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
    // Write only after every section has parsed and merged successfully.
    for (const key of Object.values(PAPER_BACKUP_KEYS)) storage.setItem(key, next[key]);
    return { ok: true, counts: Object.fromEntries(Object.entries(PAPER_BACKUP_KEYS).map(([name, key]) => [name, JSON.parse(next[key]).length])) };
  } catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* best-effort rollback */ }
    }
    return { ok: false, reason: error.message || 'Restore failed; previous records were preserved where browser storage allowed.' };
  }
}
