// Read-only integrity check for workspace localStorage entries.
// These two settings are intentionally stored as plain strings, not JSON.
export const RAW_WORKSPACE_KEYS = Object.freeze([
  'tradelab_auto_last_candle_v1',
  'tradelab_account_label'
]);

export function inspectWorkspaceStorageIntegrity(storage, keys) {
  if (!storage || !Array.isArray(keys)) {
    return { valid: 0, invalid: 0, invalidKeys: [], checked: 0 };
  }
  const rawKeys = new Set(RAW_WORKSPACE_KEYS);
  let valid = 0;
  const invalidKeys = [];
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw === null || rawKeys.has(key)) {
      valid++;
      continue;
    }
    try {
      JSON.parse(raw);
      valid++;
    } catch {
      invalidKeys.push(key);
    }
  }
  return {
    valid,
    invalid: invalidKeys.length,
    invalidKeys,
    checked: keys.length
  };
}
