import { describe, expect, it } from 'vitest';
import { formatCsvField, formatCsvRow, parseCsv, rowToRecord } from './domain/csv.js';

/**
 * Pure logic, no testcontainers - the parser has no I/O, so this runs in
 * milliseconds rather than waiting on a Postgres container. Exercises
 * exactly what a school's real export throws at it - see `domain/csv.ts`'s
 * own header comment.
 */
describe('csv', () => {
  it('parses plain comma-separated fields', () => {
    const { headers, rows } = parseCsv('givenName,familyName\nAda,Lovelace\nGrace,Hopper\n');
    expect(headers).toEqual(['givenName', 'familyName']);
    expect(rows).toEqual([
      ['Ada', 'Lovelace'],
      ['Grace', 'Hopper'],
    ]);
  });

  it('handles a quoted field containing a comma', () => {
    const { headers, rows } = parseCsv('name,note\n"Smith, Jr.",ok\n');
    expect(headers).toEqual(['name', 'note']);
    expect(rows).toEqual([['Smith, Jr.', 'ok']]);
  });

  it('handles a quoted field containing an embedded newline', () => {
    const { headers, rows } = parseCsv('name,note\n"line one\nline two",ok\n');
    expect(headers).toEqual(['name', 'note']);
    expect(rows).toEqual([['line one\nline two', 'ok']]);
  });

  it('handles doubled-quote escaping inside a quoted field', () => {
    const { rows } = parseCsv('name,note\nx,"She said ""hi"""\n');
    expect(rows).toEqual([['x', 'She said "hi"']]);
  });

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles a mix of CRLF and bare LF in the same file', () => {
    const { rows } = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('strips a leading UTF-8 BOM', () => {
    const withBom = `\uFEFFa,b\n1,2\n`;
    const { headers, rows } = parseCsv(withBom);
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', '2']]);
  });

  it('handles a file with no trailing newline', () => {
    const { headers, rows } = parseCsv('a,b\n1,2');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', '2']]);
  });

  it('all four together: BOM, CRLF, a quoted comma and an embedded newline in one file', () => {
    const csv = `\uFEFFname,bio\r\n"Doe, Jane","Line one\nLine two"\r\nJohn Roe,plain\r\n`;
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(['name', 'bio']);
    expect(rows).toEqual([
      ['Doe, Jane', 'Line one\nLine two'],
      ['John Roe', 'plain'],
    ]);
  });

  it('rowToRecord zips headers to a row, padding a short row with empty strings', () => {
    expect(rowToRecord(['a', 'b', 'c'], ['1', '2'])).toEqual({ a: '1', b: '2', c: '' });
  });

  it('formatCsvField quotes only when needed, and escapes embedded quotes', () => {
    expect(formatCsvField('plain')).toBe('plain');
    expect(formatCsvField('a,b')).toBe('"a,b"');
    expect(formatCsvField('a"b')).toBe('"a""b"');
    expect(formatCsvField('a\nb')).toBe('"a\nb"');
  });

  it('formatCsvRow is a round trip through parseCsv', () => {
    const line = formatCsvRow(['Smith, Jr.', 'has "quotes"', 'plain']);
    const { rows } = parseCsv(`h1,h2,h3\n${line}`);
    expect(rows).toEqual([['Smith, Jr.', 'has "quotes"', 'plain']]);
  });
});
