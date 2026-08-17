import type { AcademicYearId, CampusId, PersonId, TenantId, UserId } from './ids.js';

/**
 * The ambient context resolved once per request and carried through
 * `AsyncLocalStorage` (see `@sms/db`'s `runWithContext`). Never accept these
 * values from a client-controllable query parameter or body field - they
 * come from the session / auth layer and are pushed into the DB session so
 * row-level security can see them (`tenantId` is the security boundary;
 * `campusId` is an authorization scope; `academicYearId` is a filter).
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly campusId?: CampusId;
  readonly academicYearId?: AcademicYearId;

  /**
   * The person record this context relates to, once `people.person` exists
   * (M2). Distinct from `userId`: a person may have no login at all (a young
   * student), and a login is not a person record. Do NOT put a user id here.
   */
  readonly personId?: PersonId;

  /**
   * The EFFECTIVE user - who this request is acting as. Impersonation changes
   * this on purpose: "act as this user" must mean seeing exactly what they
   * see, no more.
   */
  readonly userId?: UserId;

  /**
   * The REAL signed-in human, never the impersonation target. This is what the
   * audit trail records, and it is the whole point of impersonation being
   * auditable: an impersonated write attributed to the target would launder
   * the very action the audit trail exists to capture. Equal to `userId` on an
   * ordinary request.
   */
  readonly actorUserId?: UserId;

  readonly roles: string[];
  readonly requestId: string;
}

/**
 * Marker context for code that legitimately runs without a tenant: schema
 * migrations, scheduled system jobs, health checks. Deliberately has no
 * tenant/campus/person fields - `withSystemTx` is the only thing that
 * should accept this, and it bypasses RLS-scoping SET LOCALs entirely.
 */
export interface SystemContext {
  readonly kind: 'system';
  readonly requestId: string;
}

export type ExecutionContext = TenantContext | SystemContext;

export function isSystemContext(context: ExecutionContext): context is SystemContext {
  return 'kind' in context && context.kind === 'system';
}
