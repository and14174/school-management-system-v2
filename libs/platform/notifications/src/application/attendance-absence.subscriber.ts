import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithContext } from '@sms/db';
import type { TenantId } from '@sms/kernel';
import type { OutboxMessage, OutboxSubscriber } from '@sms/outbox';
import { NOTIFICATIONS_CONTRACT, type NotificationsContract } from '../contract.js';

interface AttendanceMarkedAbsentPayload {
  readonly personId: string;
  readonly sectionId: string;
  readonly sectionMeetingId: string;
  readonly date: string;
  readonly codeId: string;
}

function isAttendanceMarkedAbsentPayload(
  payload: Record<string, unknown>,
): payload is AttendanceMarkedAbsentPayload & Record<string, unknown> {
  return (
    typeof payload.personId === 'string' &&
    typeof payload.sectionId === 'string' &&
    typeof payload.sectionMeetingId === 'string' &&
    typeof payload.date === 'string' &&
    typeof payload.codeId === 'string'
  );
}

/**
 * Closes the loop `@sms/outbox` was built for: `attendance.marked_absent`
 * becoming a real message to a guardian. Registered under `OUTBOX_SUBSCRIBERS`
 * by `apps/api` (this module never imports `@sms/attendance` - `type:
 * platform` may not depend on `type:domain` - it only reaches the payload
 * shape `@sms/attendance`'s `AttendanceRecordService.markSession` publishes).
 *
 * `OutboxDispatcher` delivers AT LEAST ONCE (see `@sms/outbox`'s own doc
 * comment): a process crash between "subscriber ran" and "message marked
 * published" replays this `handle()` for the same event. The `dedupeKey`
 * below is what makes that safe - `NotificationsContract.notify` no-ops on a
 * repeat key, so a redelivered event never sends a second email.
 *
 * `dedupeKey` is built from the mark's natural key (person + section
 * meeting + date), not a fetched `attendance.record.id`: the outbox payload
 * `markSession` publishes (see `attendance-record.service.ts`) does not
 * carry the record's id, and `attendance.record`'s own uniqueness is keyed
 * on exactly these three fields (its `0900` migration) - so this key
 * identifies the same record a fetched id would, without this module
 * reaching into `attendance`'s schema to get one.
 */
@Injectable()
export class AttendanceAbsenceSubscriber implements OutboxSubscriber {
  readonly topic = 'attendance.marked_absent';
  private readonly logger = new Logger(AttendanceAbsenceSubscriber.name);

  constructor(@Inject(NOTIFICATIONS_CONTRACT) private readonly notifications: NotificationsContract) {}

  async handle(message: OutboxMessage): Promise<void> {
    const payload = message.payload;
    if (!isAttendanceMarkedAbsentPayload(payload)) {
      this.logger.warn(`attendance.marked_absent message ${message.id} has an unexpected payload shape - skipping.`);
      return;
    }

    await runWithContext(
      {
        tenantId: message.tenantId as TenantId,
        roles: [],
        requestId: `notifications-attendance-absence-${message.id}`,
      },
      async () => {
        const result = await this.notifications.notify({
          templateKey: 'attendance.absence',
          category: 'attendance',
          subjectType: 'people.person',
          subjectId: payload.personId,
          payload: {
            personId: payload.personId,
            sectionId: payload.sectionId,
            sectionMeetingId: payload.sectionMeetingId,
            date: payload.date,
            codeId: payload.codeId,
          },
          dedupeKey: `attendance-absence:${payload.personId}:${payload.sectionMeetingId}:${payload.date}`,
        });

        if (result.ok) {
          return;
        }

        if (result.error.code === 'PRECONDITION_FAILED') {
          // No 'attendance.absence' template has been published for this
          // tenant yet - a normal state for a fresh tenant, same "nobody is
          // listening yet" posture OutboxDispatcher itself takes for a topic
          // with no subscriber at all. Retrying will not help until an
          // admin publishes a template, so this does not throw (which would
          // otherwise retry forever with backoff).
          this.logger.warn(
            `attendance.marked_absent message ${message.id}: no published "attendance.absence" template - skipping.`,
          );
          return;
        }

        throw result.error;
      },
    );
  }
}
