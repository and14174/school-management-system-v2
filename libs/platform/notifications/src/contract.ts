import type { DomainError, PersonId, Result } from '@sms/kernel';

export * from './domain/types.js';
export * from './application/channel-registry.js';
export * from './application/recipient-resolver.js';
export { renderTemplate } from './application/render.js';

import type {
  DeliveryRecord,
  NotificationChannelName,
  NotificationPreference,
  NotificationRecord,
  NotificationTemplateSummary,
  NotificationTemplateVersion,
} from './domain/types.js';

export interface PublishNotificationTemplateVersionInput {
  readonly templateKey: string;
  readonly channel: NotificationChannelName;
  readonly locale?: string;
  readonly subjectTemplate?: string;
  readonly bodyTemplate: string;
  /** Used only when this is the FIRST version published for `(templateKey, channel)` - auto-creates `notifications.template`, same as `DocumentsContract.publishTemplateVersion`. Ignored on later versions. */
  readonly name?: string;
  readonly description?: string;
}

export interface SetPreferenceInput {
  readonly personId: PersonId;
  readonly channel: NotificationChannelName;
  readonly category: string;
  readonly optedIn: boolean;
}

export interface NotifyInput {
  /** Matches `notifications.template.key`. Every channel this tenant has published a template for under this key is attempted - see `NotificationsService.notify`. */
  readonly templateKey: string;
  readonly category: string;
  /** e.g. `people.person` - opaque to this module, see the `1300` migration header. */
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  /**
   * Unique per tenant (`notifications.notification.dedupe_key`). A second
   * `notify()` call with the same key is a no-op - this is what makes
   * at-least-once outbox redelivery safe. Callers deriving this from a
   * domain record's natural key (e.g. `attendance-absence:{personId}:
   * {sectionMeetingId}:{date}`) get idempotency for free.
   */
  readonly dedupeKey: string;
}

export interface NotifyResult {
  readonly notification: NotificationRecord;
  readonly deliveries: DeliveryRecord[];
  /** `true` when `dedupeKey` had already been used - `deliveries` are the ORIGINAL rows, and nothing was sent this call. */
  readonly deduped: boolean;
}

export interface ListDeliveriesInput {
  readonly notificationId?: string;
  readonly personId?: PersonId;
}

/**
 * The public surface of `@sms/notifications`. See the `1300` migration
 * header for the two properties everything here serves: consent/preference
 * checked at SEND time, and "sent" tracked separately from "delivered".
 */
export interface NotificationsContract {
  /** Every `(key, channel)` this tenant has published at least one version for. */
  listTemplates(): Promise<NotificationTemplateSummary[]>;

  /** Publishes a new, immutable version. Auto-creates the `notifications.template` row on a `(key, channel)`'s first publish - same shape as `DocumentsContract.publishTemplateVersion`. */
  publishTemplateVersion(
    input: PublishNotificationTemplateVersionInput,
  ): Promise<Result<NotificationTemplateVersion, DomainError>>;

  getPreferences(personId: PersonId): Promise<NotificationPreference[]>;
  setPreference(input: SetPreferenceInput): Promise<Result<NotificationPreference, DomainError>>;

  /**
   * Resolves recipients (`RECIPIENT_RESOLVER`), filters by consent
   * (`recipient.mayReceiveComms`) and preference (`notifications.preference`)
   * AT SEND TIME, renders per recipient against the latest published
   * template version for each channel that has one, writes `notification` +
   * `delivery` rows, and dispatches through `NOTIFICATION_CHANNEL_REGISTRY`.
   * A repeat call with the same `dedupeKey` returns the original result
   * (`deduped: true`) and sends nothing again.
   */
  notify(input: NotifyInput): Promise<Result<NotifyResult, DomainError>>;

  listDeliveries(input: ListDeliveriesInput): Promise<DeliveryRecord[]>;
}

/** DI token for `NotificationsContract`. */
export const NOTIFICATIONS_CONTRACT = Symbol('NOTIFICATIONS_CONTRACT');
