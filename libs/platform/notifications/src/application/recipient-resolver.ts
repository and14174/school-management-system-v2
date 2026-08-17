import type { PersonId } from '@sms/kernel';
import type { NotificationChannelName } from '../domain/types.js';

export interface ResolveRecipientsInput {
  /** e.g. `people.person` - opaque to this module, same reasoning as `documents.document.subject_type`. */
  readonly subjectType: string;
  readonly subjectId: string;
}

/**
 * One person who should potentially be told, and why. `mayReceiveComms`
 * carries the consent signal `people.relationship.may_receive_comms`
 * represents for a guardian (see `libs/domain/people/src/contract.ts`) -
 * `NotificationsService.notify` checks it immediately before sending, never
 * before, so it can never be forgotten by a caller composing the message
 * earlier - see the `1300` migration header.
 *
 * `addresses` is resolved per channel because a person may be reachable on
 * some channels and not others (no phone on file, has an email, ...) - a
 * channel with no address here is treated as undeliverable, not as consent
 * to skip.
 */
export interface NotificationRecipient {
  readonly personId: PersonId;
  readonly mayReceiveComms: boolean;
  /** Human-readable reason this person is a recipient at all - e.g. `'guardian'`, `'emergency_contact'`. For the delivery record, not for any decision this module makes. */
  readonly reason: string;
  readonly addresses: Partial<Record<NotificationChannelName, string>>;
}

/**
 * The inversion point that keeps this module (`type:platform`) ignorant of
 * what a "student" or a "guardian" is - exactly the pattern `@sms/access`
 * uses for `SECTION_SCOPE_RESOLVER`. `apps/api` is the one layer allowed to
 * depend on both `type:platform` and `type:domain`, so it is the one place
 * a real resolver (walking `people.relationship`, honouring
 * `may_receive_comms`, to find a student's guardians) is ever registered.
 */
export interface RecipientResolver {
  resolve(input: ResolveRecipientsInput): Promise<NotificationRecipient[]>;
}

export const RECIPIENT_RESOLVER = Symbol('RECIPIENT_RESOLVER');

/**
 * The safe default: an unresolvable subject must never widen to "notify
 * everyone" or throw and take the caller down with it - it resolves to zero
 * recipients, same fail-closed reasoning as `DEFAULT_SECTION_SCOPE_RESOLVER`.
 */
export const DEFAULT_RECIPIENT_RESOLVER: RecipientResolver = {
  async resolve(): Promise<NotificationRecipient[]> {
    return [];
  },
};
