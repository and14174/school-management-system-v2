import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  newId,
  type DomainError,
  type NotFoundError as NotFoundErrorType,
  type PersonId,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx, type Tx } from '@sms/db';
import { OUTBOX_CONTRACT, type OutboxContract } from '@sms/outbox';
import type { CreateAnnouncementInput, ListAnnouncementsInput, MarkAnnouncementReadInput, SupersedeAnnouncementInput } from '../contract.js';
import type { Announcement, AnnouncementRecipientView, AudienceQuery } from '../domain/types.js';
import { toAnnouncement, toAnnouncementRecipientView } from '../infrastructure/mappers.js';
import { announcementRecipientTable, announcementTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

type AudiencePersonRow = { readonly person_id: string };
type RecipientViewRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly announcement_id: string;
  readonly person_id: string;
  readonly read_at: Date | null;
  readonly created_at: Date;
  readonly given_name: string;
  readonly family_name: string;
};

/**
 * Announcements: creation, publish (resolve + FREEZE the audience, publish
 * the outbox event, all in one transaction), supersede (a correction is a
 * new announcement, never an edit of a published one - the `1350` migration
 * header and `trg_forbid_announcement_content_change` enforce that at the
 * database level; this service just never attempts it), and the read state
 * each recipient carries.
 */
@Injectable()
export class AnnouncementService {
  constructor(@Inject(OUTBOX_CONTRACT) private readonly outbox: OutboxContract) {}

  async createAnnouncement(tenantId: TenantId, input: CreateAnnouncementInput): Promise<Result<Announcement, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const created = await withTenantTx(ctx, async (db) => {
        const rows = await db
          .insert(announcementTable)
          .values({
            id: newId(),
            tenantId,
            title: input.title,
            body: input.body,
            category: input.category,
            audience: input.audience,
            campusId: input.campusId ?? null,
            status: 'draft',
          })
          .returning();
        return rows[0]!;
      });
      return ok(toAnnouncement(created));
    } catch (error) {
      return err(toDomainError(error, `Could not create announcement "${input.title}".`) as DomainError);
    }
  }

  /**
   * Resolves `audience` AS OF NOW, writes one `announcement_recipient` row
   * per resolved person (idempotent via `onConflictDoNothing` - defence in
   * depth alongside the unique index, should this ever be called twice for
   * the same announcement), publishes `communications.announcement_published`
   * and flips `status -> 'published'` - all inside the SAME transaction, so
   * the frozen audience and the "it was published" fact can never disagree.
   */
  async publishAnnouncement(tenantId: TenantId, id: string): Promise<Result<Announcement, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const published = await withTenantTx(ctx, (db) => this.publishWithinTx(db, ctx.actorUserId ?? ctx.userId ?? null, tenantId, id));
      return ok(toAnnouncement(published));
    } catch (error) {
      return err(toDomainError(error, `Could not publish announcement ${id}.`) as DomainError);
    }
  }

  private async publishWithinTx(
    db: Tx,
    publishedByUserId: string | null,
    tenantId: TenantId,
    id: string,
  ): Promise<typeof announcementTable.$inferSelect> {
    // `for update`, not a bare read: the draft check below is a check-then-act,
    // and two concurrent publishes (a double-clicked button will do it) would
    // otherwise both read 'draft', both freeze an audience and both emit an
    // `announcement_published` outbox event - telling everyone twice. The row
    // lock makes the second one see 'published' and conflict, which is the
    // whole point of the check.
    const rows = await db
      .select()
      .from(announcementTable)
      .where(and(eq(announcementTable.tenantId, tenantId), eq(announcementTable.id, id)))
      .limit(1)
      .for('update');
    const announcement = rows[0];
    if (!announcement) {
      throw new NotFoundError(`Announcement ${id} not found.`);
    }
    if (announcement.status !== 'draft') {
      throw new ConflictError(`Announcement ${id} is already ${announcement.status} - it cannot be published again.`);
    }

    const recipientPersonIds = await this.resolveAudience(db, tenantId, announcement.audience as AudienceQuery);

    const updatedRows = await db
      .update(announcementTable)
      .set({ status: 'published', publishedAt: new Date(), publishedByUserId })
      .where(eq(announcementTable.id, id))
      .returning();
    const updated = updatedRows[0]!;

    for (const personId of recipientPersonIds) {
      await db
        .insert(announcementRecipientTable)
        .values({ id: newId(), tenantId, announcementId: id, personId })
        .onConflictDoNothing();
    }

    // Same transaction as the freeze above - see `OutboxContract.publish`'s
    // own doc comment for why this can never be a fire-and-forget call after
    // commit.
    await this.outbox.publish(db, {
      topic: 'communications.announcement_published',
      payload: {
        announcementId: id,
        title: updated.title,
        category: updated.category,
        recipientPersonIds,
      },
    });

    return updated;
  }

  /**
   * Issues a correction: a NEW announcement (this INPUT's title/body, the
   * original's category/audience/campus), published (re-resolving and
   * freezing the audience AS OF NOW - the correction may reach a different
   * set of people than the original did, and that is correct: it is a new
   * publish event), then the original is stamped `superseded_by_
   * announcement_id` - never edited in content. `id` must currently be
   * `published`.
   */
  async supersedeAnnouncement(
    tenantId: TenantId,
    id: string,
    input: SupersedeAnnouncementInput,
  ): Promise<Result<Announcement, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const result = await withTenantTx(ctx, async (db) => {
        const originalRows = await db
          .select()
          .from(announcementTable)
          .where(and(eq(announcementTable.tenantId, tenantId), eq(announcementTable.id, id)))
          .limit(1);
        const original = originalRows[0];
        if (!original) {
          throw new NotFoundError(`Announcement ${id} not found.`);
        }
        if (original.status !== 'published') {
          throw new ConflictError(
            `Announcement ${id} must be published before it can be superseded (current status: ${original.status}).`,
          );
        }

        const draftRows = await db
          .insert(announcementTable)
          .values({
            id: newId(),
            tenantId,
            title: input.title,
            body: input.body,
            category: original.category,
            audience: original.audience,
            campusId: original.campusId,
            status: 'draft',
          })
          .returning();
        const draft = draftRows[0]!;

        const published = await this.publishWithinTx(db, ctx.actorUserId ?? ctx.userId ?? null, tenantId, draft.id);

        await db
          .update(announcementTable)
          .set({ status: 'superseded', supersededByAnnouncementId: published.id })
          .where(eq(announcementTable.id, original.id));

        return published;
      });
      return ok(toAnnouncement(result));
    } catch (error) {
      return err(toDomainError(error, `Could not supersede announcement ${id}.`) as DomainError);
    }
  }

  async getAnnouncement(tenantId: TenantId, id: string): Promise<Result<Announcement, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(announcementTable)
        .where(and(eq(announcementTable.tenantId, tenantId), eq(announcementTable.id, id)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) {
      return err(new NotFoundError(`Announcement ${id} not found.`));
    }
    return ok(toAnnouncement(row));
  }

  /**
   * `input.forPersonId` set: announcements addressed to that person (an
   * inner join against the FROZEN `announcement_recipient` - never a live
   * re-resolution of `audience`). Unset: every announcement in the tenant
   * (draft included) - `CommunicationsController` only allows this for a
   * tenant-scope caller, enforced in the controller, not here (see that
   * file's own comment).
   */
  async listAnnouncements(tenantId: TenantId, input: ListAnnouncementsInput): Promise<Announcement[]> {
    const ctx = scopedContext(tenantId);
    if (input.forPersonId) {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .select({ announcement: announcementTable })
          .from(announcementTable)
          .innerJoin(
            announcementRecipientTable,
            and(
              eq(announcementRecipientTable.announcementId, announcementTable.id),
              eq(announcementRecipientTable.personId, input.forPersonId!),
            ),
          )
          .where(eq(announcementTable.tenantId, tenantId))
          .orderBy(desc(announcementTable.publishedAt), desc(announcementTable.createdAt)),
      );
      return rows.map((row) => toAnnouncement(row.announcement));
    }

    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(announcementTable).where(eq(announcementTable.tenantId, tenantId)).orderBy(desc(announcementTable.createdAt)),
    );
    return rows.map(toAnnouncement);
  }

  /** The frozen audience, joined with each recipient's name - a raw cross-schema read against `people.person`, the established escape hatch (see `@sms/attendance`'s `AttendanceRecordService.getSessionRoster`'s own comment) since this package may depend on `@sms/people`'s PUBLIC contract, never reach into its internal schema module directly. */
  async listAnnouncementRecipients(tenantId: TenantId, announcementId: string): Promise<AnnouncementRecipientView[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<RecipientViewRow>(sql`
        select ar.id, ar.tenant_id, ar.announcement_id, ar.person_id, ar.read_at, ar.created_at,
               p.given_name, p.family_name
        from communications.announcement_recipient ar
        join people.person p on p.id = ar.person_id
        where ar.tenant_id = ${tenantId} and ar.announcement_id = ${announcementId}
        order by p.family_name, p.given_name
      `),
    );
    return (rows as unknown as RecipientViewRow[]).map(toAnnouncementRecipientView);
  }

  async markAnnouncementRead(tenantId: TenantId, input: MarkAnnouncementReadInput): Promise<Result<void, NotFoundErrorType>> {
    const ctx = scopedContext(tenantId);
    const existingRows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(announcementRecipientTable)
        .where(
          and(
            eq(announcementRecipientTable.tenantId, tenantId),
            eq(announcementRecipientTable.announcementId, input.announcementId),
            eq(announcementRecipientTable.personId, input.personId),
          ),
        )
        .limit(1),
    );
    const existing = existingRows[0];
    if (!existing) {
      return err(new NotFoundError(`Person ${input.personId} is not a recipient of announcement ${input.announcementId}.`));
    }
    if (existing.readAt) {
      return ok(undefined);
    }
    await withTenantTx(ctx, (db) =>
      db.update(announcementRecipientTable).set({ readAt: new Date() }).where(eq(announcementRecipientTable.id, existing.id)),
    );
    return ok(undefined);
  }

  /** A real, targeted existence check - see `CommunicationsContract.isAnnouncementRecipient`'s own doc comment. */
  async isAnnouncementRecipient(tenantId: TenantId, announcementId: string, personId: PersonId): Promise<boolean> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select({ id: announcementRecipientTable.id })
        .from(announcementRecipientTable)
        .where(
          and(
            eq(announcementRecipientTable.tenantId, tenantId),
            eq(announcementRecipientTable.announcementId, announcementId),
            eq(announcementRecipientTable.personId, personId),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /** Recipient rows for `personId` with `read_at is null` - what `getUnreadCounts` reports for the announcements half of a portal badge. */
  async countUnreadAnnouncements(tenantId: TenantId, personId: PersonId): Promise<number> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<{ n: string }>(sql`
        select count(*) as n
        from communications.announcement_recipient
        where tenant_id = ${tenantId} and person_id = ${personId} and read_at is null
      `),
    );
    const row = (rows as unknown as Array<{ n: string }>)[0];
    return row ? Number(row.n) : 0;
  }

  /** Every `may_receive_comms` guardian of a currently-enrolled student matching `audience` - see `AudienceQuery`'s own doc comment. */
  private async resolveAudience(db: Tx, tenantId: TenantId, audience: AudienceQuery): Promise<PersonId[]> {
    if (audience.kind === 'personIds') {
      return [...new Set(audience.personIds)];
    }

    const filterClause =
      audience.kind === 'campus'
        ? sql`and sec.campus_id = ${audience.campusId}`
        : audience.kind === 'gradeLevel'
          ? sql`and c.grade_level_id = ${audience.gradeLevelId}`
          : sql``;

    const joinClause =
      audience.kind === 'campus' || audience.kind === 'gradeLevel'
        ? sql`join academic.section sec on sec.id = se.section_id and sec.tenant_id = se.tenant_id`
        : sql``;
    const courseJoinClause = audience.kind === 'gradeLevel' ? sql`join academic.course c on c.id = sec.course_id` : sql``;

    const rows = await db.execute<AudiencePersonRow>(sql`
      select distinct r.from_person_id as person_id
      from people.relationship r
      join academic.section_enrollment se
        on se.person_id = r.to_person_id
       and se.tenant_id = r.tenant_id
       and se.valid_from <= current_date
       and (se.valid_to is null or se.valid_to >= current_date)
      ${joinClause}
      ${courseJoinClause}
      where r.tenant_id = ${tenantId}
        and r.may_receive_comms = true
        ${filterClause}
    `);
    return (rows as unknown as AudiencePersonRow[]).map((row) => row.person_id as PersonId);
  }
}
