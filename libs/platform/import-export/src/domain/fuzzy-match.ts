import type { ColumnMapping, ImportFieldSpec } from './types.js';

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `createJob`'s "suggested column mapping": for each target field, picks the
 * best unclaimed CSV header - an exact match on the normalised key/label
 * first, then a substring-containment fallback (`"Given Name*"` ~ `givenName`)
 * so a school's export headers with punctuation, casing or a trailing
 * asterisk still land close to right. Never a hard requirement - `setMapping`
 * lets the caller correct or complete anything this misses.
 */
export function suggestMapping(headers: readonly string[], fields: readonly ImportFieldSpec[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const usedHeaders = new Set<string>();
  const candidates = headers.map((header) => ({ header, normalised: normalise(header) }));

  for (const field of fields) {
    const targets = [normalise(field.key), normalise(field.label)].filter((t) => t.length > 0);

    let match = candidates.find((c) => !usedHeaders.has(c.header) && targets.includes(c.normalised));

    if (!match) {
      match = candidates.find(
        (c) =>
          !usedHeaders.has(c.header) &&
          c.normalised.length > 0 &&
          targets.some((t) => t.length >= 3 && (c.normalised.includes(t) || t.includes(c.normalised))),
      );
    }

    if (match) {
      mapping[field.key] = match.header;
      usedHeaders.add(match.header);
    }
  }

  return mapping;
}
