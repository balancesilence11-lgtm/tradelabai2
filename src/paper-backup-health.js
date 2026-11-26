import { PAPER_BACKUP_KEYS } from './paper-backup.js';

// Read-only integrity inspection for browser-local paper-trading records.
export function inspectPaperTradingStorage(storage = globalThis.localStorage) {
  if (!storage) return { ok: false, healthy: false, issues: ['Browser storage is unavailable.'], sections: {} };
  const sections = {};
  const issues = [];
  let totalRecords = 0;
  for (const [name, key] of Object.entries(PAPER_BACKUP_KEYS)) {
    try {
      const raw = storage.getItem(key);
      if (raw == null || raw === '') {
        sections[name] = { count: 0, bytes: 0, status: 'empty', duplicates: 0 };
        continue;
      }
      const bytes = new TextEncoder().encode(raw).length;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Stored value is not an array.');
      if (parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('One or more records are malformed.');
      const ids = parsed.map(row => row.id).filter(id => id != null).map(String);
      const duplicates = ids.length - new Set(ids).size;
      if (duplicates) issues.push(`${name}: ${duplicates} duplicate record ID(s).`);
      sections[name] = { count: parsed.length, bytes, status: duplicates ? 'warning' : 'healthy', duplicates };
      totalRecords += parsed.length;
    } catch (error) {
      sections[name] = { count: null, bytes: 0, status: 'error', duplicates: null };
      issues.push(`${name}: ${error.message || 'Could not inspect stored data.'}`);
    }
  }
  return { ok: true, healthy: issues.length === 0, totalRecords, sections, issues, checkedAt: new Date().toISOString() };
}
