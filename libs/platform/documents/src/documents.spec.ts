import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Global, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ForbiddenError, newId, type PersonId, type TenantContext, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, withTenantTx, type Sql } from '@sms/db';
import { AUDIT_CONTRACT, AuditModule, type AuditContract } from '@sms/audit';
import {
  ACCESS_CONTRACT,
  AccessModule,
  DEPENDANT_SCOPE_RESOLVER,
  PERMISSION_CATALOGUE,
  type AccessContract,
  type DependantScopeResolver,
} from '@sms/access';
import { DocumentsController } from './api/documents.controller.js';
import { DocumentsModule } from './api/documents.module.js';
import { DocumentsService } from './application/documents.service.js';
import { PdfRenderer } from './infrastructure/pdf-renderer.js';
import { S3ObjectStorage } from './infrastructure/object-storage.js';
import { sampleCertificateTemplate, type SampleCertificateData } from './domain/sample-certificate.template.js';
import type { DocumentTemplate } from './domain/types.js';
import { DOCUMENT_TEMPLATE_REGISTRY, type DocumentTemplateRegistry } from './application/template-registry.js';

// ---------------------------------------------------------------------------
// A minimal, real DEPENDANT_SCOPE_RESOLVER for this test module - the default
// the port ships with resolves to nothing (see docs/decisions.md's
// "Unresolvable permission scopes deny, never widen"), so a `dependants`-
// scoped grant would silently return zero rows without this. Duplicated from
// `apps/api`'s `DependantScopeResolverModule` rather than imported (that
// module lives in `type:app`, unreachable from this `type:platform` package's
// tests) - same precedent as `@sms/billing`'s `billing.spec.ts`.
// ---------------------------------------------------------------------------
@Injectable()
class TestDependantScopeResolver implements DependantScopeResolver {
  async resolveDependantPersonIds(userId: UserId, tenantId: TenantId): Promise<PersonId[]> {
    const rows = await withTenantTx({ tenantId, roles: [], requestId: newId() }, (db) =>
      db.execute<{ to_person_id: string }>(sql`
        select distinct r.to_person_id
        from people.relationship r
        join identity.membership m on m.person_id = r.from_person_id and m.tenant_id = r.tenant_id
        where r.tenant_id = ${tenantId} and m.user_id = ${userId} and r.type in ('parent', 'guardian')
      `),
    );
    return (rows as unknown as Array<{ to_person_id: string }>).map((row) => row.to_person_id as PersonId);
  }
}

@Global()
@Module({
  providers: [TestDependantScopeResolver, { provide: DEPENDANT_SCOPE_RESOLVER, useExisting: TestDependantScopeResolver }],
  exports: [DEPENDANT_SCOPE_RESOLVER],
})
class TestDependantScopeResolverModule {}

const __dirname = dirname(fileURLToPath(import.meta.url));

// MinIO/S3 config for local dev (see .env.example) - set here rather than
// relying on a loaded .env so the suite is self-contained, same reasoning as
// DATABASE_URL being set below from the testcontainers connection rather
// than from the environment.
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_BUCKET ??= 'sms-dev';
process.env.S3_ACCESS_KEY ??= 'minioadmin';
process.env.S3_SECRET_KEY ??= 'minioadmin';
process.env.S3_FORCE_PATH_STYLE ??= 'true';

const registry: DocumentTemplateRegistry = {
  list: () => [{ key: sampleCertificateTemplate.key, name: sampleCertificateTemplate.name }],
  get: (key: string): DocumentTemplate | undefined => (key === sampleCertificateTemplate.key ? sampleCertificateTemplate : undefined),
};

/**
 * `@Global()`, exactly like `apps/api`'s real `DocumentTemplatesModule` -
 * see that file's own comment for why this is the one mechanism that lets
 * `DocumentsModule`'s own `DocumentsService` (built via Nest DI below, for
 * the `DocumentsController` scope-narrowing tests) see this token at all.
 */
@Global()
@Module({
  providers: [{ provide: DOCUMENT_TEMPLATE_REGISTRY, useValue: registry }],
  exports: [DOCUMENT_TEMPLATE_REGISTRY],
})
class TestDocumentTemplateRegistryModule {}

const SAMPLE_DATA: SampleCertificateData = {
  recipientName: 'Ada Lovelace',
  achievement: 'Outstanding Mathematics',
  issuedOn: '2026-03-15',
  issuer: 'Greenwood Academy',
};

/**
 * Applies the real `audit` + `tenancy` migrations (read, never edited) and
 * this module's own `1100` migration to a throwaway Postgres container, then
 * proves - through the real `DocumentsService`, real Chromium/Playwright and
 * the real, locally-running MinIO (`.env.example`'s `S3_*` vars; `docker ps`
 * shows `sms-minio-1` reachable from this process) - the properties this
 * module exists for. Same structure as `@sms/import-export`'s
 * `import-export.spec.ts`.
 *
 * No in-memory storage fake: MinIO was reachable from the test environment
 * (verified directly with a scratch `PutObjectCommand` before writing this
 * suite - see the module report), so exercising the real `S3ObjectStorage`
 * proves more than a fake would.
 */
describe('documents (real Postgres + real Chromium + real MinIO)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let audit: AuditContract;
  let auditAppContext: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let renderer: PdfRenderer;
  let storage: S3ObjectStorage;
  let documents: DocumentsService;
  // Built via real Nest DI (AccessModule + a test DEPENDANT_SCOPE_RESOLVER +
  // DocumentsModule), exactly like `apps/api` wires it - for the
  // `DocumentsController` scope-narrowing tests below, which exercise the
  // real controller rather than `DocumentsService` directly.
  let moduleRef: TestingModule;
  let access: AccessContract;
  let documentsController: DocumentsController;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_owner')
      .withPassword('dev')
      .start();

    const ownerUrl = container.getConnectionUri();
    ownerSql = createSqlClient(ownerUrl);

    await ownerSql`create role sms_app with login password 'dev' nobypassrls`;
    await ownerSql`grant connect on database sms_test to sms_app`;

    const applyMigrations = async (dir: string): Promise<void> => {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const file of files) {
        await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
      }
    };

    await applyMigrations(join(__dirname, '..', '..', 'audit', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'tenancy', 'migrations'));
    // documents.template_version.created_by_user_id / document.generated_by_user_id
    // FK identity.user - same precedent as @sms/attendance's, @sms/academic's,
    // @sms/enrollment's and @sms/people's own specs applying identity's
    // migrations for the same reason.
    await applyMigrations(join(__dirname, '..', '..', 'identity', 'migrations'));
    // access (roles/permissions/scopes) and people (person/relationship, for
    // the DEPENDANT_SCOPE_RESOLVER's guardian walk) - needed only by the
    // DocumentsController scope-narrowing tests below, not by DocumentsService
    // itself (which has no idea what either of those modules is - see the
    // 1100 migration header).
    await applyMigrations(join(__dirname, '..', '..', 'access', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', '..', 'domain', 'people', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'documents', 'migrations'));

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';
    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    // A real AuditContract through @sms/audit's PUBLIC entrypoint - this
    // package may never import @sms/audit's internal AuditService directly
    // (module boundary: only a sibling's public entrypoint is reachable).
    auditAppContext = await NestFactory.createApplicationContext(AuditModule, { logger: false });
    audit = auditAppContext.get<AuditContract>(AUDIT_CONTRACT);

    renderer = new PdfRenderer();
    storage = new S3ObjectStorage();
    documents = new DocumentsService(registry, renderer, storage, audit);

    moduleRef = await Test.createTestingModule({
      imports: [AccessModule, TestDependantScopeResolverModule, TestDocumentTemplateRegistryModule, DocumentsModule],
    }).compile();
    access = moduleRef.get(ACCESS_CONTRACT);
    documentsController = moduleRef.get(DocumentsController);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await renderer?.onModuleDestroy();
    await auditAppContext?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  // documents.template_version.created_by_user_id / document.generated_by_user_id
  // FK identity.user - a real row is required, same precedent as
  // @sms/attendance's attendance.spec.ts createUser helper.
  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  async function ctxFor(tenantId: TenantId): Promise<TenantContext> {
    const userId = await createUser(`${newId()}@example.com`);
    return { tenantId, roles: [], requestId: newId(), userId, actorUserId: userId };
  }

  async function downloadBytes(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // ---------------------------------------------------------------------
  // Fixture helpers for the DocumentsController scope-narrowing tests below
  // - same shape as `@sms/billing`'s `billing.spec.ts` (the reference
  // precedent for testing a `dependants`-scoped controller through real
  // Nest DI).
  // ---------------------------------------------------------------------

  async function createPerson(tenantId: TenantId, givenName: string, familyName: string): Promise<PersonId> {
    const rows = await ownerSql`
      insert into people.person (id, tenant_id, given_name, family_name) values (${newId()}, ${tenantId}, ${givenName}, ${familyName}) returning id
    `;
    return (rows[0] as { id: string }).id as PersonId;
  }

  async function createMembership(tenantId: TenantId, userId: UserId, personId?: PersonId): Promise<void> {
    await ownerSql`
      insert into identity.membership (id, tenant_id, user_id, person_id, status)
      values (${newId()}, ${tenantId}, ${userId}, ${personId ?? null}, 'active')
    `;
  }

  async function createGuardianRelationship(tenantId: TenantId, guardianPersonId: PersonId, childPersonId: PersonId): Promise<void> {
    await ownerSql`
      insert into people.relationship (id, tenant_id, from_person_id, to_person_id, type)
      values (${newId()}, ${tenantId}, ${guardianPersonId}, ${childPersonId}, 'parent')
    `;
  }

  async function seedPermissionCatalogue(): Promise<void> {
    for (const def of PERMISSION_CATALOGUE) {
      await ownerSql`
        insert into access.permission (id, key, resource, action, description)
        values (${newId()}, ${def.key}, ${def.resource}, ${def.action}, ${def.description})
        on conflict (key) do nothing
      `;
    }
  }

  /** A role granting exactly `permissionKey` at `scope`, assigned to `userId` in `tenantId`. */
  async function grantScopedRole(tenantId: TenantId, userId: UserId, permissionKey: string, scope: string): Promise<void> {
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    const permissionRows = await ownerSql`select id from access.permission where key = ${permissionKey} limit 1`;
    const permissionId = (permissionRows[0] as { id: string }).id;
    await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, ${scope}, ${tenantId})`;
    await ownerSql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`;
  }

  function baseCtx(tenantId: TenantId, userId?: UserId, personId?: PersonId): TenantContext {
    return {
      tenantId,
      ...(userId ? { userId, actorUserId: userId } : {}),
      ...(personId ? { personId } : {}),
      roles: [],
      requestId: newId(),
    } as TenantContext;
  }

  it('generate produces a real PDF, stores it, and records the content hash + data snapshot', async () => {
    const tenantId = await createTenant(`gen-${newId()}`, 'Generate Tenant');
    const ctx = await ctxFor(tenantId);

    await runWithContext(ctx, async () => {
      const published = await documents.publishTemplateVersion({
        templateKey: 'sample-certificate',
        html: '',
        css: 'body { background: #ffffff; }',
      });
      expect(published.ok).toBe(true);

      const generated = await documents.generate({
        templateKey: 'sample-certificate',
        subjectType: 'test.subject',
        subjectId: newId(),
        title: 'Certificate of Achievement',
        data: SAMPLE_DATA,
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;

      const record = generated.value;
      expect(record.pageCount).toBeGreaterThanOrEqual(1);
      expect(record.bytes).toBeGreaterThan(500); // a real, non-trivial PDF, not a stub
      expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
      expect(record.dataSnapshot).toEqual(SAMPLE_DATA);

      const urlResult = await documents.getDownloadUrl(record.id);
      expect(urlResult.ok).toBe(true);
      if (!urlResult.ok) return;

      const bytes = await downloadBytes(urlResult.value.url);
      expect(bytes.byteLength).toBe(record.bytes);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // the real magic bytes
    });
  });

  it('regenerating from the same data produces the same content hash; different data produces a different one', async () => {
    const tenantId = await createTenant(`hash-${newId()}`, 'Hash Tenant');
    const ctx = await ctxFor(tenantId);

    await runWithContext(ctx, async () => {
      await documents.publishTemplateVersion({ templateKey: 'sample-certificate', html: '', css: '' });

      const genInput = {
        templateKey: 'sample-certificate',
        subjectType: 'test.subject',
        subjectId: newId(),
        title: 'Certificate',
      };

      const first = await documents.generate({ ...genInput, data: SAMPLE_DATA });
      const second = await documents.generate({ ...genInput, data: SAMPLE_DATA });
      const different = await documents.generate({
        ...genInput,
        data: { ...SAMPLE_DATA, achievement: 'A Different Achievement' },
      });

      expect(first.ok && second.ok && different.ok).toBe(true);
      if (!first.ok || !second.ok || !different.ok) return;

      expect(first.value.id).not.toBe(second.value.id); // two distinct documents ...
      expect(first.value.contentHash).toBe(second.value.contentHash); // ... but identical content
      expect(first.value.contentHash).not.toBe(different.value.contentHash);
    });
  });

  it('HEADLINE: a document keeps its original bytes after its template gets a new version', async () => {
    const tenantId = await createTenant(`stable-${newId()}`, 'Stable Tenant');
    const ctx = await ctxFor(tenantId);

    await runWithContext(ctx, async () => {
      const v1 = await documents.publishTemplateVersion({
        templateKey: 'sample-certificate',
        html: '',
        css: 'body { background: #ffffff; }',
      });
      expect(v1.ok).toBe(true);
      if (!v1.ok) return;

      const generated = await documents.generate({
        templateKey: 'sample-certificate',
        subjectType: 'test.subject',
        subjectId: newId(),
        title: 'Certificate of Achievement',
        data: SAMPLE_DATA,
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const original = generated.value;

      const originalUrl = await documents.getDownloadUrl(original.id);
      expect(originalUrl.ok).toBe(true);
      if (!originalUrl.ok) return;
      const originalBytes = await downloadBytes(originalUrl.value.url);

      // Publish a materially different template version - a school
      // restyling the certificate with new CSS.
      const v2 = await documents.publishTemplateVersion({
        templateKey: 'sample-certificate',
        html: '',
        css: 'body { background: #000000; color: #ffffff; }',
      });
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.value.version).toBe(v1.value.version + 1);

      // The already-issued document must be completely unaffected.
      const reread = await documents.getDocument(original.id);
      expect(reread.ok).toBe(true);
      if (!reread.ok) return;

      expect(reread.value.templateVersionId).toBe(v1.value.id); // still points at v1, not v2
      expect(reread.value.templateVersionId).not.toBe(v2.value.id);
      expect(reread.value.contentHash).toBe(original.contentHash);
      expect(reread.value.storageKey).toBe(original.storageKey);

      const rereadUrl = await documents.getDownloadUrl(original.id);
      expect(rereadUrl.ok).toBe(true);
      if (!rereadUrl.ok) return;
      const rereadBytes = await downloadBytes(rereadUrl.value.url);

      expect(Buffer.compare(rereadBytes, originalBytes)).toBe(0); // byte-for-byte identical
    });
  });

  it('reissue creates a new document and supersedes the original', async () => {
    const tenantId = await createTenant(`reissue-${newId()}`, 'Reissue Tenant');
    const ctx = await ctxFor(tenantId);

    await runWithContext(ctx, async () => {
      await documents.publishTemplateVersion({ templateKey: 'sample-certificate', html: '', css: '' });

      const subjectId = newId();
      const generated = await documents.generate({
        templateKey: 'sample-certificate',
        subjectType: 'test.subject',
        subjectId,
        title: 'Certificate of Achievement',
        data: SAMPLE_DATA,
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const original = generated.value;
      expect(original.supersededByDocumentId).toBeNull();

      const reissued = await documents.reissue(original.id, {
        data: { ...SAMPLE_DATA, achievement: 'Corrected Achievement Title' },
      });
      expect(reissued.ok).toBe(true);
      if (!reissued.ok) return;

      expect(reissued.value.id).not.toBe(original.id);
      expect(reissued.value.subjectId).toBe(subjectId);
      expect(reissued.value.dataSnapshot.achievement).toBe('Corrected Achievement Title');

      const rereadOriginal = await documents.getDocument(original.id);
      expect(rereadOriginal.ok).toBe(true);
      if (!rereadOriginal.ok) return;
      expect(rereadOriginal.value.supersededByDocumentId).toBe(reissued.value.id);
    });
  });

  it('isolates templates and documents across tenants (RLS)', async () => {
    const tenantA = await createTenant(`rls-a-${newId()}`, 'Tenant A');
    const tenantB = await createTenant(`rls-b-${newId()}`, 'Tenant B');
    const ctxA = await ctxFor(tenantA);
    const ctxB = await ctxFor(tenantB);
    const subjectId = newId();

    const documentId = await runWithContext(ctxA, async () => {
      await documents.publishTemplateVersion({ templateKey: 'sample-certificate', html: '', css: '' });
      const generated = await documents.generate({
        templateKey: 'sample-certificate',
        subjectType: 'test.subject',
        subjectId,
        title: 'Certificate of Achievement',
        data: SAMPLE_DATA,
      });
      expect(generated.ok).toBe(true);
      return generated.ok ? generated.value.id : undefined;
    });
    expect(documentId).toBeDefined();

    await runWithContext(ctxB, async () => {
      // Tenant B has published nothing - the sample template shows up
      // (it's registered in code) but with no tenant-scoped rows behind it.
      const templatesForB = await documents.listTemplates();
      const sample = templatesForB.find((t) => t.key === 'sample-certificate');
      expect(sample?.id).toBeNull();
      expect(sample?.latestVersion).toBeNull();

      // Same subjectId reused deliberately: isolation must come from
      // tenant_id, not from subject identity being different.
      const listForB = await documents.listDocuments({ subjectType: 'test.subject', subjectId });
      expect(listForB).toEqual([]);

      const getForB = await documents.getDocument(documentId!);
      expect(getForB.ok).toBe(false);
    });

    // Sanity: tenant A still sees its own document.
    await runWithContext(ctxA, async () => {
      const listForA = await documents.listDocuments({ subjectType: 'test.subject', subjectId });
      expect(listForA.length).toBe(1);
    });
  });

  it('a published template version cannot be UPDATEd or DELETEd at the table level', async () => {
    const tenantId = await createTenant(`immutable-${newId()}`, 'Immutable Tenant');
    const ctx = await ctxFor(tenantId);

    const publishedVersionId = await runWithContext(ctx, async () => {
      const published = await documents.publishTemplateVersion({
        templateKey: 'sample-certificate',
        html: '',
        css: 'body { color: red; }',
      });
      expect(published.ok).toBe(true);
      return published.ok ? published.value.id : undefined;
    });
    expect(publishedVersionId).toBeDefined();
    const versionId = publishedVersionId as string;

    await expect(
      ownerSql`update documents.template_version set css_source = 'body { color: blue; }' where id = ${versionId}`,
    ).rejects.toThrow(/immutable/i);

    await expect(ownerSql`delete from documents.template_version where id = ${versionId}`).rejects.toThrow(/immutable/i);

    // The row is genuinely untouched, not just "the statement errored".
    const [row] = await ownerSql`select css_source from documents.template_version where id = ${versionId}`;
    expect((row as { css_source: string }).css_source).toBe('body { color: red; }');
  });

  // ---------------------------------------------------------------------
  // DocumentsController scope narrowing (docs/decisions.md's
  // "`documents.document:read` must not be wired up until that controller
  // has scope narrowing"). Through the real `DocumentsController`, built via
  // Nest DI exactly like `apps/api` wires it - not a reimplementation.
  // ---------------------------------------------------------------------

  it('a dependants-scoped caller sees only their own children\'s documents, filtered before the query ever runs', async () => {
    const tenantId = await createTenant(`docs-dependants-${newId()}`, 'Docs Dependants');
    const ctx = baseCtx(tenantId);

    const guardianPerson = await createPerson(tenantId, 'Rosa', 'Guardian');
    const childA = await createPerson(tenantId, 'Mateo', 'Child');
    const childB = await createPerson(tenantId, 'Sofia', 'Child');
    const otherStudent = await createPerson(tenantId, 'Someone', 'Else');
    await createGuardianRelationship(tenantId, guardianPerson, childA);
    await createGuardianRelationship(tenantId, guardianPerson, childB);

    await runWithContext(ctx, () => documents.publishTemplateVersion({ templateKey: 'sample-certificate', html: '', css: '' }));

    async function issueFor(subjectId: PersonId) {
      return runWithContext(ctx, async () => {
        const generated = await documents.generate({
          templateKey: 'sample-certificate',
          subjectType: 'people.person',
          subjectId,
          title: 'Certificate',
          data: SAMPLE_DATA,
        });
        if (!generated.ok) throw generated.error;
        return generated.value;
      });
    }

    const docA = await issueFor(childA);
    const docB = await issueFor(childB);
    const docOther = await issueFor(otherStudent);

    await seedPermissionCatalogue();
    const guardianUserId = await createUser(`doc-guardian-${newId()}@example.com`);
    await createMembership(tenantId, guardianUserId, guardianPerson);
    await grantScopedRole(tenantId, guardianUserId, 'documents.document:read', 'dependants');

    const constraints = await access.resolveScopeConstraints(guardianUserId, tenantId);
    const constraint = constraints['documents.document:read'];
    expect(constraint?.kind).toBe('dependants');
    if (constraint?.kind === 'dependants') {
      expect([...constraint.personIds].sort()).toEqual([childA, childB].sort());
    }

    const guardianCtx = baseCtx(tenantId, guardianUserId, guardianPerson);

    // The list endpoint, through the real controller: exactly their own
    // child's document for a subject they may read...
    const visibleA = await runWithContext(guardianCtx, () =>
      documentsController.listDocuments({ subjectType: 'people.person', subjectId: childA }),
    );
    expect(visibleA.map((d) => d.id)).toEqual([docA.id]);

    const visibleB = await runWithContext(guardianCtx, () =>
      documentsController.listDocuments({ subjectType: 'people.person', subjectId: childB }),
    );
    expect(visibleB.map((d) => d.id)).toEqual([docB.id]);

    // ...and denied OUTRIGHT (not an empty list) for a subject who is not
    // their child - the query for that subject must never even run.
    await expect(
      runWithContext(guardianCtx, () => documentsController.listDocuments({ subjectType: 'people.person', subjectId: otherStudent })),
    ).rejects.toThrow(ForbiddenError);

    // Single-record reads: their own child's document succeeds...
    const ownRead = await runWithContext(guardianCtx, () => documentsController.getDocument(docA.id));
    expect(ownRead.id).toBe(docA.id);
    const ownDownload = await runWithContext(guardianCtx, () => documentsController.getDownloadUrl(docA.id));
    expect(ownDownload.url).toBeTruthy();

    // ...and another student's document, fetched directly by id, is denied
    // outright - fetching by id must not be a back door around the list
    // constraint.
    await expect(runWithContext(guardianCtx, () => documentsController.getDocument(docOther.id))).rejects.toThrow(ForbiddenError);
    await expect(runWithContext(guardianCtx, () => documentsController.getDownloadUrl(docOther.id))).rejects.toThrow(ForbiddenError);
  });

  it('an unmappable subject type is denied for a non-tenant caller, even against their own child\'s person id', async () => {
    const tenantId = await createTenant(`docs-unmappable-${newId()}`, 'Docs Unmappable');
    const ctx = baseCtx(tenantId);

    const guardianPerson = await createPerson(tenantId, 'Priya', 'Guardian');
    const child = await createPerson(tenantId, 'Arjun', 'Child');
    await createGuardianRelationship(tenantId, guardianPerson, child);

    await runWithContext(ctx, () => documents.publishTemplateVersion({ templateKey: 'sample-certificate', html: '', css: '' }));

    // subjectType is deliberately NOT 'people.person' - the only subject type
    // this platform module can map to a PersonId (see
    // `DocumentsController.assertSubjectAccess`'s own comment). subjectId is
    // deliberately set to the CHILD's own person id, to prove the denial
    // comes from the unmapped subjectType and not from a personId mismatch.
    const otherTypeDoc = await runWithContext(ctx, async () => {
      const generated = await documents.generate({
        templateKey: 'sample-certificate',
        subjectType: 'academic.report_card',
        subjectId: child,
        title: 'Report Card',
        data: SAMPLE_DATA,
      });
      if (!generated.ok) throw generated.error;
      return generated.value;
    });

    await seedPermissionCatalogue();
    const guardianUserId = await createUser(`unmap-guardian-${newId()}@example.com`);
    await createMembership(tenantId, guardianUserId, guardianPerson);
    await grantScopedRole(tenantId, guardianUserId, 'documents.document:read', 'dependants');
    const guardianCtx = baseCtx(tenantId, guardianUserId, guardianPerson);

    await expect(
      runWithContext(guardianCtx, () => documentsController.listDocuments({ subjectType: 'academic.report_card', subjectId: child })),
    ).rejects.toThrow(ForbiddenError);
    await expect(runWithContext(guardianCtx, () => documentsController.getDocument(otherTypeDoc.id))).rejects.toThrow(ForbiddenError);
    await expect(runWithContext(guardianCtx, () => documentsController.getDownloadUrl(otherTypeDoc.id))).rejects.toThrow(ForbiddenError);

    // A tenant-scoped caller is unaffected - this is narrowing for
    // non-tenant scopes, not a blanket regression.
    const adminUserId = await createUser(`unmap-admin-${newId()}@example.com`);
    await grantScopedRole(tenantId, adminUserId, 'documents.document:read', 'tenant');
    const adminCtx = baseCtx(tenantId, adminUserId);
    const adminRead = await runWithContext(adminCtx, () => documentsController.getDocument(otherTypeDoc.id));
    expect(adminRead.id).toBe(otherTypeDoc.id);
  });
});
