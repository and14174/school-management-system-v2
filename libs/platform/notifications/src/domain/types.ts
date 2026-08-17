import type { PersonId, TenantId, UserId } from '@sms/kernel';

/**
 * Channels are adapters behind a port (`NOTIFICATION_CHANNEL_REGISTRY`, see
 * `application/channel-registry.ts`) - this module never imports a provider
 * SDK directly. `email`/`sms`/`push` is the closed vocabulary of channel
 * KINDS; which concrete provider backs each one varies per tenant and per
 * country and is entirely `apps/api`'s concern.
 */
export type NotificationChannelName = 'email' | 'sms' | 'push';

/**
 * See the `1300` migration header on "sent is not delivered": nothing in
 * this module ever sets `'delivered'` itself - it exists in the vocabulary
 * so a future provider webhook can report it without a schema change.
 */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed';

/** Mirrors `notifications.template`. */
export interface NotificationTemplate {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly key: string;
  readonly channel: NotificationChannelName;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `notifications.template_version`. Immutable once published - see the `1300` migration's triggers. */
export interface NotificationTemplateVersion {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly templateId: string;
  readonly templateKey: string;
  readonly channel: NotificationChannelName;
  readonly version: number;
  readonly locale: string;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly publishedAt: Date;
  readonly createdByUserId: UserId | null;
}

/** `id: null` when the key has never been published for this tenant on this channel - matches `documents.DocumentTemplateSummary`'s own shape. */
export interface NotificationTemplateSummary {
  readonly id: string | null;
  readonly key: string;
  readonly channel: NotificationChannelName;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number | null;
}

/** Mirrors `notifications.preference`. Absence of a row (not returned by `getPreferences`) means "no explicit preference recorded" - `NotificationsService.notify` treats that as opted in. */
export interface NotificationPreference {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly channel: NotificationChannelName;
  readonly category: string;
  readonly optedIn: boolean;
  readonly updatedAt: Date;
}

/** Mirrors `notifications.notification`. One logical message about one subject - insert-only, see the `1300` migration header. */
export interface NotificationRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly templateVersionId: string;
  readonly category: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string;
  readonly createdAt: Date;
}

/** Mirrors `notifications.delivery`. One row per recipient per channel - the honest record of what actually happened. */
export interface DeliveryRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly notificationId: string;
  readonly personId: PersonId;
  readonly channel: NotificationChannelName;
  readonly address: string | null;
  readonly status: DeliveryStatus;
  readonly suppressedReason: string | null;
  readonly providerMessageId: string | null;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly failedAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}
