import { Inject, Injectable } from '@nestjs/common';
import type { PersonId } from '@sms/kernel';
import { PEOPLE_CONTRACT, type ContactPoint, type PeopleContract } from '@sms/people';
import type { NotificationRecipient, RecipientResolver, ResolveRecipientsInput } from '@sms/notifications';

/**
 * The concrete `RecipientResolver` for `@sms/notifications`' `RECIPIENT_RESOLVER`
 * port - registered here, in `apps/api`, and NOT inside `@sms/notifications`
 * (a `type:platform` module that must never depend on `@sms/people`,
 * `type:domain` - see that module's `application/recipient-resolver.ts` for
 * the inversion this implements, the same pattern `people-import-target.ts`'s
 * own comment documents for `IMPORT_TARGET_REGISTRY`).
 *
 * Only `subjectType === 'people.person'` is understood (a student); anything
 * else resolves to zero recipients - fail closed, not an error, matching
 * `DEFAULT_RECIPIENT_RESOLVER`'s own posture for a subject nothing has
 * wired up yet.
 *
 * Walks `people.relationship` in the direction `@sms/people`'s own contract
 * documents - "`fromPersonId` is (e.g.) the parent OF `toPersonId`" - so a
 * guardian is any relationship with `toPersonId === subjectId`.
 * `mayReceiveComms` is read straight off the relationship row and passed
 * through unmodified: this resolver's job is to REPORT the consent signal,
 * not to apply it - `NotificationsService.notify` is what enforces it, at
 * send time (see `@sms/notifications`' `1300` migration header).
 *
 * ADDRESS: real `people.contact_point` rows now (the `0503` migration),
 * fetched in ONE bulk call (`listContactPointsForPeople`) for every guardian
 * at once rather than one `getPerson`/lookup per relationship - see the
 * contract's own doc comment on why that method exists. A guardian with no
 * usable email contact point on file gets NO `email` address here, full
 * stop - never a synthesised one. `NotificationsService.notify` already
 * turns a missing address into a `suppressed` delivery with reason
 * `no_address_on_file`, which is the correct, auditable "nobody was actually
 * reachable" outcome; inventing an address would make that delivery say
 * `sent` for someone who was never told anything, which is exactly the
 * failure "sent is not delivered" (this module's own design) exists to
 * prevent. Email prefers the primary non-archived contact point, falling
 * back to any non-archived one; a phone contact point (if any) is surfaced
 * the same way for the `sms` channel, whose adapter is the console channel
 * registered in `apps/api`.
 */
@Injectable()
export class GuardianRecipientResolverService implements RecipientResolver {
  constructor(@Inject(PEOPLE_CONTRACT) private readonly people: PeopleContract) {}

  /** Primary non-archived point of `kind`, falling back to any non-archived point of that kind. `undefined` if the person has none on file. */
  private pickAddress(points: ContactPoint[], kind: ContactPoint['kind']): string | undefined {
    const ofKind = points.filter((point) => point.kind === kind);
    return (ofKind.find((point) => point.isPrimary) ?? ofKind[0])?.value;
  }

  async resolve(input: ResolveRecipientsInput): Promise<NotificationRecipient[]> {
    if (input.subjectType !== 'people.person') {
      return [];
    }
    const studentId = input.subjectId as PersonId;

    const relationships = await this.people.listRelationships(studentId);
    const guardianRelationships = relationships.filter((relationship) => relationship.toPersonId === studentId);

    const guardianIds = guardianRelationships.map((relationship) => relationship.fromPersonId);
    const contactPointsByPerson = await this.people.listContactPointsForPeople(guardianIds);

    const recipients: NotificationRecipient[] = [];
    for (const relationship of guardianRelationships) {
      const points = contactPointsByPerson.get(relationship.fromPersonId) ?? [];
      const email = this.pickAddress(points, 'email');
      const phone = this.pickAddress(points, 'phone');

      recipients.push({
        personId: relationship.fromPersonId,
        mayReceiveComms: relationship.mayReceiveComms,
        reason: relationship.type,
        addresses: {
          ...(email ? { email } : {}),
          ...(phone ? { sms: phone } : {}),
        },
      });
    }

    return recipients;
  }
}
