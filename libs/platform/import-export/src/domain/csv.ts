/**
 * A small, self-contained CSV parser/writer. No dependency is installed for
 * this in the workspace (see the module report), and RFC 4180 parsing is not
 * large enough to justify adding one - same call `@sms/kernel`'s `ids.ts`
 * makes for UUIDv7.
 *
 * Handles what a school's export from Excel/Sheets/SIS actually produces:
 *   - quoted fields containing commas ("Smith, Jr.")
 *   - quoted fields containing embedded newlines
 *   - doubled-quote escaping ("" -> ") inside a quoted field
 *   - CRLF *and* bare LF line endings, possibly mixed in one file
 *   - a leading UTF-8 BOM (Excel writes one on "CSV UTF-8" export)
 * See `csv.spec.ts` for a test against exactly these cases.
 */

const BOM = '\uFEFF';

export interface ParsedCsv {
  readonly headers: string[];
  readonly rows: string[][];
}

/**
 * Parses `input` into a header row and its data rows. A state-machine
 * scanner rather than a `split(',')`/regex approach, because a quoted field
 * can legally contain the very characters (`,`, `\n`, `\r`) that would
 * otherwise delimit fields and rows.
 */
export function parseCsv(input: string): ParsedCsv {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField(): void {
    row.push(field);
    field = '';
  }
  function endRow(): void {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      // A quote only opens a quoted field at the field's start - a bare `"`
      // elsewhere (malformed input) is taken literally rather than throwing,
      // so one bad row doesn't blow up parsing the other 1,199.
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      endRow();
      i += 1;
      if (text[i] === '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  // A file ending in a newline produces one wholly-empty trailing row -
  // drop it, but keep a genuinely blank row in the middle of the file.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') {
      rows.pop();
    } else {
      break;
    }
  }

  const [headerRow, ...dataRows] = rows;
  return { headers: headerRow ?? [], rows: dataRows };
}

/** Zips a data row against `headers` into a header -> value map; a short row pads with `''`, a long one is truncated. */
export function rowToRecord(headers: readonly string[], row: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = row[index] ?? '';
  });
  return record;
}

/** Quotes `value` only when it contains a character that would otherwise be misread (comma, quote, CR, LF). */
export function formatCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One CSV line, CRLF-terminated (the RFC 4180 convention, and what Excel expects on re-import). */
export function formatCsvRow(fields: readonly string[]): string {
  return `${fields.map(formatCsvField).join(',')}\r\n`;
}
