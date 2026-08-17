import { createHash } from 'node:crypto';

/**
 * A stable content fingerprint for a CSV data row (its raw header -> value
 * map), independent of key order. Recorded on `import_export.import_row.row_hash`
 * so a school (or support) can answer "have we seen this exact row before" -
 * see the migration's own comment for why this is observability, not the
 * create-vs-update key (that is `ImportTarget.findExisting`).
 */
export function computeRowHash(raw: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(raw)
      .sort()
      .map((key) => [key, raw[key]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
