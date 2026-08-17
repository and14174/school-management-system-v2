import type { DomainError, NotFoundError, Result, TenantId, UserId } from '@sms/kernel';

export * from './domain/types.js';
export * from './application/template-registry.js';
// Ships INSIDE this module for apps/api to register (no real domain template
// exists yet - see domain/sample-certificate.template.ts's own comment) and
// for this module's own test suite.
export { sampleCertificateTemplate, type SampleCertificateData } from './domain/sample-certificate.template.js';

export interface DocumentTemplateSummary {
  /** `null` when the key is registered in code but has never been published for this tenant. */
  readonly id: string | null;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number | null;
}

export interface PublishTemplateVersionInput {
  readonly templateKey: string;
  /** The tenant-editable wrapper. May be `''` to use the built-in fallback wrapper - see `DocumentsService.composeHtml`. */
  readonly html: string;
  /** Merged with the `DocumentTemplate`'s own baseline CSS at render time - this is "restyle with CSS, no developer needed". */
  readonly css: string;
}

export interface TemplateVersionRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly templateId: string;
  readonly templateKey: string;
  readonly version: number;
  readonly htmlSource: string;
  readonly cssSource: string;
  readonly publishedAt: Date;
  readonly createdByUserId: UserId | null;
}

export interface GenerateDocumentInput {
  readonly templateKey: string;
  /** e.g. `people.person` - opaque to this module, see the 1100 migration header. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** Validated against the template's `dataSchema` before anything is rendered. */
  readonly data: unknown;
  readonly title: string;
}

export interface DocumentRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly templateVersionId: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  readonly storageKey: string;
  readonly contentHash: string;
  readonly dataSnapshot: Record<string, unknown>;
  readonly pageCount: number;
  readonly bytes: number;
  readonly generatedByUserId: UserId | null;
  readonly generatedAt: Date;
  readonly supersededByDocumentId: string | null;
}

export interface ListDocumentsInput {
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ReissueInput {
  /** New data to render. Everything else (template, subject, title unless overridden) carries over from the original document. */
  readonly data: unknown;
  readonly title?: string;
}

/**
 * The public surface of `@sms/documents`. See the 1100 migration header and
 * `application/documents.service.ts` for why every `generate`/`reissue` call
 * writes a brand-new, immutable row rather than updating one in place.
 */
export interface DocumentsContract {
  /** Every template registered in code (`DOCUMENT_TEMPLATE_REGISTRY`), cross-referenced with what this tenant has published, if anything. */
  listTemplates(): Promise<DocumentTemplateSummary[]>;

  /** Publishes a new, immutable version. Auto-creates the `documents.template` row on a template's first publish. */
  publishTemplateVersion(input: PublishTemplateVersionInput): Promise<Result<TemplateVersionRecord, DomainError>>;

  /**
   * Validates `data`, renders HTML->PDF via Playwright, uploads to object
   * storage, and writes one immutable `documents.document` row. Requires the
   * template to have at least one published version - see
   * `PreconditionFailedError` in the implementation.
   */
  generate(input: GenerateDocumentInput): Promise<Result<DocumentRecord, DomainError>>;

  getDocument(id: string): Promise<Result<DocumentRecord, NotFoundError>>;

  /** Newest first - for a subject's "documents issued to them" view. */
  listDocuments(input: ListDocumentsInput): Promise<DocumentRecord[]>;

  /** A presigned, time-limited URL - PDFs never proxy through the API. */
  getDownloadUrl(id: string): Promise<Result<DownloadUrl, NotFoundError>>;

  /**
   * Generates a new document (same template/subject, new `data`) and sets
   * `superseded_by_document_id` on the original. The original's own row and
   * stored bytes are never modified - see the 1100 migration header.
   */
  reissue(documentId: string, input: ReissueInput): Promise<Result<DocumentRecord, DomainError>>;
}

/** Nest DI token for `DocumentsContract`. */
export const DOCUMENTS_CONTRACT = Symbol('DOCUMENTS_CONTRACT');
