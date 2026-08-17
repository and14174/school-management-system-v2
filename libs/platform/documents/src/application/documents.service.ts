import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  err,
  isSystemContext,
  newId,
  ok,
  type DomainError,
  type PersonId,
  type Result,
  type TenantContext,
  type UserId,
} from '@sms/kernel';
import { getContext, withTenantTx, type Tx } from '@sms/db';
import { AUDIT_CONTRACT, type AuditContract } from '@sms/audit';
import type {
  DocumentRecord,
  DocumentsContract,
  DocumentTemplateSummary,
  DownloadUrl,
  GenerateDocumentInput,
  ListDocumentsInput,
  PublishTemplateVersionInput,
  ReissueInput,
  TemplateVersionRecord,
} from '../contract.js';
import { canonicalizeJson } from '../domain/canonical-json.js';
import { DOCUMENT_TEMPLATE_REGISTRY, type DocumentTemplateRegistry } from './template-registry.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../infrastructure/object-storage.js';
import { PdfRenderer } from '../infrastructure/pdf-renderer.js';
import { document, template, templateVersion } from '../infrastructure/schema.js';

type TemplateRow = typeof template.$inferSelect;
type TemplateVersionRow = typeof templateVersion.$inferSelect;
type DocumentRow = typeof document.$inferSelect;

function requireTenantContext(): TenantContext {
  const context = getContext();
  if (!context || isSystemContext(context)) {
    throw new ForbiddenError('@sms/documents operations require a resolved tenant context.');
  }
  return context;
}

function toTemplateVersionRecord(row: TemplateVersionRow, templateKey: string): TemplateVersionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    templateId: row.templateId,
    templateKey,
    version: row.version,
    htmlSource: row.htmlSource,
    cssSource: row.cssSource,
    publishedAt: row.publishedAt,
    createdByUserId: (row.createdByUserId ?? null) as UserId | null,
  };
}

function toDocumentRecord(row: DocumentRow, templateKey: string, templateVersionNumber: number): DocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    templateVersionId: row.templateVersionId,
    templateKey,
    templateVersion: templateVersionNumber,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    title: row.title,
    storageKey: row.storageKey,
    contentHash: row.contentHash,
    dataSnapshot: row.dataSnapshot as Record<string, unknown>,
    pageCount: row.pageCount,
    bytes: row.bytes,
    generatedByUserId: (row.generatedByUserId ?? null) as UserId | null,
    generatedAt: row.generatedAt,
    supersededByDocumentId: row.supersededByDocumentId,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_WRAPPER =
  '<!doctype html><html><head><meta charset="utf-8" /><title>{{title}}</title><style>{{css}}</style></head><body>{{content}}</body></html>';

const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Implements `DocumentsContract`. The one property everything else here
 * serves: `generate`/`reissue` write a brand-new, immutable row and PDF -
 * never an update in place - so a document handed to a parent stays exactly
 * what was handed to them even after the template or the underlying data
 * changes later. See the 1100 migration header.
 */
@Injectable()
export class DocumentsService implements DocumentsContract {
  // Every param uses an explicit @Inject() token, including PdfRenderer (a
  // concrete class, not an interface) - implicit type-based DI resolves to
  // `undefined` at runtime under this workspace's tsx/esbuild
  // decorator-metadata emission (see @sms/outbox's OutboxModule for the
  // exact failure this avoids), so nothing here relies on it.
  constructor(
    @Inject(DOCUMENT_TEMPLATE_REGISTRY) private readonly registry: DocumentTemplateRegistry,
    @Inject(PdfRenderer) private readonly renderer: PdfRenderer,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Optional() @Inject(AUDIT_CONTRACT) private readonly audit?: AuditContract,
  ) {}

  async listTemplates(): Promise<DocumentTemplateSummary[]> {
    const ctx = requireTenantContext();
    const registered = this.registry.list();

    const rows = await withTenantTx(ctx, async (tx) => {
      const templateRows = await tx.select().from(template).where(eq(template.tenantId, ctx.tenantId));
      const versionRows = await tx.select().from(templateVersion).where(eq(templateVersion.tenantId, ctx.tenantId));
      return { templateRows, versionRows };
    });

    const latestVersionByTemplateId = new Map<string, number>();
    for (const v of rows.versionRows) {
      const current = latestVersionByTemplateId.get(v.templateId) ?? 0;
      if (v.version > current) latestVersionByTemplateId.set(v.templateId, v.version);
    }
    const templateRowByKey = new Map(rows.templateRows.map((row) => [row.key, row]));

    return registered.map((def) => {
      const row = templateRowByKey.get(def.key);
      return {
        id: row?.id ?? null,
        key: def.key,
        name: def.name,
        description: row?.description ?? null,
        latestVersion: row ? (latestVersionByTemplateId.get(row.id) ?? null) : null,
      };
    });
  }

  async publishTemplateVersion(input: PublishTemplateVersionInput): Promise<Result<TemplateVersionRecord, DomainError>> {
    const ctx = requireTenantContext();
    const def = this.registry.get(input.templateKey);
    if (!def) {
      return err(
        new ValidationError(
          `Unknown document template key "${input.templateKey}" - it must be registered via DOCUMENT_TEMPLATE_REGISTRY before a version can be published.`,
        ),
      );
    }

    const versionRow = await withTenantTx(ctx, async (tx) => {
      const templateRow = await this.upsertTemplate(tx, ctx, def.key, def.name);

      const existingVersions = await tx
        .select()
        .from(templateVersion)
        .where(eq(templateVersion.templateId, templateRow.id))
        .orderBy(desc(templateVersion.version))
        .limit(1);
      const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

      const [inserted] = await tx
        .insert(templateVersion)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          templateId: templateRow.id,
          version: nextVersion,
          htmlSource: input.html,
          cssSource: input.css,
          publishedAt: new Date(),
          createdByUserId: ctx.actorUserId ?? ctx.userId ?? null,
        })
        .returning();

      if (!inserted) throw new Error('documents.template_version insert returned no row.');
      return inserted;
    });

    return ok(toTemplateVersionRecord(versionRow, def.key));
  }

  private async upsertTemplate(tx: Tx, ctx: TenantContext, key: string, name: string): Promise<TemplateRow> {
    const [existing] = await tx
      .select()
      .from(template)
      .where(and(eq(template.tenantId, ctx.tenantId), eq(template.key, key)))
      .limit(1);
    if (existing) return existing;

    const [inserted] = await tx
      .insert(template)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        key,
        name,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!inserted) throw new Error('documents.template insert returned no row.');
    return inserted;
  }

  private async latestPublishedVersion(
    ctx: TenantContext,
    templateKey: string,
  ): Promise<TemplateVersionRow | undefined> {
    return withTenantTx(ctx, async (tx) => {
      const [templateRow] = await tx
        .select()
        .from(template)
        .where(and(eq(template.tenantId, ctx.tenantId), eq(template.key, templateKey)))
        .limit(1);
      if (!templateRow) return undefined;

      const [versionRow] = await tx
        .select()
        .from(templateVersion)
        .where(eq(templateVersion.templateId, templateRow.id))
        .orderBy(desc(templateVersion.version))
        .limit(1);
      return versionRow;
    });
  }

  /**
   * Merges the `DocumentTemplate`'s own baseline CSS with the tenant's
   * published `css_source` (tenant CSS wins, appended last) and drops both
   * into either the tenant's published wrapper (`html_source`, when
   * non-empty - a school restyling via CSS alone typically leaves this
   * blank) or the built-in fallback. `{{title}}`/`{{css}}`/`{{content}}` are
   * the placeholder contract a tenant's `html_source` may use.
   */
  private composeHtml(input: { bodyHtml: string; defaultCss: string; version: TemplateVersionRow; title: string }): string {
    const mergedCss = [input.defaultCss, input.version.cssSource].filter((css) => css.trim().length > 0).join('\n\n');
    const wrapper = input.version.htmlSource.trim().length > 0 ? input.version.htmlSource : DEFAULT_WRAPPER;

    return wrapper
      .replaceAll('{{title}}', escapeHtml(input.title))
      .replaceAll('{{css}}', mergedCss)
      .replaceAll('{{content}}', input.bodyHtml);
  }

  /**
   * `sha256(templateVersionId + canonical(data))` - a hash of the INPUT that
   * produced the document (see the module's design notes), not of the PDF
   * bytes. Deliberately includes the template version: the same data
   * rendered under a different version is, correctly, different content.
   * (Playwright's PDF bytes were also observed byte-identical across two
   * renders of identical HTML in this module's own verification - see the
   * module report - so hashing bytes directly would have worked too, but
   * hashing the data is the more robust, engine-independent choice.)
   */
  private computeContentHash(templateVersionId: string, data: unknown): string {
    return createHash('sha256').update(`${templateVersionId}:${canonicalizeJson(data)}`).digest('hex');
  }

  async generate(input: GenerateDocumentInput): Promise<Result<DocumentRecord, DomainError>> {
    const ctx = requireTenantContext();
    const def = this.registry.get(input.templateKey);
    if (!def) {
      return err(new ValidationError(`Unknown document template key "${input.templateKey}".`));
    }

    const parsed = def.dataSchema.safeParse(input.data);
    if (!parsed.success) {
      return err(new ValidationError('Document data failed the template\'s schema.', parsed.error.issues));
    }

    const versionRow = await this.latestPublishedVersion(ctx, input.templateKey);
    if (!versionRow) {
      return err(
        new PreconditionFailedError(
          `Template "${input.templateKey}" has no published version yet - call publishTemplateVersion first.`,
        ),
      );
    }

    const { html: bodyHtml, css: defaultCss } = await def.render(parsed.data);
    const finalHtml = this.composeHtml({ bodyHtml, defaultCss, version: versionRow, title: input.title });
    const { buffer, pageCount } = await this.renderer.renderToPdf(finalHtml);

    const documentId = newId();
    const storageKey = `documents/${ctx.tenantId}/${documentId}.pdf`;
    await this.storage.put({ key: storageKey, body: buffer, contentType: 'application/pdf' });

    const contentHash = this.computeContentHash(versionRow.id, parsed.data);

    const insertedRow = await withTenantTx(ctx, async (tx) => {
      const [row] = await tx
        .insert(document)
        .values({
          id: documentId,
          tenantId: ctx.tenantId,
          templateVersionId: versionRow.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          title: input.title,
          storageKey,
          contentHash,
          dataSnapshot: parsed.data as Record<string, unknown>,
          pageCount,
          bytes: buffer.byteLength,
          generatedByUserId: ctx.actorUserId ?? ctx.userId ?? null,
          generatedAt: new Date(),
          supersededByDocumentId: null,
        })
        .returning();
      if (!row) throw new Error('documents.document insert returned no row.');
      return row;
    });

    return ok(toDocumentRecord(insertedRow, input.templateKey, versionRow.version));
  }

  private async findDocumentWithTemplateKey(
    ctx: TenantContext,
    id: string,
  ): Promise<{ row: DocumentRow; templateKey: string; templateVersionNumber: number } | undefined> {
    return withTenantTx(ctx, async (tx) => {
      const [row] = await tx.select().from(document).where(and(eq(document.id, id), eq(document.tenantId, ctx.tenantId))).limit(1);
      if (!row) return undefined;

      const [versionRow] = await tx.select().from(templateVersion).where(eq(templateVersion.id, row.templateVersionId)).limit(1);
      if (!versionRow) return undefined;

      const [templateRow] = await tx.select().from(template).where(eq(template.id, versionRow.templateId)).limit(1);
      if (!templateRow) return undefined;

      return { row, templateKey: templateRow.key, templateVersionNumber: versionRow.version };
    });
  }

  async getDocument(id: string): Promise<Result<DocumentRecord, NotFoundError>> {
    const ctx = requireTenantContext();
    const found = await this.findDocumentWithTemplateKey(ctx, id);
    if (!found) return err(new NotFoundError(`Document "${id}" was not found.`));
    return ok(toDocumentRecord(found.row, found.templateKey, found.templateVersionNumber));
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentRecord[]> {
    const ctx = requireTenantContext();

    return withTenantTx(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(document)
        .where(
          and(
            eq(document.tenantId, ctx.tenantId),
            eq(document.subjectType, input.subjectType),
            eq(document.subjectId, input.subjectId),
          ),
        )
        .orderBy(desc(document.generatedAt));

      const versionIds = [...new Set(rows.map((r) => r.templateVersionId))];
      const versionRows = versionIds.length
        ? await tx.select().from(templateVersion).where(eq(templateVersion.tenantId, ctx.tenantId))
        : [];
      const versionsById = new Map(versionRows.map((v) => [v.id, v]));

      const templateIds = [...new Set([...versionsById.values()].map((v) => v.templateId))];
      const templateRows = templateIds.length
        ? await tx.select().from(template).where(eq(template.tenantId, ctx.tenantId))
        : [];
      const templatesById = new Map(templateRows.map((t) => [t.id, t]));

      return rows.map((row) => {
        const version = versionsById.get(row.templateVersionId);
        const templateKey = version ? (templatesById.get(version.templateId)?.key ?? '') : '';
        return toDocumentRecord(row, templateKey, version?.version ?? 0);
      });
    });
  }

  async getDownloadUrl(id: string): Promise<Result<DownloadUrl, NotFoundError>> {
    const ctx = requireTenantContext();
    const found = await this.findDocumentWithTemplateKey(ctx, id);
    if (!found) return err(new NotFoundError(`Document "${id}" was not found.`));

    // Documents can carry sensitive subject data (grades, medical notes on a
    // certificate, ...) - record who downloaded what about whom, same
    // reasoning as audit.access_log's other callers (see docs/decisions.md).
    await this.audit?.recordAccess({
      personId: found.row.subjectType === 'people.person' ? (found.row.subjectId as PersonId) : undefined,
      resource: `documents.document:${found.templateKey}`,
      fieldNames: ['pdf'],
    });

    const url = await this.storage.presignedGetUrl(found.row.storageKey, DOWNLOAD_URL_TTL_SECONDS);
    return ok({ url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000) });
  }

  async reissue(documentId: string, input: ReissueInput): Promise<Result<DocumentRecord, DomainError>> {
    const ctx = requireTenantContext();
    const found = await this.findDocumentWithTemplateKey(ctx, documentId);
    if (!found) return err(new NotFoundError(`Document "${documentId}" was not found.`));

    const generated = await this.generate({
      templateKey: found.templateKey,
      subjectType: found.row.subjectType,
      subjectId: found.row.subjectId,
      data: input.data,
      title: input.title ?? found.row.title,
    });
    if (!generated.ok) return generated;

    await withTenantTx(ctx, (tx) =>
      tx.update(document).set({ supersededByDocumentId: generated.value.id }).where(eq(document.id, documentId)),
    );

    return ok(generated.value);
  }
}
