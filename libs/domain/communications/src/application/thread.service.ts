import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  newId,
  type DomainError,
  type NotFoundError as NotFoundErrorType,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { ListThreadsInput, MarkThreadReadInput, PostMessageInput, PostMessageResult, StartThreadInput } from '../contract.js';
import type { Thread, ThreadDetail } from '../domain/types.js';
import { toMessage, toThread, toThreadParticipant } from '../infrastructure/mappers.js';
import { messageTable, threadParticipantTable, threadTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

type UnreadThreadCountRow = { readonly n: string };

/**
 * Threads, their participants, and append-only messages. See the `1350`
 * migration header: every thread is anchored to a subject, every message is
 * append-only, and `postMessage` is idempotent on its key - same pattern as
 * `@sms/attendance`'s `AttendanceRecordService.markSession`.
 */
@Injectable()
export class ThreadService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  /**
   * Creates the thread, its participants (`participantPersonIds[0]` becomes
   * `owner`, the rest `participant`), and the opening message - one
   * transaction, one `communications.message_posted` outbox event.
   */
  async startThread(tenantId: TenantId, actorUserId: string | null, input: StartThreadInput): Promise<Result<Thread, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const participantIds = [...new Set(input.participantPersonIds)];
      const authorPersonId = participantIds[0];
      if (!authorPersonId) {
        throw new ValidationError('startThread requires at least one participant.');
      }

      const updatedThread = await withTenantTx(ctx, async (db) => {
        const threadRows = await db
          .insert(threadTable)
          .values({
            id: newId(),
            tenantId,
            subject: input.subject,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            status: 'open',
            createdByUserId: actorUserId,
          })
          .returning();
        const thread = threadRows[0]!;

        for (const [index, personId] of participantIds.entries()) {
          await db
            .insert(threadParticipantTable)
            .values({ id: newId(), tenantId, threadId: thread.id, personId, role: index === 0 ? 'owner' : 'participant' })
            .onConflictDoNothing();
        }

        const messageRows = await db
          .insert(messageTable)
          .values({
            id: newId(),
            tenantId,
            threadId: thread.id,
            authorPersonId,
            body: input.firstMessage,
            // A fresh thread.id is unique by construction, so this key can
            // never collide with a later, genuinely distinct postMessage call.
            idempotencyKey: `start-${thread.id}`,
          })
          .returning();
        const message = messageRows[0]!;

        const updatedRows = await db
          .update(threadTable)
          .set({ lastMessageAt: message.sentAt })
          .where(eq(threadTable.id, thread.id))
          .returning();

        await this.outbox.publish(db, {
          topic: 'communications.message_posted',
          payload: { threadId: thread.id, messageId: message.id, authorPersonId },
        });

        return updatedRows[0]!;
      });

      return ok(toThread(updatedThread));
    } catch (error) {
      return err(toDomainError(error, `Could not start thread "${input.subject}".`) as DomainError);
    }
  }

  /**
   * Idempotent on `input.idempotencyKey` - a replay returns the ORIGINAL
   * message and writes nothing further, same pattern as `AttendanceRecordService.
   * markSession`. `authorPersonId` must already be a `thread_participant` of
   * `input.threadId` - checked as part of the SAME transaction as the
   * insert, so this is enforced in the query path, not a separate
   * best-effort check a concurrent request could race.
   */
  async postMessage(tenantId: TenantId, authorPersonId: PersonId, input: PostMessageInput): Promise<Result<PostMessageResult, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const outcome = await withTenantTx(ctx, async (db) => {
        const threadRows = await db
          .select()
          .from(threadTable)
          .where(and(eq(threadTable.tenantId, tenantId), eq(threadTable.id, input.threadId)))
          .limit(1);
        if (!threadRows[0]) {
          throw new NotFoundError(`Thread ${input.threadId} not found.`);
        }

        const participantRows = await db
          .select()
          .from(threadParticipantTable)
          .where(
            and(
              eq(threadParticipantTable.tenantId, tenantId),
              eq(threadParticipantTable.threadId, input.threadId),
              eq(threadParticipantTable.personId, authorPersonId),
            ),
          )
          .limit(1);
        if (!participantRows[0]) {
          throw new ForbiddenError(`Person ${authorPersonId} is not a participant of thread ${input.threadId}.`);
        }

        const insertedRows = await db
          .insert(messageTable)
          .values({
            id: newId(),
            tenantId,
            threadId: input.threadId,
            authorPersonId,
            body: input.body,
            idempotencyKey: input.idempotencyKey,
          })
          .onConflictDoNothing()
          .returning();

        if (insertedRows.length === 0) {
          const existingRows = await db
            .select()
            .from(messageTable)
            .where(
              and(
                eq(messageTable.tenantId, tenantId),
                eq(messageTable.threadId, input.threadId),
                eq(messageTable.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          if (!existing) {
            throw new ConflictError(`Idempotency key "${input.idempotencyKey}" conflicted but no message row was found.`);
          }
          return { message: toMessage(existing), replayed: true };
        }
        const message = insertedRows[0]!;

        await db
          .update(threadTable)
          .set({ lastMessageAt: message.sentAt })
          .where(and(eq(threadTable.tenantId, tenantId), eq(threadTable.id, input.threadId)));

        // Same transaction as the insert above - see `OutboxContract.publish`'s
        // own doc comment.
        await this.outbox.publish(db, {
          topic: 'communications.message_posted',
          payload: { threadId: input.threadId, messageId: message.id, authorPersonId },
        });

        return { message: toMessage(message), replayed: false };
      });
      return ok(outcome);
    } catch (error) {
      return err(toDomainError(error, `Could not post a message to thread ${input.threadId}.`) as DomainError);
    }
  }

  /**
   * `input.personId` set: threads that person participates in - enforced by
   * an INNER JOIN against `thread_participant` in the query itself, never a
   * post-fetch filter (see the module report's own note on this). Unset:
   * every thread in the tenant matching `subjectType`/`subjectId` -
   * `CommunicationsController` only allows this for a tenant-scope caller.
   */
  async listThreads(tenantId: TenantId, input: ListThreadsInput): Promise<Thread[]> {
    const ctx = scopedContext(tenantId);
    const conditions = [eq(threadTable.tenantId, tenantId)];
    if (input.subjectType) {
      conditions.push(eq(threadTable.subjectType, input.subjectType));
    }
    if (input.subjectId) {
      conditions.push(eq(threadTable.subjectId, input.subjectId));
    }

    if (input.personId) {
      const personId = input.personId;
      const rows = await withTenantTx(ctx, (db) =>
        db
          .select({ thread: threadTable })
          .from(threadTable)
          .innerJoin(
            threadParticipantTable,
            and(eq(threadParticipantTable.threadId, threadTable.id), eq(threadParticipantTable.personId, personId)),
          )
          .where(and(...conditions))
          .orderBy(desc(threadTable.lastMessageAt)),
      );
      return rows.map((row) => toThread(row.thread));
    }

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(threadTable)
        .where(and(...conditions))
        .orderBy(desc(threadTable.lastMessageAt)),
    );
    return rows.map(toThread);
  }

  /**
   * Whether `personId` is a `thread_participant` of `threadId` - a real,
   * targeted query. `CommunicationsController` calls this BEFORE fetching a
   * thread's detail for a non-tenant-scope caller, and denies outright
   * (never calling `getThread`) when it is `false` - so an unauthorized read
   * never fetches the thread's messages at all, rather than fetching them
   * and filtering the response afterwards.
   */
  async isParticipant(tenantId: TenantId, threadId: string, personId: PersonId): Promise<boolean> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ id: threadParticipantTable.id })
        .from(threadParticipantTable)
        .where(
          and(
            eq(threadParticipantTable.tenantId, tenantId),
            eq(threadParticipantTable.threadId, threadId),
            eq(threadParticipantTable.personId, personId),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /** `NotFoundError` for a thread id that does not exist OR belongs to a different tenant (RLS makes the two indistinguishable). */
  async getThread(tenantId: TenantId, id: string): Promise<Result<ThreadDetail, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const threadRows = await withTenantTx(ctx, (db) =>
      db.select().from(threadTable).where(and(eq(threadTable.tenantId, tenantId), eq(threadTable.id, id))).limit(1),
    );
    const threadRow = threadRows[0];
    if (!threadRow) {
      return err(new NotFoundError(`Thread ${id} not found.`));
    }

    const [participantRows, messageRows] = await Promise.all([
      withTenantTx(ctx, (db) =>
        db.select().from(threadParticipantTable).where(and(eq(threadParticipantTable.tenantId, tenantId), eq(threadParticipantTable.threadId, id))),
      ),
      withTenantTx(ctx, (db) =>
        db
          .select()
          .from(messageTable)
          .where(and(eq(messageTable.tenantId, tenantId), eq(messageTable.threadId, id)))
          .orderBy(messageTable.sentAt),
      ),
    ]);

    return ok({
      thread: toThread(threadRow),
      participants: participantRows.map(toThreadParticipant),
      messages: messageRows.map(toMessage),
    });
  }

  async markThreadRead(tenantId: TenantId, input: MarkThreadReadInput): Promise<Result<void, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const updatedRows = await withTenantTx(ctx, (db) =>
      db
        .update(threadParticipantTable)
        .set({ lastReadAt: new Date() })
        .where(
          and(
            eq(threadParticipantTable.tenantId, tenantId),
            eq(threadParticipantTable.threadId, input.threadId),
            eq(threadParticipantTable.personId, input.personId),
          ),
        )
        .returning(),
    );
    if (updatedRows.length === 0) {
      return err(new NotFoundError(`Person ${input.personId} is not a participant of thread ${input.threadId}.`));
    }
    return ok(undefined);
  }

  /** Threads with at least one message newer than `personId`'s own `last_read_at` on that thread, and not authored by `personId` themselves (their own messages don't count as "unread"). */
  async countUnreadThreads(tenantId: TenantId, personId: PersonId): Promise<number> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<UnreadThreadCountRow>(sql`
        select count(distinct tp.thread_id) as n
        from communications.thread_participant tp
        join communications.message m
          on m.tenant_id = tp.tenant_id
         and m.thread_id = tp.thread_id
         and m.sent_at > coalesce(tp.last_read_at, '-infinity'::timestamptz)
         and m.author_person_id <> tp.person_id
        where tp.tenant_id = ${tenantId} and tp.person_id = ${personId}
      `),
    );
    const row = (rows as unknown as UnreadThreadCountRow[])[0];
    return row ? Number(row.n) : 0;
  }
}
