import type { CampusId, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  Announcement,
  AnnouncementRecipientView,
  AudienceQuery,
  Message,
  Thread,
  ThreadDetail,
  ThreadSubjectType,
  UnreadCounts,
} from './domain/types.js';

export * from './domain/types.js';

export interface CreateAnnouncementInput {
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly audience: AudienceQuery;
  readonly campusId?: CampusId | null;
}

export interface SupersedeAnnouncementInput {
  readonly title: string;
  readonly body: string;
}

export interface ListAnnouncementsInput {
  /**
   * Whose addressed announcements to list (published announcements where
   * this person is a resolved `AnnouncementRecipient`). Omitted (tenant-wide
   * browsing) is only meaningful for a caller whose scope constraint on the
   * gating permission resolves to `tenant` - `CommunicationsController`
   * enforces that, not this method.
   */
  readonly forPersonId?: PersonId;
}

export interface MarkAnnouncementReadInput {
  readonly announcementId: string;
  readonly personId: PersonId;
}

export interface StartThreadInput {
  readonly subject: string;
  readonly subjectType: ThreadSubjectType;
  readonly subjectId: string;
  /** Every person who should be a participant, INCLUDING the starter - the first entry becomes the thread's `owner`. */
  readonly participantPersonIds: readonly PersonId[];
  readonly firstMessage: string;
}

export interface PostMessageInput {
  readonly threadId: string;
  readonly body: string;
  /** A replay of the same key is a no-op - see `ThreadService.postMessage`. */
  readonly idempotencyKey: string;
}

export interface PostMessageResult {
  readonly message: Message;
  /** `true` when `idempotencyKey` had already been submitted - `message` is the ORIGINAL result, and nothing was written this call. */
  readonly replayed: boolean;
}

export interface ListThreadsInput {
  readonly personId?: PersonId;
  readonly subjectType?: ThreadSubjectType;
  readonly subjectId?: string;
}

export interface MarkThreadReadInput {
  readonly threadId: string;
  readonly personId: PersonId;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `CommunicationsController`) - matching `@sms/attendance`'s
 * `AttendanceContract` pattern: every other module should depend on this
 * interface, not on the concrete `CommunicationsService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `CommunicationsService` (the implementation
 * behind this interface) is the REST-facing facade; the individual services
 * it composes (`AnnouncementService`/`ThreadService`) take `tenantId`
 * explicitly so they also work from `seed.ts` and from tests with no ambient
 * context at all - same shape as `@sms/attendance`'s own services.
 */
export interface CommunicationsContract {
  createAnnouncement(input: CreateAnnouncementInput): Promise<Result<Announcement, DomainError>>;

  /**
   * Resolves `audience` against CURRENT data, freezes the result as
   * `AnnouncementRecipient` rows, and publishes `communications.
   * announcement_published` through the outbox - all in the SAME
   * transaction as the `status -> 'published'` write (see `@sms/outbox`'s
   * `OutboxContract.publish` doc comment: it is handed the caller's
   * transaction for exactly this reason, so `@sms/notifications` can
   * deliver the announcement later without a race against the freeze).
   */
  publishAnnouncement(id: string): Promise<Result<Announcement, DomainError>>;

  /**
   * Issues a correction: inserts a NEW announcement (with `input`'s title/
   * body, the original's `category`/`audience`/`campusId`), publishes IT
   * (re-resolving and freezing the audience as of now), and stamps the
   * original's `superseded_by_announcement_id` - the original's own title/
   * body are never touched (`trg_forbid_announcement_content_change`
   * forbids it once published). `id` must currently be `published`.
   */
  supersedeAnnouncement(id: string, input: SupersedeAnnouncementInput): Promise<Result<Announcement, DomainError>>;

  getAnnouncement(id: string): Promise<Result<Announcement, NotFoundError>>;
  listAnnouncements(input?: ListAnnouncementsInput): Promise<Announcement[]>;

  /** The frozen audience for `announcementId`, joined with each recipient's name and read state - what a "show recipients" admin view reads. */
  listAnnouncementRecipients(announcementId: string): Promise<AnnouncementRecipientView[]>;

  /** Whether `personId` is a resolved recipient of `announcementId` - the authorization check `apps/api`'s `CommunicationsController` performs before a non-tenant-scope caller may read a single announcement. Same "real, targeted query" reasoning as `isThreadParticipant`. */
  isAnnouncementRecipient(announcementId: string, personId: PersonId): Promise<boolean>;

  markAnnouncementRead(input: MarkAnnouncementReadInput): Promise<Result<void, NotFoundError>>;

  /**
   * Creates the thread, its participants (the FIRST entry in
   * `participantPersonIds` becomes `owner`, the rest `participant`), and the
   * opening message - one transaction, one `communications.message_posted`
   * outbox event, same "same transaction" discipline as `postMessage`.
   */
  startThread(input: StartThreadInput): Promise<Result<Thread, DomainError>>;

  /**
   * Idempotent on `idempotencyKey` (same pattern as `@sms/attendance`'s
   * `markSession`): a replay returns the ORIGINAL message and writes
   * nothing further. The author is the ambient tenant context's `personId`
   * (this contract's implementation resolves it, exactly like `@sms/
   * attendance`'s `AttendanceService` resolves `tenantId` for every method) -
   * never client-supplied - and must already be a `thread_participant` of
   * `threadId`, or the write is refused. Publishes `communications.
   * message_posted` and bumps `thread.last_message_at` in the SAME
   * transaction as the insert.
   */
  postMessage(input: PostMessageInput): Promise<Result<PostMessageResult, DomainError>>;

  /**
   * Threads `personId` participates in (when given), optionally narrowed to
   * one subject. `apps/api`'s `CommunicationsController` additionally
   * constrains this to the CALLER's own participation for a non-tenant-scope
   * caller, enforced in the query - see that controller's own comment.
   */
  listThreads(input?: ListThreadsInput): Promise<Thread[]>;

  /** `NotFoundError` for a thread id that does not exist OR belongs to a different tenant (RLS makes the two indistinguishable) - never a hint either way. */
  getThread(id: string): Promise<Result<ThreadDetail, NotFoundError>>;

  /**
   * Whether `personId` is a `thread_participant` of `threadId` - a real,
   * targeted query (see `ThreadService.isParticipant`'s own comment), the
   * authorization check `apps/api`'s `CommunicationsController` performs
   * BEFORE calling `getThread`/`postMessage`/`markThreadRead` for a
   * non-tenant-scope caller, so an unauthorized read never fetches the
   * thread's messages at all.
   */
  isThreadParticipant(threadId: string, personId: PersonId): Promise<boolean>;

  markThreadRead(input: MarkThreadReadInput): Promise<Result<void, NotFoundError>>;

  /** Unread announcements (recipient rows with `read_at is null`) and threads with at least one message newer than the participant's own `last_read_at`, for `personId` - what a portal badge reads. */
  getUnreadCounts(personId: PersonId): Promise<UnreadCounts>;
}

/**
 * DI token for `CommunicationsContract` - see `TENANCY_CONTRACT` in
 * `@sms/tenancy` for why a concrete Symbol token is used instead of relying
 * on implicit type-based DI.
 */
export const COMMUNICATIONS_CONTRACT = Symbol('COMMUNICATIONS_CONTRACT');
