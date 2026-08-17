/**
 * Renders `{{key}}` placeholders against a flat payload - the same minimal,
 * dependency-free templating idiom `@sms/documents`' `DocumentsService
 * .composeHtml` uses for `{{title}}`/`{{css}}`/`{{content}}`. Deliberately
 * not a real templating engine: this module has no business embedding one,
 * and every template this system ships (see `seed.ts`) only ever needs flat
 * substitution.
 */
export function renderTemplate(source: string, payload: Record<string, unknown>): string {
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = payload[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
