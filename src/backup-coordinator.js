// Coordinates legacy workspace restores with the dedicated paper-record backup.
// Workspace backups may contain paper arrays, but those arrays are always MERGED,
// never replaced, so the two restore paths cannot silently erase paper history.
export const COORDINATED_PAPER_KEYS = Object.freeze([
  'tradelab_demo_orders',
  'tradelab_auto_trades_v1',
  'tradelab_auto_log_v1'
]);
const RAW_VALUE_KEYS = new Set(['tradelab_auto_last_candle_v1', 'tradelab_account_label']);

function identity(row) {
  if (row && row.id != null && String(row.id)) return `id:${String(row.id)}`;
  return `json:${JSON.stringify(row)}`;
}

export function prepareWorkspaceRestore(entries, allowedKeys, storage) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, reason: 'Backup contains no data entries.' };
  if (!storage) return { ok: false, reason: 'Browser storage is unavailable.' };
  const allowed = new Set(allowedKeys);
  const seenKeys = new Set();
  const writes = {};
  try {
    for (const item of entries) {
      if (!Array.isArray(item) || item.length !== 2) throw new Error('Backup contains a malformed entry.');
      const [key, value] = item;
      if (!allowed.has(key) || typeof value !== 'string' || seenKeys.has(key)) throw new Error('Backup contains an unsupported or duplicate key.');
      if (value.length > 750000) throw new Error('A backup entry exceeds the safety limit.');
      seenKeys.add(key);
      if (COORDINATED_PAPER_KEYS.includes(key)) {
        const incoming = JSON.parse(value);
        if (!Array.isArray(incoming) || incoming.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(`${key} must contain an array of records.`);
        const currentRaw = storage.getItem(key);
        const current = currentRaw == null ? [] : JSON.parse(currentRaw);
        if (!Array.isArray(current)) throw new Error(`Current ${key} data is not a valid record array; restore was not applied.`);
        const merged = [...current];
        const identities = new Set(current.map(identity));
        for (const row of incoming) {
          const id = identity(row);
          if (!identities.has(id)) { merged.push(row); identities.add(id); }
        }
        writes[key] = JSON.stringify(merged);
      } else {
        if (!RAW_VALUE_KEYS.has(key)) JSON.parse(value);
        writes[key] = value;
      }
    }
    return { ok: true, writes, keys: [...seenKeys] };
  } catch (error) { return { ok: false, reason: error.message || 'Backup validation failed.' }; }
}

export function restoreWorkspaceEntries(entries, allowedKeys, storage = globalThis.localStorage) {
  const prepared = prepareWorkspaceRestore(entries, allowedKeys, storage);
  if (!prepared.ok) return prepared;
  const previous = {};
  try {
    for (const key of prepared.keys) previous[key] = storage.getItem(key);
    for (const key of prepared.keys) storage.setItem(key, prepared.writes[key]);
    return { ok: true, imported: prepared.keys.length, keys: prepared.keys };
  } catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* best-effort rollback */ }
    }
    return { ok: false, reason: error.message || 'Restore failed; rollback was attempted.' };
  }
}
