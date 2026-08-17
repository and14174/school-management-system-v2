/**
 * `createJob`'s fuzzy-matched suggested mapping is returned exactly once, at
 * creation time (see CreateImportJobResult's own comment in lib/api.ts) - it
 * is never persisted server-side, so a page that lands on the mapping step
 * without having just called createJob (a same-tab refresh, primarily) has
 * no way to re-fetch it. Cached here, per job, in sessionStorage so that
 * common case still pre-fills; a shared link opened in a different
 * browser/tab genuinely won't have it, which the "new import" page's own
 * comment calls out - the job and its rows are never lost either way, only
 * this one convenience.
 */
export function suggestedMappingStorageKey(jobId: string): string {
  return `sms:import-suggested-mapping:${jobId}`;
}

export interface CachedImportUpload {
  suggestedMapping: Record<string, string>;
  headers: string[];
}

export function readCachedImportUpload(jobId: string): CachedImportUpload | null {
  try {
    const raw = sessionStorage.getItem(suggestedMappingStorageKey(jobId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedImportUpload;
  } catch {
    return null;
  }
}

export function writeCachedImportUpload(jobId: string, value: CachedImportUpload): void {
  try {
    sessionStorage.setItem(suggestedMappingStorageKey(jobId), JSON.stringify(value));
  } catch {
    // Best-effort only - private browsing / storage quota.
  }
}
