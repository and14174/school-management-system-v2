import type { DocumentTemplate } from '../domain/types.js';

/**
 * The inversion point - exactly the pattern `@sms/import-export` uses for
 * `IMPORT_TARGET_REGISTRY` (`libs/platform/import-export/src/application
 * /import-target-registry.ts`) and `@sms/access` uses for
 * `SECTION_SCOPE_RESOLVER`: this module defines the port and a token that
 * resolves to a zero-item default when nothing overrides it. `apps/api` is
 * the one layer allowed to depend on both `type:platform` and `type:domain`,
 * so it is the one place a real `DocumentTemplate` (e.g. `report_card`,
 * built against a gradebook contract) is ever registered.
 */
export interface DocumentTemplateRegistry {
  /** Every registered template's public summary - for `DocumentsContract.listTemplates()`. */
  list(): ReadonlyArray<Pick<DocumentTemplate, 'key' | 'name'>>;

  /** The template for `key`, or `undefined` if nothing has registered one. */
  get(key: string): DocumentTemplate | undefined;
}

export const DOCUMENT_TEMPLATE_REGISTRY = Symbol('DOCUMENT_TEMPLATE_REGISTRY');

/**
 * The safe default: an unregistered key must never resolve to SOME template
 * by accident (e.g. falling back to the sample one), so this resolves to "no
 * templates" - same fail-closed reasoning as `DEFAULT_IMPORT_TARGET_REGISTRY`.
 */
export const DEFAULT_DOCUMENT_TEMPLATE_REGISTRY: DocumentTemplateRegistry = {
  list: () => [],
  get: () => undefined,
};
