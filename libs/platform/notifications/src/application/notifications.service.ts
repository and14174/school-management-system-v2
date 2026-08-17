import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  ForbiddenError,
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
  ListDeliveriesInput,
  NotificationsContract,
  NotifyInput,
  NotifyResult,
  PublishNotificationTemplateVersionInput,
  SetPreferenceInput,
} from '../contract.js';
import type {
  DeliveryRecord,
  DeliveryStatus,
  NotificationChannelName,
  NotificationPreference,
  NotificationRecord,
  NotificationTemplateSummary,
  NotificationTemplateVersion,
} from '../domain/types.js';
import {
  DEFAULT_NOTIFICATION_CHANNEL_REGISTRY,
  NOTIFICATION_CHANNEL_REGISTRY,
  type NotificationChannelRegistry,
} from './channel-registry.js';
import { DEFAULT_RECIPIENT_RESOLVER, RECIPIENT_RESOLVER, type RecipientResolver } from './recipient-resolver.js';
import { renderTemplate } from './render.js';
import { delivery, notification, preference, template, templateVersion } from '../infrastructure/schema.js';

type TemplateRow = typeof template.$inferSelect;
type TemplateVersionRow = typeof templateVersion.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;
type DeliveryRow = typeof delivery.$inferSelect;

const KNOWN_CHANNELS: readonly NotificationChannelName[] = ['email', 'sms', 'push'];

function requireTenantContext(): TenantContext {
  const context = getContext();
  if (!context || isSystemContext(context)) {
    throw new ForbiddenError('@sms/notifications operations require a resolved tenant context.');
  }
  return context;
}

function toTemplateVersionRecord(row: TemplateVersionRow, templateKey: string, channel: NotificationChannelName): NotificationTemplateVersion {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    templateId: row.templateId,
    templateKey,
    channel,
    version: row.version,
    locale: row.locale,
    subjectTemplate: row.subjectTemplate,
    bodyTemplate: row.bodyTemplate,
    publishedAt: row.publishedAt,
    createdByUserId: (row.createdByUserId ?? null) as UserId | null,
  };
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    templateVersionId: row.templateVersionId,
    category: row.category,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    payload: row.payload as Record<string, unknown>,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
  };
}

function toDeliveryRecord(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    notificationId: row.notificationId,
    personId: row.personId as PersonId,
    channel: row.channel as NotificationChannelName,
    address: row.address,
    status: row.status as DeliveryStatus,
    suppressedReason: row.suppressedReason,
    providerMessageId: row.providerMessageId,
    attempts: row.attempts,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

function toPreferenceRecord(row: typeof preference.$inferSelect): NotificationPreference {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantContext['tenantId'],
    personId: row.personId as PersonId,
    channel: row.channel as NotificationChannelName,
    category: row.category,
    optedIn: row.optedIn,
    updatedAt: row.updatedAt,
  };
}

/**
 * Implements `NotificationsContract`. The two properties everything here
 * serves - see the `1300` migration header:
 *
 *   1. Consent and preference are enforced HERE, immediately before a
 *      channel is called - never earlier, so no future caller can forget.
 *   2. "Sent" (the channel adapter accepted it) is recorded separately from
 *      "delivered" (never set by this class - see `DeliveryStatus`'s own
 *      comment).
 */
@Injectable()
export class NotificationsService implements NotificationsContract {
  // @Optional() with the fail-closed defaults on the first two, exactly the
  // SECTION_SCOPE_RESOLVER precedent (@sms/access's AbilityService): nothing
  // in THIS module registers either token (see both ports' own comments for
  // why not) - only apps/api's NotificationChannelsModule does, as a
  // @Global() provider. When nothing supplies it (no override wired up; a
  // test that `new NotificationsService(...)`s this directly with its own
  // fakes), Nest injects `undefined` for an @Optional() token it cannot
  // resolve and the default parameter value applies - "resolves to nothing"
  // rather than a boot-time crash.
  constructor(
    @Optional() @Inject(RECIPIENT_RESOLVER) private readonly recipients: RecipientResolver = DEFAULT_RECIPIENT_RESOLVER,
    @Optional()
    @Inject(NOTIFICATION_CHANNEL_REGISTRY)
    private readonly channels: NotificationChannelRegistry = DEFAULT_NOTIFICATION_CHANNEL_REGISTRY,
    @Optional() @Inject(AUDIT_CONTRACT) private readonly audit?: AuditContract,
  ) {}

  async listTemplates(): Promise<NotificationTemplateSummary[]> {
    const ctx = requireTenantContext();

    const { templateRows, versionRows } = await withTenantTx(ctx, async (tx) => {
      const templateRows = await tx.select().from(template).where(eq(template.tenantId, ctx.tenantId));
      const versionRows = await tx.select().from(templateVersion).where(eq(templateVersion.tenantId, ctx.tenantId));
      return { templateRows, versionRows };
    });

    const latestVersionByTemplateId = new Map<string, number>();
    for (const v of versionRows) {
      const current = latestVersionByTemplateId.get(v.templateId) ?? 0;
      if (v.version > current) latestVersionByTemplateId.set(v.templateId, v.version);
    }

    return templateRows.map((row) => ({
      id: row.id,
      key: row.key,
      channel: row.channel as NotificationChannelName,
      name: row.name,
      description: row.description,
      latestVersion: latestVersionByTemplateId.get(row.id) ?? null,
    }));
  }

  private async upsertTemplate(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    channel: NotificationChannelName,
    name: string,
    description: string | undefined,
  ): Promise<TemplateRow> {
    const [existing] = await tx
      .select()
      .from(template)
      .where(and(eq(template.tenantId, ctx.tenantId), eq(template.key, key), eq(template.channel, channel)))
      .limit(1);
    if (existing) return existing;

    const [inserted] = await tx
      .insert(template)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        key,
        channel,
        name,
        description: description ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    if (!inserted) throw new Error('notifications.template insert returned no row.');
    return inserted;
  }

  async publishTemplateVersion(
    input: PublishNotificationTemplateVersionInput,
  ): Promise<Result<NotificationTemplateVersion, DomainError>> {
    const ctx = requireTenantContext();

    const versionRow = await withTenantTx(ctx, async (tx) => {
      const templateRow = await this.upsertTemplate(
        tx,
        ctx,
        input.templateKey,
        input.channel,
        input.name ?? input.templateKey,
        input.description,
      );

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
          locale: input.locale ?? 'en',
          subjectTemplate: input.subjectTemplate ?? '',
          bodyTemplate: input.bodyTemplate,
          publishedAt: new Date(),
          createdByUserId: ctx.actorUserId ?? ctx.userId ?? null,
        })
        .returning();
      if (!inserted) throw new Error('notifications.template_version insert returned no row.');
      return inserted;
    });

    return ok(toTemplateVersionRecord(versionRow, input.templateKey, input.channel));
  }

  /** Every channel this tenant has a published template for under `key`, with the latest version of each. */
  private async latestPublishedVersionsByChannel(
    ctx: TenantContext,
    key: string,
  ): Promise<Map<NotificationChannelName, TemplateVersionRow>> {
    return withTenantTx(ctx, async (tx) => {
      const templateRows = await tx
        .select()
        .from(template)
        .where(and(eq(template.tenantId, ctx.tenantId), eq(template.key, key)));

      const result = new Map<NotificationChannelName, TemplateVersionRow>();
      for (const templateRow of templateRows) {
        const [versionRow] = await tx
          .select()
          .from(templateVersion)
          .where(eq(templateVersion.templateId, templateRow.id))
          .orderBy(desc(templateVersion.version))
          .limit(1);
        if (versionRow) {
          result.set(templateRow.channel as NotificationChannelName, versionRow);
        }
      }
      return result;
    });
  }

  async getPreferences(personId: PersonId): Promise<NotificationPreference[]> {
    const ctx = requireTenantContext();
    const rows = await withTenantTx(ctx, (tx) =>
      tx.select().from(preference).where(and(eq(preference.tenantId, ctx.tenantId), eq(preference.personId, personId))),
    );
    return rows.map(toPreferenceRecord);
  }

  async setPreference(input: SetPreferenceInput): Promise<Result<NotificationPreference, DomainError>> {
    const ctx = requireTenantContext();

    const [row] = await withTenantTx(ctx, (tx) =>
      tx
        .insert(preference)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          personId: input.personId,
          channel: input.channel,
          category: input.category,
          optedIn: input.optedIn,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [preference.tenantId, preference.personId, preference.channel, preference.category],
          set: { optedIn: input.optedIn, updatedAt: new Date() },
        })
        .returning(),
    );
    if (!row) throw new Error('notifications.preference upsert returned no row.');
    return ok(toPreferenceRecord(row));
  }

  private async findNotificationByDedupeKey(ctx: TenantContext, dedupeKey: string): Promise<NotificationRow | undefined> {
    const [row] = await withTenantTx(ctx, (tx) =>
      tx
        .select()
        .from(notification)
        .where(and(eq(notification.tenantId, ctx.tenantId), eq(notification.dedupeKey, dedupeKey)))
        .limit(1),
    );
    return row;
  }

  private async listDeliveryRowsForNotification(ctx: TenantContext, notificationId: string): Promise<DeliveryRow[]> {
    return withTenantTx(ctx, (tx) =>
      tx.select().from(delivery).where(and(eq(delivery.tenantId, ctx.tenantId), eq(delivery.notificationId, notificationId))),
    );
  }

  /**
   * Looks up the preference row for `(personId, channel, category)`.
   * Absence of a row means "no explicit preference recorded" - treated as
   * opted in, since the primary consent gate is `recipient.mayReceiveComms`
   * (the relationship-level flag), not this table - see the `1300`
   * migration header.
   */
  private async isOptedOut(
    tx: Tx,
    ctx: TenantContext,
    personId: PersonId,
    channel: NotificationChannelName,
    category: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select()
      .from(preference)
      .where(
        and(
          eq(preference.tenantId, ctx.tenantId),
          eq(preference.personId, personId),
          eq(preference.channel, channel),
          eq(preference.category, category),
        ),
      )
      .limit(1);
    return row ? !row.optedIn : false;
  }

  async notify(input: NotifyInput): Promise<Result<NotifyResult, DomainError>> {
    const ctx = requireTenantContext();

    const templatesByChannel = await this.latestPublishedVersionsByChannel(ctx, input.templateKey);
    if (templatesByChannel.size === 0) {
      return err(
        new PreconditionFailedError(
          `Notification template "${input.templateKey}" has no published version on any channel yet - call publishTemplateVersion first.`,
        ),
      );
    }
    if (!input.dedupeKey.trim()) {
      return err(new ValidationError('notify() requires a non-empty dedupeKey.'));
    }

    // ---------------------------------------------------------------------
    // Idempotency: INSERT ... ON CONFLICT (tenant_id, dedupe_key) DO NOTHING.
    // A returned row means this is the first time this dedupeKey has been
    // seen - only then do we resolve recipients and touch a channel. This
    // is the entire mechanism that makes at-least-once outbox delivery safe
    // (see the `1300` migration header and `AttendanceAbsenceSubscriber`).
    // ---------------------------------------------------------------------
    // Reference version for provenance: the first channel found, in a
    // deterministic (sorted) order. When more than one channel is published
    // for a key (uncommon - the seeded flow only ever publishes one), every
    // channel is still rendered and dispatched below; this column only
    // records which version's copy is attached to the notification row
    // itself, not which channels were attempted (that is `delivery.channel`).
    const orderedChannels = [...templatesByChannel.keys()].sort();
    const primaryChannel = orderedChannels[0]!;
    const primaryVersion = templatesByChannel.get(primaryChannel)!;

    // Resolved BEFORE the transaction below, deliberately. The resolver is an
    // inverted port (`RECIPIENT_RESOLVER`) whose real implementation reads
    // `@sms/people` through its own contract, opening its own transactions -
    // running that inside ours nests transactions on a pooled connection,
    // which is exactly how `withAuthTx` deadlocked inside Better Auth's
    // session hook (see docs/decisions.md). It is a read, so doing it before
    // the dedupe check costs only a little wasted work on a duplicate.
    const recipients = await this.recipients.resolve({ subjectType: input.subjectType, subjectId: input.subjectId });

    // ---------------------------------------------------------------------
    // The notification row and ALL of its delivery rows are written in ONE
    // transaction, so either every one exists or none does.
    //
    // They used to be separate transactions, and that turned a crash into a
    // silent permanent drop: the notification row committed, the process died
    // before writing deliveries, the outbox redelivered, the dedupe key
    // conflicted, and `notify()` reported success having told nobody. A
    // guardian never learns their child was absent and there is a row that
    // looks like it worked. Atomicity is what lets the conflict below mean
    // "the deliveries definitely exist".
    //
    // Sending stays OUTSIDE the transaction - it is network I/O, and holding
    // a DB transaction open across SMTP is its own problem. Rows land as
    // 'queued' and are dispatched after commit.
    // ---------------------------------------------------------------------
    const created = await withTenantTx(ctx, async (tx) => {
      const insertedRows = await tx
        .insert(notification)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          templateVersionId: primaryVersion.id,
          category: input.category,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          payload: input.payload,
          dedupeKey: input.dedupeKey,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      const notificationRow = insertedRows[0];
      if (!notificationRow) {
        return null;
      }

      const deliveryRows: DeliveryRow[] = [];
      for (const recipient of recipients) {
        for (const channel of templatesByChannel.keys()) {
          const address = recipient.addresses[channel];

          let status: DeliveryStatus = 'queued';
          let suppressedReason: string | null = null;

          if (!recipient.mayReceiveComms) {
            status = 'suppressed';
            suppressedReason = 'relationship_may_not_receive_comms';
          } else if (await this.isOptedOut(tx, ctx, recipient.personId, channel, input.category)) {
            status = 'suppressed';
            suppressedReason = 'preference_opted_out';
          } else if (!address) {
            status = 'suppressed';
            suppressedReason = 'no_address_on_file';
          }

          const [deliveryRow] = await tx
            .insert(delivery)
            .values({
              id: newId(),
              tenantId: ctx.tenantId,
              notificationId: notificationRow.id,
              personId: recipient.personId,
              channel,
              address: address ?? null,
              status,
              suppressedReason,
              providerMessageId: null,
              attempts: 0,
              sentAt: null,
              deliveredAt: null,
              failedAt: null,
              lastError: null,
              createdAt: new Date(),
            })
            .returning();
          if (!deliveryRow) throw new Error('notifications.delivery insert returned no row.');
          deliveryRows.push(deliveryRow);
        }
      }

      return { notificationRow, deliveryRows };
    });

    if (!created) {
      // Already seen. Because the write above is atomic, the delivery rows are
      // guaranteed to exist - but they are NOT guaranteed to have been sent,
      // since dispatch happens after commit and the process may have died in
      // between. Anything still 'queued' is retried here rather than assumed
      // done; that is what makes the crash window recoverable instead of
      // permanent. Already-'sent' rows are left alone, so redelivery still
      // never sends a second email.
      const existing = await this.findNotificationByDedupeKey(ctx, input.dedupeKey);
      if (!existing) {
        throw new Error(`notify(): dedupeKey "${input.dedupeKey}" conflicted but no existing row was found.`);
      }
      const existingDeliveries = await this.listDeliveryRowsForNotification(ctx, existing.id);
      const settled = await this.dispatchQueued(ctx, existingDeliveries, templatesByChannel, existing.payload as Record<string, unknown>);
      return ok({
        notification: toNotificationRecord(existing),
        deliveries: settled.map(toDeliveryRecord),
        deduped: true,
      });
    }

    const settled = await this.dispatchQueued(ctx, created.deliveryRows, templatesByChannel, input.payload);
    return ok({ notification: toNotificationRecord(created.notificationRow), deliveries: settled.map(toDeliveryRecord), deduped: false });
  }

  /**
   * Sends every delivery still sitting at 'queued', leaving 'suppressed',
   * 'sent', 'delivered' and 'failed' rows untouched. Runs after the
   * transaction that created the rows has committed - see `notify()`.
   */
  private async dispatchQueued(
    ctx: TenantContext,
    rows: DeliveryRow[],
    templatesByChannel: Map<NotificationChannelName, TemplateVersionRow>,
    payload: Record<string, unknown>,
  ): Promise<DeliveryRow[]> {
    const settled: DeliveryRow[] = [];
    for (const row of rows) {
      const channel = row.channel as NotificationChannelName;
      const version = templatesByChannel.get(channel);
      if (row.status !== 'queued' || !version) {
        settled.push(row);
        continue;
      }
      settled.push(await this.dispatch(ctx, row, version, channel, payload));
    }
    return settled;
  }

  /** Renders and sends one queued delivery, then records the outcome - success ('sent') or failure ('failed'), never 'delivered' (see the `1300` migration header). */
  private async dispatch(
    ctx: TenantContext,
    deliveryRow: DeliveryRow,
    version: TemplateVersionRow,
    channel: NotificationChannelName,
    payload: Record<string, unknown>,
  ): Promise<DeliveryRow> {
    const adapter = this.channels.get(channel);
    const address = deliveryRow.address;

    if (!adapter || !address) {
      const [failed] = await withTenantTx(ctx, (tx) =>
        tx
          .update(delivery)
          .set({
            status: 'failed',
            attempts: deliveryRow.attempts + 1,
            failedAt: new Date(),
            lastError: adapter ? 'No address to deliver to.' : `No channel adapter registered for "${channel}".`,
          })
          .where(eq(delivery.id, deliveryRow.id))
          .returning(),
      );
      return failed ?? deliveryRow;
    }

    const subject = renderTemplate(version.subjectTemplate, payload);
    const body = renderTemplate(version.bodyTemplate, payload);

    try {
      const result = await adapter.send({ to: address, subject, body });
      const [sent] = await withTenantTx(ctx, (tx) =>
        tx
          .update(delivery)
          .set({
            status: 'sent',
            attempts: deliveryRow.attempts + 1,
            sentAt: new Date(),
            providerMessageId: result.providerMessageId ?? null,
          })
          .where(eq(delivery.id, deliveryRow.id))
          .returning(),
      );
      return sent ?? deliveryRow;
    } catch (error) {
      const [failed] = await withTenantTx(ctx, (tx) =>
        tx
          .update(delivery)
          .set({
            status: 'failed',
            attempts: deliveryRow.attempts + 1,
            failedAt: new Date(),
            lastError: error instanceof Error ? error.message : String(error),
          })
          .where(eq(delivery.id, deliveryRow.id))
          .returning(),
      );
      return failed ?? deliveryRow;
    }
  }

  async listDeliveries(input: ListDeliveriesInput): Promise<DeliveryRecord[]> {
    const ctx = requireTenantContext();

    if (!input.notificationId && !input.personId) {
      throw new ValidationError('listDeliveries requires either notificationId or personId.');
    }

    if (input.personId) {
      // Deliveries carry who was told what and how to reach them - the same
      // "who read what about whom" reasoning as DocumentsService.getDownloadUrl's
      // own audit.recordAccess call.
      await this.audit?.recordAccess({
        personId: input.personId,
        resource: 'notifications.delivery',
        fieldNames: ['status', 'address', 'channel'],
      });
    }

    const rows = await withTenantTx(ctx, (tx) => {
      const conditions = [eq(delivery.tenantId, ctx.tenantId)];
      if (input.notificationId) conditions.push(eq(delivery.notificationId, input.notificationId));
      if (input.personId) conditions.push(eq(delivery.personId, input.personId));
      return tx
        .select()
        .from(delivery)
        .where(and(...conditions))
        .orderBy(desc(delivery.createdAt));
    });

    return rows.map(toDeliveryRecord);
  }
}

export { KNOWN_CHANNELS };
