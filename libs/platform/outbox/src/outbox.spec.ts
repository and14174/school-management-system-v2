import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type TenantContext } from '@sms/kernel';
import { closeSqlClients, createSqlClient, runWithContext, withTenantTx, type Sql } from '@sms/db';
import { OutboxService } from './application/outbox.service.js';
import { OutboxDispatcher } from './application/outbox.dispatcher.js';
import type { OutboxMessage, OutboxSubscriber } from './contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The outbox exists for exactly one property: the event is written in the same
 * transaction as the fact. These tests exercise that against a real Postgres,
 * because it is a transactional guarantee - a mock would happily "pass" while
 * the real thing published events for facts that never committed.
 */
describe('outbox (real Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let ownerSql: Sql;
  const outbox = new OutboxService();

  const TENANT_A = newId();
  const TENANT_B = newId();
  const ctxFor = (tenantId: string): TenantContext =>
    ({ tenantId, roles: [], requestId: newId(), userId: newId() }) as unknown as TenantContext;

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

    // Read the folder rather than naming files, so a new migration is exercised
    // automatically instead of being invisible to these tests.
    const dir = join(__dirname, '..', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await ownerSql.unsafe(readFileSync(join(dir, file), 'utf8'));
    }

    // A stand-in for a real domain table, so "the fact" and "the event" are
    // genuinely two writes in one transaction.
    await ownerSql`create table fact (id uuid primary key default uuidv7(), tenant_id uuid not null, note text)`;
    await ownerSql`grant usage on schema public to sms_app`;
    await ownerSql`grant select, insert on fact to sms_app`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'sms_app';
    appUrl.password = 'dev';
    process.env.DATABASE_URL = appUrl.toString();
    process.env.DATABASE_MIGRATION_URL = ownerUrl;
  }, 180_000);

  afterAll(async () => {
    await closeSqlClients();
    await ownerSql?.end({ timeout: 1 });
    await container?.stop();
  });

  it('commits the event together with the fact', async () => {
    const ctx = ctxFor(TENANT_A);

    await runWithContext(ctx, () =>
      withTenantTx(ctx, async (tx) => {
        await tx.execute(rawSql`insert into fact (tenant_id, note) values (${ctx.tenantId}, 'committed')`);
        await outbox.publish(tx, { topic: 'test.fact_created', payload: { note: 'committed' } });
      }),
    );

    const facts = await ownerSql`select note from fact where note = 'committed'`;
    const events = await ownerSql`select topic from outbox.message where payload->>'note' = 'committed'`;
    expect(facts.length).toBe(1);
    expect(events.length).toBe(1);
  });

  /**
   * The failure this design exists to prevent: announcing something that did not
   * happen. If the fact rolls back, the event must roll back with it - which is
   * only true because publish() writes through the caller's transaction rather
   * than opening its own.
   */
  it('loses the event when the fact rolls back - never announces a fact that did not happen', async () => {
    const ctx = ctxFor(TENANT_A);

    await expect(
      runWithContext(ctx, () =>
        withTenantTx(ctx, async (tx) => {
          await tx.execute(rawSql`insert into fact (tenant_id, note) values (${ctx.tenantId}, 'rolled-back')`);
          await outbox.publish(tx, { topic: 'test.fact_created', payload: { note: 'rolled-back' } });
          throw new Error('domain rule violated after publish');
        }),
      ),
    ).rejects.toThrow('domain rule violated');

    const facts = await ownerSql`select note from fact where note = 'rolled-back'`;
    const events = await ownerSql`select topic from outbox.message where payload->>'note' = 'rolled-back'`;
    expect(facts.length).toBe(0);
    expect(events.length).toBe(0); // the event died with the fact
  });

  it('dispatches to the subscribers for a topic and marks the message published', async () => {
    const ctx = ctxFor(TENANT_A);
    const seen: OutboxMessage[] = [];
    const subscriber: OutboxSubscriber = {
      topic: 'test.dispatched',
      handle: async (message) => {
        seen.push(message);
      },
    };

    await runWithContext(ctx, () =>
      withTenantTx(ctx, (tx) => outbox.publish(tx, { topic: 'test.dispatched', payload: { n: 1 } })),
    );

    const dispatcher = new OutboxDispatcher(outbox, [subscriber]);
    const result = await dispatcher.tick();

    expect(result.failed).toBe(0);
    expect(seen.some((m) => m.topic === 'test.dispatched')).toBe(true);

    const [row] = await ownerSql`
      select published_at from outbox.message where topic = 'test.dispatched'
    `;
    expect(row?.published_at).not.toBeNull();
  });

  it('records the error and backs off when a subscriber throws, leaving the message unpublished', async () => {
    const ctx = ctxFor(TENANT_A);
    const failing: OutboxSubscriber = {
      topic: 'test.failing',
      handle: async () => {
        throw new Error('downstream unavailable');
      },
    };

    await runWithContext(ctx, () =>
      withTenantTx(ctx, (tx) => outbox.publish(tx, { topic: 'test.failing', payload: {} })),
    );

    const result = await new OutboxDispatcher(outbox, [failing]).tick();
    expect(result.failed).toBeGreaterThan(0);

    const [row] = await ownerSql`
      select published_at, attempts, last_error from outbox.message where topic = 'test.failing'
    `;
    // Still owed to somebody - an undeliverable event must not be silently dropped.
    expect(row?.published_at).toBeNull();
    expect(Number(row?.attempts)).toBeGreaterThan(0);
    expect(String(row?.last_error)).toContain('downstream unavailable');
  });

  it('isolates one tenant from another', async () => {
    const ctxA = ctxFor(TENANT_A);
    const ctxB = ctxFor(TENANT_B);

    await runWithContext(ctxA, () =>
      withTenantTx(ctxA, (tx) => outbox.publish(tx, { topic: 'test.tenant_scoped', payload: { who: 'A' } })),
    );

    const seenByB = await runWithContext(ctxB, () => outbox.listRecent({ topic: 'test.tenant_scoped' }));
    expect(seenByB).toEqual([]);

    const seenByA = await runWithContext(ctxA, () => outbox.listRecent({ topic: 'test.tenant_scoped' }));
    expect(seenByA.length).toBe(1);
  });
});
