import type { ZodType } from 'zod';

/**
 * The port that keeps this module (`type:platform`) ignorant of what a
 * "report card" or "transcript" is. `@nx/enforce-module-boundaries` forbids
 * `type:platform -> type:domain` outright, so a concrete `DocumentTemplate`
 * for `academic.report_card` etc. can never live in this package - it is
 * defined in `apps/api` (the one layer allowed to depend on both) against
 * whatever domain contract it needs, and supplied through
 * `DOCUMENT_TEMPLATE_REGISTRY` - see `application/template-registry.ts`.
 *
 * `render` returns the entity-specific HTML fragment (`html`) and that
 * template's OWN baseline stylesheet (`css`). Neither is the final document:
 * `DocumentsContract.generate` merges `css` with the tenant's published
 * `documents.template_version.css_source` (see `DocumentsService
 * .composeHtml`) so a school can restyle the document by publishing new CSS,
 * never by asking a developer to change `render`.
 */
export interface DocumentTemplate<TData = unknown> {
  /** e.g. `report_card`. Matches `documents.template.key`. */
  readonly key: string;

  readonly name: string;

  /** Validates `generate()`'s `data` input before anything is rendered. */
  readonly dataSchema: ZodType<TData>;

  /** Pure: no I/O, no ambient context. Must not fetch external resources - see the module header on self-contained templates. */
  render(data: TData): Promise<{ html: string; css: string }>;
}
