// Browser-local audit trail for paper backup operations. This is diagnostic history, not tamper-proof security logging.
export const PAPER_BACKUP_AUDIT_KEY = 'tradelab_paper_backup_audit_v1';
export const PAPER_BACKUP_AUDIT_LIMIT = 200;
const ALLOWED = new Set(['backup_created','validation_passed','validation_rejected','restore_succeeded','restore_failed']);
function safeText(value, max = 240) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max); }
export function readPaperBackupAudit(storage = globalThis.localStorage) {
  if (!storage) return [];
  try { const raw = storage.getItem(PAPER_BACKUP_AUDIT_KEY); if (!raw) return []; const rows = JSON.parse(raw); return Array.isArray(rows) ? rows.filter(x => x && typeof x === 'object' && ALLOWED.has(x.action)).slice(0, PAPER_BACKUP_AUDIT_LIMIT) : []; } catch { return []; }
}
export function recordPaperBackupAudit(action, details = {}, storage = globalThis.localStorage, now = new Date().toISOString()) {
  if (!storage || !ALLOWED.has(action)) return { ok:false, reason:'Audit storage unavailable or action unsupported.' };
  try {
    const entry = { id: `${Date.parse(now) || Date.now()}-${Math.random().toString(36).slice(2,8)}`, at:safeText(now,40), action, sourceVersion: Number.isInteger(details.sourceVersion) ? details.sourceVersion : null, records: Number.isInteger(details.records) && details.records >= 0 ? details.records : null, message:safeText(details.message) };
    const rows = [entry, ...readPaperBackupAudit(storage)].slice(0, PAPER_BACKUP_AUDIT_LIMIT);
    storage.setItem(PAPER_BACKUP_AUDIT_KEY, JSON.stringify(rows));
    return {ok:true, entry};
  } catch { return {ok:false, reason:'Could not persist the local audit entry.'}; }
}
export function clearPaperBackupAudit(storage = globalThis.localStorage) {
  try { storage?.removeItem(PAPER_BACKUP_AUDIT_KEY); return true; } catch { return false; }
}
