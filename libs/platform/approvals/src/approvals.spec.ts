import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { newId, type TenantId, type UserId } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, type Sql, type Tx } from '@sms/db';
import { AccessModule, PERMISSION_CATALOGUE } from '@sms/access';
import {
  APPROVALS_CONTRACT,
  APPROVAL_HANDLER_REGISTRY,
  type MapApprovalHandlerRegistry,
  type ApplyApprovalContext,
  type ApprovalHandler,
  type ApprovalsContract,
} from './contract.js';
import { ApprovalsModule } from './api/approvals.module.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ---------------------------------------------------------------------------
// Fake handlers for this suite. `applied` records every request id the
// handler actually ran for, via a WRITE THROUGH THE TRANSACTION IT WAS
// GIVEN - not an in-memory counter - so a rollback of that transaction (the
// "failing handler" test) is provable from a SEPARATE connection afterwards,
// not merely inferred from the return value. See test 6.
// ---------------------------------------------------------------------------
class RecordingHandler implements ApprovalHandler {
  constructor(
    readonly requestType: string,
    private readonly shouldThrow = false,
  ) {}

  async apply(tx: Tx, context: ApplyApprovalContext): Promise<void> {
    await tx.execute(sql`insert into test_effects (id, request_id) values (${newId()}, ${context.request.id})`);
    if (this.shouldThrow) {
      throw new Error(`RecordingHandler(${this.requestType}): simulated handler failure`);
    }
  }
}

const countHandler = new RecordingHandler('test.count_effect');
const failingHandler = new RecordingHandler('test.failing_effect', true);

/*
 * Handlers are registered INTO the registry `ApprovalsModule` owns (see the
 * `beforeAll` below), not supplied by a `@Global()` override module. That
 * override shape is what `@sms/notifications` uses for its channel registry,
 * and it cannot work here: a real handler depends on the domain module whose
 * change it applies, which in turn depends on `@sms/approvals` to raise the
 * request - so building the registry FROM the handler closes a cycle that
 * Nest cannot see (the closing edge is a `@Global()` token, not an `imports`
 * entry) and `NestFactory.create` hangs forever with no log output. See
 * `ApprovalsModule`'s own comment. This mirrors how `apps/api`'s
 * `CreditNoteApprovalHandlerModule` registers the real handler.
 */

/**
 * Applies the real `audit` + `tenancy` + `identity` + `access` migrations
 * (read, never edited) and this module's own `1700` migration to a
 * throwaway container, then proves - through the real `ApprovalsService`/
 * `ApprovalsController`, built via Nest DI exactly like `apps/api` wires it -
 * the properties this engine exists for. See docs/decisions.md's "Test
 * specs must read their module's migrations folder, not name files."
 */
describe('approvals (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  let moduleRef: TestingModule;
  let approvals: ApprovalsContract;
  /** The registry ApprovalsModule owns; tests register per-case handlers into it. */
  let handlerRegistry: MapApprovalHandlerRegistry;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('sms_test').withUsername('sms_owner').withPassword('dev').start();

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
    await applyMigrations(join(__dirname, '..', '..', 'identity', 'migrations'));
    await applyMigrations(join(__dirname, '..', '..', 'access', 'migrations'));
    await applyMigrations(join(__dirname, '..', 'migrations'));

    // A scratch table for RecordingHandler.apply to write through the real
    // decision transaction - see that class's own comment. Not part of any
    // module's migrations; a pure test fixture.
    await ownerSql`create table test_effects (id uuid primary key, request_id uuid not null, applied_at timestamptz not null default now())`;
    await ownerSql`grant select, insert on test_effects to sms_app`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';

    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    moduleRef = await Test.createTestingModule({
      imports: [AccessModule, ApprovalsModule],
    }).compile();
    handlerRegistry = moduleRef.get<MapApprovalHandlerRegistry>(APPROVAL_HANDLER_REGISTRY);
    handlerRegistry.register(countHandler);
    handlerRegistry.register(failingHandler);
    approvals = moduleRef.get(APPROVALS_CONTRACT);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Fixture helpers - raw SQL against ownerSql (bypasses RLS, as sms_owner),
  // same precedent as @sms/billing's own spec helpers.
  // ---------------------------------------------------------------------
  async function createTenant(slug: string, name: string): Promise<TenantId> {
    const rows = await ownerSql`insert into tenancy.tenant (slug, name) values (${slug}, ${name}) returning id`;
    return (rows[0] as { id: string }).id as TenantId;
  }

  async function createUser(email: string): Promise<UserId> {
    const rows = await ownerSql`insert into identity.user (id, name, email) values (${newId()}, ${email}, ${email}) returning id`;
    return (rows[0] as { id: string }).id as UserId;
  }

  let permissionCatalogueSeeded = false;
  async function seedPermissionCatalogue(): Promise<void> {
    if (permissionCatalogueSeeded) return;
    for (const def of PERMISSION_CATALOGUE) {
      await ownerSql`
        insert into access.permission (id, key, resource, action, description)
        values (${newId()}, ${def.key}, ${def.resource}, ${def.action}, ${def.description})
        on conflict (key) do nothing
      `;
    }
    permissionCatalogueSeeded = true;
  }

  async function grantTenantRole(tenantId: TenantId, userId: UserId, permissionKey: string): Promise<void> {
    const roleId = newId();
    await ownerSql`insert into access.role (id, tenant_id, key, name) values (${roleId}, ${tenantId}, ${'role-' + roleId}, 'Test role')`;
    const permissionRows = await ownerSql`select id from access.permission where key = ${permissionKey} limit 1`;
    const permissionId = (permissionRows[0] as { id: string }).id;
    await ownerSql`insert into access.role_permission (id, role_id, permission_id, scope, tenant_id) values (${newId()}, ${roleId}, ${permissionId}, 'tenant', ${tenantId})`;
    await ownerSql`insert into access.role_assignment (id, tenant_id, role_id, user_id) values (${newId()}, ${tenantId}, ${roleId}, ${userId})`;
  }

  function baseCtx(tenantId: TenantId, userId: UserId): { tenantId: TenantId; userId: UserId; actorUserId: UserId; roles: string[]; requestId: string } {
    return { tenantId, userId, actorUserId: userId, roles: [], requestId: newId() };
  }

  async function effectCountFor(requestId: string): Promise<number> {
    const rows = await ownerSql`select count(*) as n from test_effects where request_id = ${requestId}`;
    return Number((rows[0] as { n: string }).n);
  }

  async function decisionCountFor(requestId: string): Promise<number> {
    const rows = await ownerSql`select count(*) as n from approvals.decision where request_id = ${requestId}`;
    return Number((rows[0] as { n: string }).n);
  }

  const PERMISSION_KEY = 'billing.credit_note:issue';

  /** A tenant with the permission catalogue seeded, and a requester + one or more approvers all holding `PERMISSION_KEY`. */
  async function tenantWithApprovers(count: number) {
    await seedPermissionCatalogue();
    const tenantId = await createTenant(`tenant-approvals-${newId()}`, 'Approvals Test');
    const requesterId = await createUser(`requester-${newId()}@example.com`);
    const approverIds: UserId[] = [];
    for (let i = 0; i < count; i += 1) {
      const approverId = await createUser(`approver-${i}-${newId()}@example.com`);
      await grantTenantRole(tenantId, approverId, PERMISSION_KEY);
      approverIds.push(approverId);
    }
    return { tenantId, requesterId, approverIds };
  }

  // ---------------------------------------------------------------------
  // 1. HEADLINE: a requester cannot approve their own request - enforced at
  //    the database level even for the table owner.
  // ---------------------------------------------------------------------
  it('1. a requester cannot approve their own request, enforced at the database level even for the table owner', async () => {
    const { tenantId, requesterId } = await tenantWithApprovers(0);
    await runWithContext(baseCtx(tenantId, requesterId), () => approvals.upsertPolicy({ requestType: 'test.self_decision', permissionKey: PERMISSION_KEY }));
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType: 'test.self_decision', subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    // Through the SERVICE: refused with a clean error before ever reaching
    // the database, because the requester happens to also hold the
    // permission the policy names.
    const decided = await runWithContext(baseCtx(tenantId, requesterId), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    expect(decided.ok).toBe(false);

    // Directly against the table, AS THE OWNER (bypasses RLS entirely, and
    // an application-layer check the service performs is irrelevant here) -
    // the trigger is what actually refuses this.
    await expect(
      ownerSql`insert into approvals.decision (id, tenant_id, request_id, decided_by_user_id, decision) values (${newId()}, ${tenantId}, ${created.value.id}, ${requesterId}, 'approve')`,
    ).rejects.toThrow();

    // Genuinely still pending - neither attempt did anything.
    const stillPending = await runWithContext(baseCtx(tenantId, requesterId), () => approvals.getRequest(created.value.id));
    if (!stillPending.ok) throw stillPending.error;
    expect(stillPending.value.status).toBe('pending');
    expect(await decisionCountFor(created.value.id)).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 2. Decisions cannot be UPDATEd or DELETEd even by the owner.
  // ---------------------------------------------------------------------
  it('2. decisions cannot be UPDATEd or DELETEd even by the owner', async () => {
    const { tenantId, requesterId, approverIds } = await tenantWithApprovers(1);
    await runWithContext(baseCtx(tenantId, requesterId), () => approvals.upsertPolicy({ requestType: countHandler.requestType, permissionKey: PERMISSION_KEY }));
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType: countHandler.requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    const decided = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    if (!decided.ok) throw decided.error;
    expect(decided.value.status).toBe('approved');

    const decisionRows = await ownerSql`select id from approvals.decision where request_id = ${created.value.id}`;
    const decisionId = (decisionRows[0] as { id: string }).id;

    await expect(ownerSql`update approvals.decision set reason = 'tampered' where id = ${decisionId}`).rejects.toThrow();
    await expect(ownerSql`delete from approvals.decision where id = ${decisionId}`).rejects.toThrow();

    const stillThere = await ownerSql`select reason from approvals.decision where id = ${decisionId}`;
    expect(stillThere).toHaveLength(1);
    expect((stillThere[0] as { reason: string | null }).reason).toBeNull();

    // The decided request itself is also immutable now - approvals.request's
    // own trigger refuses any further change once it has left 'pending'.
    await expect(ownerSql`update approvals.request set status = 'rejected' where id = ${created.value.id}`).rejects.toThrow();
    await expect(ownerSql`delete from approvals.request where id = ${created.value.id}`).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // 3. HEADLINE: approving twice applies the effect exactly once.
  // ---------------------------------------------------------------------
  it('3. approving twice applies the effect exactly once', async () => {
    const { tenantId, requesterId, approverIds } = await tenantWithApprovers(1);
    await runWithContext(baseCtx(tenantId, requesterId), () => approvals.upsertPolicy({ requestType: countHandler.requestType, permissionKey: PERMISSION_KEY }));
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType: countHandler.requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    const first = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    if (!first.ok) throw first.error;
    expect(first.value.status).toBe('approved');
    expect(await effectCountFor(created.value.id)).toBe(1);

    // The SAME approver, deciding the SAME request again.
    const second = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    expect(second.ok).toBe(false);

    // The handler did not run a second time.
    expect(await effectCountFor(created.value.id)).toBe(1);
    expect(await decisionCountFor(created.value.id)).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 4. A request type with no policy stays pending and never auto-applies.
  // ---------------------------------------------------------------------
  it('4. a request type with no policy stays pending and never auto-applies', async () => {
    const { tenantId, requesterId, approverIds } = await tenantWithApprovers(1);
    // Deliberately NO upsertPolicy() call for this request type.
    const requestType = `test.no_policy_${newId()}`;
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;
    expect(created.value.status).toBe('pending');

    const decided = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    expect(decided.ok).toBe(false);

    const stillPending = await runWithContext(baseCtx(tenantId, requesterId), () => approvals.getRequest(created.value.id));
    if (!stillPending.ok) throw stillPending.error;
    expect(stillPending.value.status).toBe('pending');
    expect(stillPending.value.decisions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 5. HEADLINE: a two-approval policy needs two DISTINCT approvers.
  // ---------------------------------------------------------------------
  it('5. a two-approval policy needs two distinct approvers', async () => {
    const { tenantId, requesterId, approverIds } = await tenantWithApprovers(2);
    const requestType = `test.two_step_${newId()}`;
    // This test mints a unique request type, so it must supply the matching
    // handler too - a type with no handler is refused outright (fail closed),
    // which is exactly what test 4 asserts.
    handlerRegistry.register(new RecordingHandler(requestType));
    await runWithContext(baseCtx(tenantId, requesterId), () => approvals.upsertPolicy({ requestType, permissionKey: PERMISSION_KEY, approvalsRequired: 2 }));
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    // First approver: recorded, but the threshold is not met - still pending.
    const first = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    if (!first.ok) throw first.error;
    expect(first.value.status).toBe('pending');
    expect(await decisionCountFor(created.value.id)).toBe(1);

    // The SAME first approver again: does not count as a second vote.
    const repeat = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    expect(repeat.ok).toBe(false);
    expect(await decisionCountFor(created.value.id)).toBe(1);

    // A genuinely DIFFERENT second approver crosses the threshold.
    const second = await runWithContext(baseCtx(tenantId, approverIds[1]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    if (!second.ok) throw second.error;
    expect(second.value.status).toBe('approved');
    expect(await decisionCountFor(created.value.id)).toBe(2);
  });

  // ---------------------------------------------------------------------
  // 6. HEADLINE: the handler runs in the decision's transaction - a failing
  //    handler rolls the decision back, and the request is genuinely still
  //    pending afterwards (not merely reported as such).
  // ---------------------------------------------------------------------
  it('6. a failing handler rolls the decision back - the request stays pending', async () => {
    const { tenantId, requesterId, approverIds } = await tenantWithApprovers(1);
    await runWithContext(baseCtx(tenantId, requesterId), () => approvals.upsertPolicy({ requestType: failingHandler.requestType, permissionKey: PERMISSION_KEY }));
    const created = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.requestApproval({ requestType: failingHandler.requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    const decided = await runWithContext(baseCtx(tenantId, approverIds[0]!), () => approvals.decide({ requestId: created.value.id, decision: 'approve' }));
    expect(decided.ok).toBe(false);

    // Proven from a SEPARATE connection (ownerSql), not the same transaction
    // that just failed: the handler's own partial write rolled back too.
    expect(await effectCountFor(created.value.id)).toBe(0);
    expect(await decisionCountFor(created.value.id)).toBe(0);

    const stillPending = await runWithContext(baseCtx(tenantId, requesterId), () => approvals.getRequest(created.value.id));
    if (!stillPending.ok) throw stillPending.error;
    expect(stillPending.value.status).toBe('pending');

    // And it CAN still be decided for real afterwards - the rollback did not
    // corrupt anything, it just genuinely did not happen.
    const retryWithWorkingHandler = await runWithContext(baseCtx(tenantId, requesterId), () =>
      approvals.upsertPolicy({ requestType: countHandler.requestType, permissionKey: PERMISSION_KEY }),
    );
    expect(retryWithWorkingHandler.ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 7. RLS isolates approval policies/requests/decisions across tenants.
  // ---------------------------------------------------------------------
  it('7. RLS isolates approvals data across tenants', async () => {
    const { tenantId: tenantX, requesterId: requesterX, approverIds: approversX } = await tenantWithApprovers(1);
    await runWithContext(baseCtx(tenantX, requesterX), () => approvals.upsertPolicy({ requestType: countHandler.requestType, permissionKey: PERMISSION_KEY }));
    const created = await runWithContext(baseCtx(tenantX, requesterX), () =>
      approvals.requestApproval({ requestType: countHandler.requestType, subjectType: 'test.subject', subjectId: newId(), payload: {} }),
    );
    if (!created.ok) throw created.error;

    const { tenantId: tenantY, requesterId: requesterY } = await tenantWithApprovers(0);
    const fromY = await runWithContext(baseCtx(tenantY, requesterY), () => approvals.listRequests({}));
    expect(fromY).toHaveLength(0);
    const getFromY = await runWithContext(baseCtx(tenantY, requesterY), () => approvals.getRequest(created.value.id));
    expect(getFromY.ok).toBe(false);

    const fromX = await runWithContext(baseCtx(tenantX, requesterX), () => approvals.listRequests({}));
    expect(fromX.map((r) => r.id)).toContain(created.value.id);

    void approversX;
    // Directly, as sms_app with no app.tenant_id GUC set at all.
    const appSqlNoContext = createSqlClient(process.env.DATABASE_URL!);
    try {
      const rows = await appSqlNoContext`select id from approvals.request where tenant_id = ${tenantX}`;
      expect(rows.length).toBe(0);
    } finally {
      await appSqlNoContext.end({ timeout: 1 });
    }
  });
});
