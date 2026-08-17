/**
 * Deterministic `JSON.stringify`: object keys are sorted recursively so two
 * structurally-equal objects with keys inserted in a different order produce
 * the identical string - required for `DocumentsService`'s content hash
 * (`sha256(templateVersionId + canonicalize(data))`) to actually be a
 * function of the DATA, not of incidental key order.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      sorted[key] = sortKeysDeep(val);
    }
    return sorted;
  }
  return value;
}
