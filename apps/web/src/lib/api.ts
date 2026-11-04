import { ForbiddenError, UnauthorizedError } from './http';

// Empty when deployed: next.config.ts proxies /api/v1 on the web origin, so
// requests are same-origin. `??` (not `||`) keeps that empty string.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

/**
 * M1b has landed: the tenant is resolved from the authenticated session
 * (`TenantContextInterceptor` reads `request.identity.activeTenantId`, not
 * any header - see its own doc comment: "x-tenant-id is no longer honoured
 * at all"). The API's CORS `allow-headers` list was tightened to match
 * (`content-type, authorization, x-campus-id, x-academic-year-id,
 * x-request-id` - no `x-tenant-id`), so sending it now fails the browser's
 * preflight for every request that used to include it, not just get
 * ignored server-side. `DEV_TENANT_SLUG` stays exported for any dev-only
 * tooling that still wants it, but no fetch here sends it as a header.
 */
export const DEV_TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT ?? 'greenwood';

function scopeHeaders(scope?: { campusId?: string; academicYearId?: string }): HeadersInit {
  return {
    ...(scope?.campusId ? { 'x-campus-id': scope.campusId } : {}),
    ...(scope?.academicYearId ? { 'x-academic-year-id': scope.academicYearId } : {}),
  };
}

export interface HealthDependency {
  status: 'up' | 'down' | string;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: 'ok' | 'error' | string;
  info?: Record<string, HealthDependency>;
  error?: Record<string, HealthDependency>;
  details?: Record<string, HealthDependency>;
  [key: string]: unknown;
}

export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('The API is unreachable.');
    this.name = 'ApiUnreachableError';
    this.cause = cause;
  }
}

/**
 * Fetches GET /api/v1/health. Never throws a raw network error - always
 * normalises to ApiUnreachableError so the UI can render a calm offline
 * state instead of crashing an error boundary.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1/health`, {
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }

  const body = (await response.json().catch(() => null)) as HealthResponse | null;

  if (!response.ok && !body) {
    throw new ApiUnreachableError(new Error(`HTTP ${response.status}`));
  }

  return body ?? { status: 'error' };
}

// ---------------------------------------------------------------------------
// Tenancy scope
// ---------------------------------------------------------------------------

export interface ScopeCampus {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  status: string;
}

export interface ScopeAcademicYear {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: 'planning' | 'open' | 'locked' | 'archived' | string;
  isCurrent: boolean;
}

export interface ScopeResponse {
  tenant: { id: string; name: string; slug: string };
  campuses: ScopeCampus[];
  academicYears: ScopeAcademicYear[];
  current: { campusId: string | null; academicYearId: string | null };
}

export async function fetchScope(
  scope?: { campusId?: string; academicYearId?: string },
  signal?: AbortSignal,
): Promise<ScopeResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1/tenancy/scope`, {
      credentials: 'include',
      headers: scopeHeaders(scope),
      signal,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }

  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `Could not load the working scope (HTTP ${response.status}).`);
  }

  return (await response.json()) as ScopeResponse;
}

// ---------------------------------------------------------------------------
// Access - roles, permissions, impersonation
// ---------------------------------------------------------------------------

export type AccessScope = 'own' | 'section' | 'grade_level' | 'campus' | 'tenant';

export interface AccessPermissionGrant {
  key: string;
  resource: string;
  action: string;
  scope: AccessScope;
}

export interface AccessMeRole {
  id: string;
  key: string;
  name: string;
}

export interface AccessImpersonationState {
  actorUserId: string;
  targetUserId: string;
  targetName: string;
  reason: string;
  startedAt: string;
}

export interface AccessMeResponse {
  permissions: AccessPermissionGrant[];
  roles: AccessMeRole[];
  impersonating: AccessImpersonationState | null;
}

export interface AccessRoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /**
   * The API returns the grants themselves, not a precomputed count. Derive the
   * count from this rather than declaring a `permissionCount` field the server
   * never sends - an absent field renders as `undefined` and produces a label
   * reading "  permissions ·   assigned", which looks like a broken page.
   */
  grants?: Array<{ permission: { key: string }; scope: string }>;
}

export interface AccessPermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
  description: string | null;
}

/**
 * Throws UnauthorizedError / ForbiddenError / a generic Error for a
 * non-ok response; resolves (without reading the body) otherwise. Shared by
 * every access/* helper below so each one only has to describe its own
 * fallback error message.
 */
async function assertAccessOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (response.status === 403) {
    throw new ForbiddenError();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

async function accessFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/access${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

/** GET /api/v1/access/me - the caller's own permissions, roles, and impersonation state. */
export async function fetchAccessMe(signal?: AbortSignal): Promise<AccessMeResponse> {
  const response = await accessFetch('/me', { signal });
  await assertAccessOk(response, `Could not load your permissions (HTTP ${response.status}).`);
  return (await response.json()) as AccessMeResponse;
}

/** GET /api/v1/access/roles - every role defined in the tenant. */
export async function fetchAccessRoles(signal?: AbortSignal): Promise<AccessRoleSummary[]> {
  const response = await accessFetch('/roles', { signal });
  await assertAccessOk(response, `Could not load roles (HTTP ${response.status}).`);
  return (await response.json()) as AccessRoleSummary[];
}

/** GET /api/v1/access/permissions - the full permission catalog, independent of any role. */
export async function fetchAccessPermissions(
  signal?: AbortSignal,
): Promise<AccessPermissionCatalogEntry[]> {
  const response = await accessFetch('/permissions', { signal });
  await assertAccessOk(response, `Could not load the permission catalog (HTTP ${response.status}).`);
  return (await response.json()) as AccessPermissionCatalogEntry[];
}

/**
 * GET /api/v1/access/roles/:id/permissions - the permissions granted to one
 * role, each with the scope it was granted at.
 *
 * NOT part of the pinned contract (only /access/roles and /access/permissions
 * are listed there), but the roles & permissions screen's matrix has no other
 * way to know which scope a role holds per permission. This is the most
 * conservative, REST-conventional extension of the already-pinned
 * `/access/roles` resource. It fails gracefully like every other call here -
 * if the backend ships something different, the matrix shows its normal
 * error state (with retry) instead of crashing.
 */
export async function fetchAccessRolePermissions(
  roleId: string,
  signal?: AbortSignal,
): Promise<AccessPermissionGrant[]> {
  const response = await accessFetch(`/roles/${encodeURIComponent(roleId)}/permissions`, { signal });
  await assertAccessOk(
    response,
    `Could not load permissions for this role (HTTP ${response.status}).`,
  );
  return (await response.json()) as AccessPermissionGrant[];
}

/** POST /api/v1/access/impersonation - begin impersonating another user. */
export async function startImpersonation(input: {
  targetUserId: string;
  reason: string;
}): Promise<void> {
  const response = await accessFetch('/impersonation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertAccessOk(response, `Could not start impersonation (HTTP ${response.status}).`);
}

/** DELETE /api/v1/access/impersonation - stop impersonating and return to the real session. */
export async function stopImpersonation(): Promise<void> {
  const response = await accessFetch('/impersonation', { method: 'DELETE' });
  await assertAccessOk(response, `Could not stop impersonating (HTTP ${response.status}).`);
}

// ---------------------------------------------------------------------------
// People - directory, profile, relationships, alerts, duplicates
// ---------------------------------------------------------------------------
//
// Shapes below mirror libs/domain/people/src/api/people.controller.ts and its
// DTOs exactly - that file is off-limits to edit, so this is read, not
// guessed. Two real gaps against a "roles as chips" / "primary identifier"
// directory column that a naive reading of the brief might expect:
//
//   1. GET /people and GET /people/:id return bare `Person` fields only
//      (given/family/preferred name, DOB, gender, photoFileId, customFields,
//      mergedIntoId, timestamps [+ the two masked alert flags on :id]).
//      PersonRole and PersonIdentifier are never embedded in either -
//      PeopleContract.listRoles/listIdentifiers exist, but PeopleController
//      never wires either up to a route (only /relationships, /alerts,
//      /duplicates exist beyond base CRUD). So neither a role chip nor a
//      "primary identifier" column can be populated from real data without
//      inventing an endpoint - out of scope (apps/api and libs/domain/people
//      are off-limits here). `role`/`campusId` remain valid SEARCH params
//      (server-side filtering), just not values this client can read back
//      per row.
//   2. `customFields.grade_level` (a real, seeded custom field) IS present
//      on `Person`, so grade level is genuinely renderable "where present".

export type PersonRoleType = 'student' | 'guardian' | 'staff' | 'alumni';
export const PERSON_ROLE_TYPES: readonly PersonRoleType[] = ['student', 'guardian', 'staff', 'alumni'];

export type RelationshipType =
  | 'parent'
  | 'guardian'
  | 'sibling'
  | 'emergency_contact'
  | 'authorized_pickup'
  | 'other';

export type AlertCategory = 'medical' | 'safeguarding' | 'access' | 'other';
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Mirrors `people.person`. Dates are `YYYY-MM-DD` strings, timestamps ISO - both arrive as JSON strings, never `Date` instances. */
export interface Person {
  id: string;
  tenantId: string;
  givenName: string;
  familyName: string;
  preferredName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  photoFileId: string | null;
  customFields: Record<string, unknown>;
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /people/:id's shape: `Person` plus two derived booleans, each REMOVED
 * from the JSON body entirely (not sent as `false`) when the caller lacks
 * `people.student:read_medical` / `read_safeguarding` - see
 * `@sms/access`'s `maskFields`, which `delete`s the key rather than nulling
 * it. Modelled as optional for exactly that reason: `undefined` here means
 * "masked, unknown" and must never be treated as `false` ("known: no
 * alerts") by a caller. Never render "no alerts" for an absent flag.
 */
export interface PersonDetail extends Person {
  hasMedicalAlerts?: boolean;
  hasSafeguardingAlerts?: boolean;
}

/** Mirrors `people.relationship`. Directed: `fromPersonId` is (e.g.) the parent OF `toPersonId`. */
export interface Relationship {
  id: string;
  tenantId: string;
  fromPersonId: string;
  toPersonId: string;
  type: RelationshipType;
  hasCustody: boolean;
  mayPickup: boolean;
  mayReceiveComms: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `people.person_alert`. The LIST endpoint already row-filters by category against the caller's ability (see `AlertService.listAlerts`) - every row present here is one the caller is allowed to see. */
export interface PersonAlert {
  id: string;
  tenantId: string;
  personId: string;
  category: AlertCategory;
  severity: AlertSeverity;
  summary: string;
  detail: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateCandidate {
  person: Person;
  /** 0..1, higher = more likely a duplicate. */
  score: number;
  reasons: string[];
}

export interface PersonPage {
  items: Person[];
  nextCursor: string | null;
}

export interface SearchPeopleParams {
  query?: string;
  role?: PersonRoleType;
  campusId?: string;
  limit?: number;
  cursor?: string;
}

export interface MergePersonsInput {
  survivingId: string;
  mergedId: string;
  reason: string;
}

export interface PersonMerge {
  id: string;
  tenantId: string;
  survivingPersonId: string;
  mergedPersonId: string;
  mergedByUserId: string;
  reason: string | null;
  mergedAt: string;
  payload: Record<string, unknown>;
}

async function peopleFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/people${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

/** Same shared shape as `assertAccessOk` - kept as its own copy so this section reads standalone against `people.controller.ts`. */
async function assertPeopleOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (response.status === 403) {
    throw new ForbiddenError();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

/** Query key for a single person's `GET /people/:id` - shared between the directory row's alert-flag prefetch and the detail page, so opening a profile the list already rendered is served warm from cache. */
export function personDetailQueryKey(id: string): readonly [string, string, string] {
  return ['people', 'detail', id] as const;
}

/** GET /api/v1/people - free-text name search plus optional role/campus filters, keyset-paginated. */
export async function fetchPeople(params: SearchPeopleParams, signal?: AbortSignal): Promise<PersonPage> {
  const search = new URLSearchParams();
  if (params.query) search.set('query', params.query);
  if (params.role) search.set('role', params.role);
  if (params.campusId) search.set('campusId', params.campusId);
  search.set('limit', String(params.limit ?? 50));
  if (params.cursor) search.set('cursor', params.cursor);

  const response = await peopleFetch(`?${search.toString()}`, { signal });
  await assertPeopleOk(response, `Could not load people (HTTP ${response.status}).`);
  return (await response.json()) as PersonPage;
}

/** GET /api/v1/people/:id - resolves through any merge chain first, per `PeopleContract.getPerson`. */
export async function fetchPerson(id: string, signal?: AbortSignal): Promise<PersonDetail> {
  const response = await peopleFetch(`/${encodeURIComponent(id)}`, { signal });
  await assertPeopleOk(response, `Could not load this person (HTTP ${response.status}).`);
  return (await response.json()) as PersonDetail;
}

/** GET /api/v1/people/:id/relationships - every relationship where this person is either side. */
export async function fetchPersonRelationships(id: string, signal?: AbortSignal): Promise<Relationship[]> {
  const response = await peopleFetch(`/${encodeURIComponent(id)}/relationships`, { signal });
  await assertPeopleOk(response, `Could not load relationships (HTTP ${response.status}).`);
  return (await response.json()) as Relationship[];
}

/** GET /api/v1/people/:id/alerts - already row-filtered by the caller's read_medical/read_safeguarding grants. */
export async function fetchPersonAlerts(id: string, signal?: AbortSignal): Promise<PersonAlert[]> {
  const response = await peopleFetch(`/${encodeURIComponent(id)}/alerts`, { signal });
  await assertPeopleOk(response, `Could not load alerts (HTTP ${response.status}).`);
  return (await response.json()) as PersonAlert[];
}

/** GET /api/v1/people/:id/duplicates - scored candidates that plausibly describe the same person. */
export async function fetchPersonDuplicates(id: string, signal?: AbortSignal): Promise<DuplicateCandidate[]> {
  const response = await peopleFetch(`/${encodeURIComponent(id)}/duplicates`, { signal });
  await assertPeopleOk(response, `Could not load possible duplicates (HTTP ${response.status}).`);
  return (await response.json()) as DuplicateCandidate[];
}

/** POST /api/v1/people/merge - destructive and one-way; callers must confirm explicitly before calling this. */
export async function mergePersons(input: MergePersonsInput): Promise<PersonMerge> {
  const response = await peopleFetch('/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertPeopleOk(response, `Could not merge these records (HTTP ${response.status}).`);
  return (await response.json()) as PersonMerge;
}

// ---------------------------------------------------------------------------
// Academic - grade levels (read-only here; used to label/sort by grade)
// ---------------------------------------------------------------------------
//
// Mirrors libs/domain/academic/src/domain/types.ts's GradeLevel exactly.
// Gated server-side by `academic.grade_level:read`, a DIFFERENT permission
// from `enrollment.enrollment:read` - a caller who can see enrollments but
// not the grade-level catalogue gets a 403 here. Every call site treats that
// as non-fatal (falls back to showing the raw id) rather than blocking the
// page - see enrollment/page.tsx and enrollment/rollover/page.tsx.

export interface GradeLevel {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/academic/grade-levels - every grade level, unordered by the server (sort by `sequence` client-side). */
export async function fetchGradeLevels(signal?: AbortSignal): Promise<GradeLevel[]> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1/academic/grade-levels`, {
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Could not load grade levels (HTTP ${response.status}).`);
  }
  return (await response.json()) as GradeLevel[];
}

// ---------------------------------------------------------------------------
// Import / export - CSV import wizard
// ---------------------------------------------------------------------------
//
// Shapes below mirror libs/platform/import-export/src/contract.ts and
// domain/types.ts exactly. Three load-bearing quirks learned driving the API
// live (see this repo's own task brief):
//   1. The job state machine is enforced server-side - dryRun refuses a job
//      with no mapping set; commit refuses anything but status "previewed";
//      revert refuses anything but "completed". The wizard mirrors this by
//      deriving its current step from `job.status`, not from local UI state,
//      so a refresh/shared link resumes at the right screen.
//   2. POST .../mapping takes the mapping object as the BARE body
//      (`{ csvHeader: fieldKey }`), not wrapped in an envelope.
//   3. dry-run/commit/revert are body-less POSTs and must NOT send a
//      `content-type` header - Fastify rejects an empty body when that
//      header is present. See importExportFetch's `init` handling below.

export type ImportJobStatus =
  | 'mapping'
  | 'validating'
  | 'previewed'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'reverted';

export type ImportRowOutcome = 'pending' | 'valid' | 'error' | 'created' | 'updated' | 'skipped';

/** Target field key -> source CSV header name. */
export type ColumnMapping = Record<string, string>;

export interface ImportFieldSpec {
  key: string;
  label: string;
  required: boolean;
  type: 'text' | 'number' | 'date' | 'boolean';
}

export interface ImportTargetSummary {
  entityType: string;
  fields: ImportFieldSpec[];
}

export interface ImportJob {
  id: string;
  tenantId: string;
  entityType: string;
  filename: string;
  status: ImportJobStatus;
  columnMapping: ColumnMapping;
  options: Record<string, unknown>;
  rowCount: number;
  validCount: number;
  errorCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  bulkOperationId?: string;
  createdByUserId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ImportRowError {
  field?: string;
  message: string;
}

export interface ImportRow {
  id: string;
  tenantId: string;
  importJobId: string;
  rowNumber: number;
  raw: Record<string, string>;
  normalised?: Record<string, unknown>;
  rowHash: string;
  outcome: ImportRowOutcome;
  errors: ImportRowError[];
  targetId?: string;
}

export interface CreateImportJobResult {
  job: ImportJob;
  /** Fuzzy-matched target field key -> CSV header, to pre-fill the mapping step. Only ever returned here - see the mapping step's own comment on caching it for a same-session refresh. */
  suggestedMapping: ColumnMapping;
  headers: string[];
}

export interface DryRunRowError {
  rowNumber: number;
  errors: ImportRowError[];
}

export interface DryRunSummary {
  job: ImportJob;
  rowCount: number;
  validCount: number;
  errorCount: number;
  predictedCreateCount: number;
  predictedUpdateCount: number;
  /** First N errors only - the point is showing what's wrong, not a 1,200-line response. */
  firstErrors: DryRunRowError[];
}

export interface CommitSummary {
  job: ImportJob;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  skippedCount: number;
}

export interface ImportRowPage {
  items: ImportRow[];
  nextCursor: string | null;
}

async function importExportFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/import${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertImportOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

/** GET /api/v1/import/targets - every importable entity type and its field spec, for the mapping UI. */
export async function fetchImportTargets(signal?: AbortSignal): Promise<ImportTargetSummary[]> {
  const response = await importExportFetch('/targets', { signal });
  await assertImportOk(response, `Could not load import targets (HTTP ${response.status}).`);
  return (await response.json()) as ImportTargetSummary[];
}

/** POST /api/v1/import/jobs - parses `csv`'s header row server-side and returns the job plus a suggested mapping. */
export async function createImportJob(input: {
  entityType: string;
  filename: string;
  csv: string;
}): Promise<CreateImportJobResult> {
  const response = await importExportFetch('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertImportOk(response, `Could not create the import job (HTTP ${response.status}).`);
  return (await response.json()) as CreateImportJobResult;
}

/** GET /api/v1/import/jobs - most recent import jobs, newest first. */
export async function fetchImportJobs(signal?: AbortSignal): Promise<ImportJob[]> {
  const response = await importExportFetch('/jobs', { signal });
  await assertImportOk(response, `Could not load import history (HTTP ${response.status}).`);
  return (await response.json()) as ImportJob[];
}

/** GET /api/v1/import/jobs/:id */
export async function fetchImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJob> {
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}`, { signal });
  await assertImportOk(response, `Could not load this import job (HTTP ${response.status}).`);
  return (await response.json()) as ImportJob;
}

/** GET /api/v1/import/jobs/:id/rows - paginated rows, optionally filtered by outcome (e.g. "error" for the preview step's sample values / error table). */
export async function fetchImportRows(
  jobId: string,
  params: { outcome?: ImportRowOutcome; limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<ImportRowPage> {
  const search = new URLSearchParams();
  if (params.outcome) search.set('outcome', params.outcome);
  search.set('limit', String(params.limit ?? 50));
  if (params.cursor) search.set('cursor', params.cursor);
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}/rows?${search.toString()}`, {
    signal,
  });
  await assertImportOk(response, `Could not load rows for this import job (HTTP ${response.status}).`);
  return (await response.json()) as ImportRowPage;
}

/** POST /api/v1/import/jobs/:id/mapping - the mapping object is the BARE body, not wrapped. */
export async function setImportMapping(jobId: string, mapping: ColumnMapping): Promise<ImportJob> {
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}/mapping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapping),
  });
  await assertImportOk(response, `Could not save the column mapping (HTTP ${response.status}).`);
  return (await response.json()) as ImportJob;
}

/**
 * POST /api/v1/import/jobs/:id/dry-run - body-less. Deliberately sends no
 * `init` object at all (not even `{ method: 'POST' }` plus empty headers) so
 * no `content-type` header rides along - Fastify 400s a body-less POST that
 * declares one. Requires a column mapping to already be set.
 */
export async function dryRunImportJob(jobId: string): Promise<DryRunSummary> {
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}/dry-run`, { method: 'POST' });
  await assertImportOk(response, `Could not run the dry run (HTTP ${response.status}).`);
  return (await response.json()) as DryRunSummary;
}

/** POST /api/v1/import/jobs/:id/commit - body-less, same header caveat as dryRunImportJob. Requires status "previewed". */
export async function commitImportJob(jobId: string): Promise<CommitSummary> {
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}/commit`, { method: 'POST' });
  await assertImportOk(response, `Could not commit the import (HTTP ${response.status}).`);
  return (await response.json()) as CommitSummary;
}

/**
 * POST /api/v1/import/jobs/:id/revert - body-less, same header caveat.
 * Requires status "completed". Archives every created row and restores every
 * updated row to its prior state - it does NOT delete imported people (see
 * PipelineService.revert: people.person has no DELETE grant by design, so a
 * created row is archived, not removed). Every screen that offers this must
 * say that plainly.
 */
export async function revertImportJob(jobId: string): Promise<ImportJob> {
  const response = await importExportFetch(`/jobs/${encodeURIComponent(jobId)}/revert`, { method: 'POST' });
  await assertImportOk(response, `Could not undo this import (HTTP ${response.status}).`);
  return (await response.json()) as ImportJob;
}

// ---------------------------------------------------------------------------
// Enrollment - records, status history, year rollover
// ---------------------------------------------------------------------------
//
// Shapes below mirror libs/domain/enrollment/src/domain/types.ts and
// contract.ts exactly.

export type EnrollmentStatus = 'applied' | 'enrolled' | 'withdrawn' | 'graduated' | 'transferred_out';
export const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  'applied',
  'enrolled',
  'withdrawn',
  'graduated',
  'transferred_out',
];

/**
 * The legal enrolment status graph, duplicated from
 * libs/domain/enrollment/src/domain/types.ts's `LEGAL_STATUS_TRANSITIONS`
 * (apps/web has no dependency on that library, and this task may not add
 * one - see the module's own CONSTRAINTS). This is a UX convenience only,
 * exactly like usePermissions()'s `can()`: it decides which transitions the
 * dialog bothers to offer, nothing more. The API is the real enforcement -
 * `EnrollmentRecordService.transitionStatus` re-checks `isLegalStatusTransition`
 * server-side on every call regardless of what this list allowed the user to
 * pick, so a mismatch here can only under-offer a legal transition, never
 * let an illegal one through.
 */
export const LEGAL_STATUS_TRANSITIONS: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  applied: ['enrolled', 'withdrawn'],
  enrolled: ['withdrawn', 'graduated', 'transferred_out'],
  withdrawn: ['enrolled'],
  graduated: [],
  transferred_out: [],
};

/** Mirrors `enrollment.enrollment`. One row per (person, academic_year). */
export interface Enrollment {
  id: string;
  tenantId: string;
  personId: string;
  academicYearId: string;
  campusId: string;
  gradeLevelId: string;
  studentNumber: string | null;
  status: EnrollmentStatus;
  enrolledOn: string;
  exitedOn: string | null;
  exitReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `enrollment.status_event` - the immutable history `Enrollment.status` is only ever a cache of. */
export interface EnrollmentStatusEvent {
  id: string;
  tenantId: string;
  enrollmentId: string;
  fromStatus: EnrollmentStatus | null;
  toStatus: EnrollmentStatus;
  effectiveOn: string;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface EnrollmentPage {
  items: Enrollment[];
  nextCursor: string | null;
}

export interface ListEnrollmentsParams {
  academicYearId?: string;
  campusId?: string;
  gradeLevelId?: string;
  status?: EnrollmentStatus;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface TransitionEnrollmentStatusInput {
  toStatus: EnrollmentStatus;
  effectiveOn: string;
  reason?: string | null;
}

async function enrollmentFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/enrollment${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertEnrollmentOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

/** GET /api/v1/enrollment/enrollments - keyset-paginated, filterable by academic year, campus, grade level, status, and free-text (matches the enrolled person's name or student number). */
export async function fetchEnrollments(
  params: ListEnrollmentsParams,
  signal?: AbortSignal,
): Promise<EnrollmentPage> {
  const search = new URLSearchParams();
  if (params.academicYearId) search.set('academicYearId', params.academicYearId);
  if (params.campusId) search.set('campusId', params.campusId);
  if (params.gradeLevelId) search.set('gradeLevelId', params.gradeLevelId);
  if (params.status) search.set('status', params.status);
  if (params.query) search.set('query', params.query);
  search.set('limit', String(params.limit ?? 50));
  if (params.cursor) search.set('cursor', params.cursor);

  const response = await enrollmentFetch(`/enrollments?${search.toString()}`, { signal });
  await assertEnrollmentOk(response, `Could not load enrollments (HTTP ${response.status}).`);
  return (await response.json()) as EnrollmentPage;
}

/** GET /api/v1/enrollment/enrollments/:id */
export async function fetchEnrollment(id: string, signal?: AbortSignal): Promise<Enrollment> {
  const response = await enrollmentFetch(`/enrollments/${encodeURIComponent(id)}`, { signal });
  await assertEnrollmentOk(response, `Could not load this enrollment (HTTP ${response.status}).`);
  return (await response.json()) as Enrollment;
}

/** GET /api/v1/enrollment/enrollments/:id/history - every status_event for this enrolment, oldest first per the API; the timeline UI reverses it to newest first. */
export async function fetchEnrollmentHistory(id: string, signal?: AbortSignal): Promise<EnrollmentStatusEvent[]> {
  const response = await enrollmentFetch(`/enrollments/${encodeURIComponent(id)}/history`, { signal });
  await assertEnrollmentOk(response, `Could not load the status history (HTTP ${response.status}).`);
  return (await response.json()) as EnrollmentStatusEvent[];
}

/** POST /api/v1/enrollment/enrollments/:id/transition - appends a status_event and updates the enrolment's denormalised status in one transaction; the history itself is never edited. */
export async function transitionEnrollmentStatus(
  id: string,
  input: TransitionEnrollmentStatusInput,
): Promise<Enrollment> {
  const response = await enrollmentFetch(`/enrollments/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertEnrollmentOk(response, `Could not change this enrollment's status (HTTP ${response.status}).`);
  return (await response.json()) as Enrollment;
}

// ---------------------------------------------------------------------------
// Enrollment - year rollover
// ---------------------------------------------------------------------------

export type RolloverOutcomeResult = 'promoted' | 'skipped_no_mapping' | 'skipped_already_enrolled';

export interface RolloverOutcome {
  personId: string;
  fromEnrollmentId: string;
  toEnrollmentId: string | null;
  fromGradeLevelId: string;
  toGradeLevelId: string | null;
  result: RolloverOutcomeResult;
}

export interface RolloverCounts {
  consideredCount: number;
  promotedCount: number;
  skippedCount: number;
}

export interface RolloverResult {
  counts: RolloverCounts;
  outcomes: RolloverOutcome[];
  bulkOperationId: string | null;
  rolloverRunId: string | null;
  dryRun: boolean;
}

export interface RollOverYearInput {
  fromAcademicYearId: string;
  toAcademicYearId: string;
  /** `fromGradeLevelId -> toGradeLevelId`. A grade level with no entry is skipped (recorded `skipped_no_mapping`), never guessed at. */
  promotionMap: Record<string, string>;
  /** `true` computes and returns exactly what a real run would do, writing nothing. */
  dryRun?: boolean;
}

/** POST /api/v1/enrollment/rollover - same response shape for a dry run and a real run (see RollOverYearInput.dryRun's own comment); only a real run (dryRun: false/omitted) is gated `enrollment.rollover:run` and writes anything. */
export async function rollOverYear(input: RollOverYearInput): Promise<RolloverResult> {
  const response = await enrollmentFetch('/rollover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertEnrollmentOk(response, `Could not run the year rollover (HTTP ${response.status}).`);
  return (await response.json()) as RolloverResult;
}

// ---------------------------------------------------------------------------
// Attendance - codes, session roster, marking, corrections, unmarked-sessions
// ---------------------------------------------------------------------------
//
// Shapes below mirror libs/domain/attendance/src/domain/types.ts and
// contract.ts exactly - that module is off-limits to edit, so this is read,
// not guessed. Two behaviours confirmed driving the API live (see this
// task's own brief):
//   1. A session that does not run on the requested date 403s ("Section
//      meeting ... does not run on ...") rather than 404ing - every caller
//      here only ever offers a date drawn from `unmarked-sessions` or a
//      timetable, never a guessed one.
//   2. Editing an ALREADY-marked record more than 24h (`ATTENDANCE_LOCK_WINDOW_HOURS`
//      in AttendanceRecordService) after it was first marked fails the WHOLE
//      batch with a 422 VALIDATION_ERROR whose message reads "...is locked -
//      request a correction instead of re-submitting." `AttendanceLockedError`
//      below lets a caller single that out from every other failure mode and
//      offer the correction flow instead of a "Retry" that would only fail
//      again the exact same way. Resubmitting UNCHANGED marks never hits this
//      (the service no-ops on marks that didn't actually change), so an
//      already-marked session can always be safely reopened and resubmitted
//      as-is - only genuine edits to an old mark can be locked.

export type AttendanceCategory = 'present' | 'absent' | 'late' | 'excused';

/** Mirrors `attendance.code` - the tenant-configured code catalogue (never hardcoded client-side). */
export interface AttendanceCode {
  id: string;
  tenantId: string;
  code: string;
  label: string;
  category: AttendanceCategory;
  countsAsPresent: boolean;
  isDefault: boolean;
  requiresReason: boolean;
  sequence: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `attendance.record`: the current state of one person's attendance for one date/session. */
export interface AttendanceRecord {
  id: string;
  tenantId: string;
  personId: string;
  sectionId: string | null;
  sectionMeetingId: string | null;
  date: string;
  codeId: string;
  minutesLate: number | null;
  note: string | null;
  markedByUserId: string | null;
  markedAt: string;
}

/** Mirrors `attendance.submission` - the idempotency ledger row `markSession` writes once per NEW (non-replayed) call. */
export interface AttendanceSubmission {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  sectionMeetingId: string;
  date: string;
  submittedByUserId: string | null;
  recordCount: number;
  createdAt: string;
}

/** One student on a session roster, pre-filled with any mark already recorded for this exact (person, sectionMeetingId, date). */
export interface RosterEntry {
  personId: string;
  givenName: string;
  familyName: string;
  existingRecordId: string | null;
  codeId: string | null;
  minutesLate: number | null;
  note: string | null;
}

/** What `getSessionRoster` returns - the marking screen's own data source. */
export interface SessionRoster {
  sectionMeetingId: string;
  sectionId: string;
  date: string;
  periodId: string;
  periodName: string;
  entries: RosterEntry[];
}

/** One class that has not yet had attendance submitted for `date` - what `listUnmarkedSessions` reports. */
export interface UnmarkedSession {
  sectionMeetingId: string;
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  campusId: string;
  periodId: string;
  periodName: string;
  date: string;
}

export interface MarkInput {
  personId: string;
  codeId: string;
  minutesLate?: number;
  note?: string;
}

export interface MarkSessionInput {
  sectionMeetingId: string;
  date: string;
  /** Generate ONCE per session-load, reuse for every retry of that same submission - see this section's own top comment. */
  idempotencyKey: string;
  marks: MarkInput[];
}

export interface MarkSessionResult {
  records: AttendanceRecord[];
  submission: AttendanceSubmission;
  /** `true` when `idempotencyKey` had already been submitted - `records`/`submission` are the ORIGINAL result; nothing was written this call. */
  replayed: boolean;
}

export type CorrectionStatus = 'pending' | 'approved' | 'rejected';

/** Mirrors `attendance.correction` - the only way to change a record locked past the 24h free-edit window. */
export interface AttendanceCorrection {
  id: string;
  tenantId: string;
  recordId: string;
  fromCodeId: string;
  toCodeId: string;
  reason: string | null;
  requestedByUserId: string | null;
  status: CorrectionStatus;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface RequestAttendanceCorrectionInput {
  recordId: string;
  toCodeId: string;
  reason?: string;
}

/**
 * Thrown by `markSession` specifically for the 24h-lock case (see this
 * section's own top comment). Kept distinct from a plain Error so the
 * marking screen can single it out and offer "request a correction" instead
 * of a "Retry" that would only fail again the same way.
 */
export class AttendanceLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttendanceLockedError';
  }
}

async function attendanceFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/attendance${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertAttendanceOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    const message = body?.error?.message ?? fallbackMessage;
    if (response.status === 422 && body?.error?.code === 'VALIDATION_ERROR' && /locked/i.test(message)) {
      throw new AttendanceLockedError(message);
    }
    throw new Error(message);
  }
}

/** GET /api/v1/attendance/codes - every tenant-configured code, active and inactive alike. */
export async function fetchAttendanceCodes(signal?: AbortSignal): Promise<AttendanceCode[]> {
  const response = await attendanceFetch('/codes', { signal });
  await assertAttendanceOk(response, `Could not load attendance codes (HTTP ${response.status}).`);
  return (await response.json()) as AttendanceCode[];
}

/** GET /api/v1/attendance/unmarked-sessions - sections meeting on `date` (by day-of-week) with no submission yet, already scoped to the caller. The single most-used administrative view - see the contract's own comment. */
export async function fetchUnmarkedSessions(
  params: { date: string; campusId?: string },
  signal?: AbortSignal,
): Promise<UnmarkedSession[]> {
  const search = new URLSearchParams();
  search.set('date', params.date);
  if (params.campusId) search.set('campusId', params.campusId);
  const response = await attendanceFetch(`/unmarked-sessions?${search.toString()}`, { signal });
  await assertAttendanceOk(response, `Could not load today's sessions (HTTP ${response.status}).`);
  return (await response.json()) as UnmarkedSession[];
}

/** GET /api/v1/attendance/sessions/:sectionMeetingId/roster - 403s ("does not run on ...") for a date the meeting does not meet; only ever call with a date drawn from `unmarked-sessions` or a timetable. */
export async function fetchSessionRoster(
  sectionMeetingId: string,
  date: string,
  signal?: AbortSignal,
): Promise<SessionRoster> {
  const response = await attendanceFetch(
    `/sessions/${encodeURIComponent(sectionMeetingId)}/roster?date=${encodeURIComponent(date)}`,
    { signal },
  );
  await assertAttendanceOk(response, `Could not load this register (HTTP ${response.status}).`);
  return (await response.json()) as SessionRoster;
}

/**
 * POST /api/v1/attendance/sessions/mark - the teacher's bulk submit. See
 * `MarkSessionInput.idempotencyKey`'s own comment: callers must generate it
 * ONCE per session-load and reuse it for every retry of that same
 * submission - a fresh key per click defeats the whole point, turning a
 * flaky-network double-tap into two real submissions.
 */
export async function markSession(input: MarkSessionInput): Promise<MarkSessionResult> {
  const response = await attendanceFetch('/sessions/mark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertAttendanceOk(response, `Could not save this register (HTTP ${response.status}).`);
  return (await response.json()) as MarkSessionResult;
}

/** POST /api/v1/attendance/corrections - the only way to change a record locked past the 24h free-edit window; `fromCodeId` is resolved server-side from the record's current code, never accepted as input. */
export async function requestAttendanceCorrection(
  input: RequestAttendanceCorrectionInput,
): Promise<AttendanceCorrection> {
  const response = await attendanceFetch('/corrections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertAttendanceOk(response, `Could not request a correction (HTTP ${response.status}).`);
  return (await response.json()) as AttendanceCorrection;
}

// ---------------------------------------------------------------------------
// Academic - scheduling / timetables (read-only here), rooms
// ---------------------------------------------------------------------------
//
// Shapes below mirror libs/domain/academic/src/domain/types.ts exactly.

export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Mirrors `academic.room`. */
export interface Room {
  id: string;
  tenantId: string;
  campusId: string;
  code: string;
  name: string;
  capacity: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One concrete occurrence of a section meeting on a specific calendar date -
 * what the timetable endpoints expand `section_meeting` into over a
 * requested `[from, to]` window, substitutions already resolved.
 * `isSubstituted`/`isSubstituting` are populated when `academic.substitution`
 * covers this exact (sectionMeetingId, date) - see the domain type's own
 * comment for which of the two applies to which "whose timetable" view.
 */
export interface TimetableEntry {
  date: string;
  dayOfWeek: DayOfWeek;
  sectionMeetingId: string;
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  periodId: string;
  periodName: string;
  startsAt: string;
  endsAt: string;
  roomId: string | null;
  roomCode: string | null;
  isSubstituted: boolean;
  isSubstituting: boolean;
  substitutePersonId: string | null;
  substituteReason: string | null;
}

export interface TimetableRange {
  from: string;
  to: string;
}

async function academicFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/academic${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertAcademicOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

function timetableRangeQuery(range: TimetableRange): string {
  return new URLSearchParams({ from: range.from, to: range.to }).toString();
}

/** GET /api/v1/academic/timetables/teacher/mine - the signed-in teacher's OWN timetable; resolves `personId` server-side from the session, so there is no id to leak in the URL. */
export async function fetchMyTeacherTimetable(range: TimetableRange, signal?: AbortSignal): Promise<TimetableEntry[]> {
  const response = await academicFetch(`/timetables/teacher/mine?${timetableRangeQuery(range)}`, { signal });
  await assertAcademicOk(response, `Could not load your timetable (HTTP ${response.status}).`);
  return (await response.json()) as TimetableEntry[];
}

/** GET /api/v1/academic/timetables/teacher/:personId - an admin's view of a specific teacher's timetable. */
export async function fetchTeacherTimetable(
  personId: string,
  range: TimetableRange,
  signal?: AbortSignal,
): Promise<TimetableEntry[]> {
  const response = await academicFetch(`/timetables/teacher/${encodeURIComponent(personId)}?${timetableRangeQuery(range)}`, {
    signal,
  });
  await assertAcademicOk(response, `Could not load this teacher's timetable (HTTP ${response.status}).`);
  return (await response.json()) as TimetableEntry[];
}

/** GET /api/v1/academic/timetables/room/:roomId - what a room is booked for over `range`. */
export async function fetchRoomTimetable(
  roomId: string,
  range: TimetableRange,
  signal?: AbortSignal,
): Promise<TimetableEntry[]> {
  const response = await academicFetch(`/timetables/room/${encodeURIComponent(roomId)}?${timetableRangeQuery(range)}`, {
    signal,
  });
  await assertAcademicOk(response, `Could not load this room's timetable (HTTP ${response.status}).`);
  return (await response.json()) as TimetableEntry[];
}

/** GET /api/v1/academic/rooms - every room, tenant-wide reference data. Gated `academic.room:read` - a DIFFERENT permission from `academic.timetable:read`, so a section-scoped teacher may well lack it; callers treat that as non-fatal (see the timetable page's own room picker). */
export async function fetchRooms(signal?: AbortSignal): Promise<Room[]> {
  const response = await academicFetch('/rooms', { signal });
  await assertAcademicOk(response, `Could not load rooms (HTTP ${response.status}).`);
  return (await response.json()) as Room[];
}

// ---------------------------------------------------------------------------
// Academic - sections (roster + "my sections"), terms/grading periods
// ---------------------------------------------------------------------------
//
// Shapes mirror libs/domain/academic/src/domain/types.ts exactly. Two things
// confirmed driving the API live for the gradebook (see this task's brief):
//   1. GET /academic/sections/mine resolves the caller's OWN linked
//      people.person (ctx.personId) server-side - it takes no id, and
//      returns [] for a caller with no linked person (e.g. an admin who
//      isn't also a teacher), not an error.
//   2. GET /academic/terms and GET /academic/terms/:id/grading-periods are
//      gated `academic.term:read` - a DIFFERENT permission from
//      `academic.gradebook:read`/`academic.section:read`. A section-scoped
//      Teacher (the gradebook's primary audience) does NOT hold it
//      (confirmed driving the API as teacher@greenwood.test: 403 FORBIDDEN),
//      so a teacher can see and grade every assignment in a grading period
//      but cannot resolve that period's NAME. Every call site here treats
//      that as non-fatal, gated behind `usePermissions().can('academic.term:read')`
//      exactly like the timetable page gates fetchRooms above - the
//      gradebook UI falls back to a label derived from data it CAN read
//      (the assignments' own due-date span) instead of blocking the page.

export type SectionEnrollmentStatus = 'active' | 'transferred' | 'withdrawn' | 'completed';

/** Mirrors `academic.section`. */
export interface Section {
  id: string;
  tenantId: string;
  courseId: string;
  termId: string;
  campusId: string;
  roomId: string | null;
  code: string;
  name: string;
  capacity: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One student's current enrollment in a section, enriched with the name fields callers actually need - what GET /academic/sections/:id/students returns. */
export interface SectionStudent {
  enrollmentId: string;
  personId: string;
  givenName: string;
  familyName: string;
  validFrom: string;
  validTo: string | null;
  status: SectionEnrollmentStatus;
}

/** Mirrors `academic.term`. */
export interface Term {
  id: string;
  tenantId: string;
  academicYearId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `academic.grading_period`. */
export interface GradingPeriod {
  id: string;
  tenantId: string;
  termId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/academic/sections/mine - sections the CALLER teaches, resolved server-side from their linked person; no id to pass or leak in the URL. */
export async function fetchMySections(signal?: AbortSignal): Promise<Section[]> {
  const response = await academicFetch('/sections/mine', { signal });
  await assertAcademicOk(response, `Could not load your sections (HTTP ${response.status}).`);
  return (await response.json()) as Section[];
}

/** GET /api/v1/academic/sections/:id */
export async function fetchSection(id: string, signal?: AbortSignal): Promise<Section> {
  const response = await academicFetch(`/sections/${encodeURIComponent(id)}`, { signal });
  await assertAcademicOk(response, `Could not load this section (HTTP ${response.status}).`);
  return (await response.json()) as Section;
}

/** GET /api/v1/academic/sections/:id/students - the section's current roster. */
export async function fetchSectionStudents(sectionId: string, signal?: AbortSignal): Promise<SectionStudent[]> {
  const response = await academicFetch(`/sections/${encodeURIComponent(sectionId)}/students`, { signal });
  await assertAcademicOk(response, `Could not load this section's students (HTTP ${response.status}).`);
  return (await response.json()) as SectionStudent[];
}

/** GET /api/v1/academic/terms - gated `academic.term:read`, see this section's own top comment. */
export async function fetchTerms(academicYearId?: string, signal?: AbortSignal): Promise<Term[]> {
  const search = academicYearId ? `?academicYearId=${encodeURIComponent(academicYearId)}` : '';
  const response = await academicFetch(`/terms${search}`, { signal });
  await assertAcademicOk(response, `Could not load terms (HTTP ${response.status}).`);
  return (await response.json()) as Term[];
}

/** GET /api/v1/academic/terms/:id/grading-periods - gated `academic.term:read`, see this section's own top comment. */
export async function fetchGradingPeriods(termId: string, signal?: AbortSignal): Promise<GradingPeriod[]> {
  const response = await academicFetch(`/terms/${encodeURIComponent(termId)}/grading-periods`, { signal });
  await assertAcademicOk(response, `Could not load grading periods (HTTP ${response.status}).`);
  return (await response.json()) as GradingPeriod[];
}

// ---------------------------------------------------------------------------
// Gradebook - categories, assignments, scores, computed grades
// ---------------------------------------------------------------------------
//
// Shapes mirror libs/domain/gradebook/src/domain/types.ts and contract.ts
// exactly - that module is off-limits to edit here, so this is read, not
// guessed. Two things confirmed driving the API live as
// teacher@greenwood.test:
//   1. POST .../scores takes a REAL JSON body (unlike the body-less POSTs
//      elsewhere in this file, e.g. dryRunImportJob) - Content-Type:
//      application/json is required, not omitted.
//   2. GET .../grading-periods/:id/lock returns bare `null` (not a 404, not
//      an object with `locked: false`) when the period has never been
//      locked - `null` means "not locked", not "unknown".

export type ScoreStatus = 'graded' | 'missing' | 'exempt' | 'late' | 'incomplete';
export const SCORE_STATUSES: readonly ScoreStatus[] = ['graded', 'missing', 'exempt', 'late', 'incomplete'];

/** Mirrors `gradebook.category` - structural, mutable, per-section. */
export interface GradeCategory {
  id: string;
  tenantId: string;
  sectionId: string;
  name: string;
  weight: number;
  dropLowest: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `gradebook.assignment`. */
export interface Assignment {
  id: string;
  tenantId: string;
  sectionId: string;
  categoryId: string;
  gradingPeriodId: string;
  title: string;
  description: string | null;
  pointsPossible: number;
  dueOn: string | null;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `gradebook.score` - the current state of one person's score on one assignment. */
export interface Score {
  id: string;
  tenantId: string;
  assignmentId: string;
  personId: string;
  points: number | null;
  status: ScoreStatus;
  gradeScaleVersionId: string | null;
  comment: string | null;
  gradedByUserId: string | null;
  gradedAt: string;
}

/** Mirrors `gradebook.submission` - the idempotency ledger row `enterScores` writes once per NEW (non-replayed) call. */
export interface ScoreSubmission {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  assignmentId: string;
  submittedByUserId: string | null;
  scoreCount: number;
  createdAt: string;
}

export interface EnterScoreInput {
  personId: string;
  points?: number | null;
  status: ScoreStatus;
  comment?: string | null;
}

export interface EnterScoresInput {
  /** Generate ONCE per save attempt, reuse for every retry of that same attempt - same idempotency contract as `MarkSessionInput.idempotencyKey`. */
  idempotencyKey: string;
  scores: EnterScoreInput[];
}

export interface EnterScoresResult {
  scores: Score[];
  submission: ScoreSubmission;
  /** `true` when `idempotencyKey` had already been submitted - `scores`/`submission` are the ORIGINAL result; nothing was written this call. */
  replayed: boolean;
}

/** One assignment's contribution to a category's percentage, as computed by the evaluator - what a teacher challenged on a grade needs to see. */
export interface AssignmentContribution {
  assignmentId: string;
  assignmentTitle: string;
  pointsEarned: number | null;
  pointsPossible: number;
  status: ScoreStatus;
  /** `true` when this assignment was excluded from the category total by drop-lowest-N. */
  dropped: boolean;
}

/** One category's contribution to the overall percentage. */
export interface CategoryBreakdown {
  categoryId: string;
  categoryName: string;
  /** The weight actually applied (0 when the calculation rule set has no matching category entry). */
  weight: number;
  earnedPoints: number;
  possiblePoints: number;
  /** `null` when this category had no gradeable (non-exempt) assignments in the period. */
  percentage: number | null;
  contributions: AssignmentContribution[];
}

/** One student's computed grade for a section/grading period. */
export interface StudentSectionGrade {
  personId: string;
  sectionId: string;
  gradingPeriodId: string;
  /** `null` when no category contributed anything (nothing graded yet). */
  percentage: number | null;
  letter: string | null;
  gpaPoints: number | null;
  gradeScaleVersionId: string | null;
  calculationRuleSetVersionId: string | null;
  breakdown: CategoryBreakdown[];
}

/** Mirrors `gradebook.grading_period_lock`. */
export interface GradingPeriodLock {
  id: string;
  tenantId: string;
  gradingPeriodId: string;
  locked: boolean;
  lockedByUserId: string | null;
  lockedAt: string | null;
  unlockedByUserId: string | null;
  unlockedAt: string | null;
}

async function gradebookFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}/api/v1/gradebook${path}`, {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }
}

async function assertGradebookOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) throw new ForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallbackMessage);
  }
}

/** GET /api/v1/gradebook/sections/:sectionId/categories */
export async function fetchSectionCategories(sectionId: string, signal?: AbortSignal): Promise<GradeCategory[]> {
  const response = await gradebookFetch(`/sections/${encodeURIComponent(sectionId)}/categories`, { signal });
  await assertGradebookOk(response, `Could not load grade categories (HTTP ${response.status}).`);
  return (await response.json()) as GradeCategory[];
}

/** GET /api/v1/gradebook/sections/:sectionId/assignments - `gradingPeriodId` omitted returns every assignment in the section, across every grading period. */
export async function fetchSectionAssignments(
  sectionId: string,
  gradingPeriodId?: string,
  signal?: AbortSignal,
): Promise<Assignment[]> {
  const search = gradingPeriodId ? `?gradingPeriodId=${encodeURIComponent(gradingPeriodId)}` : '';
  const response = await gradebookFetch(`/sections/${encodeURIComponent(sectionId)}/assignments${search}`, { signal });
  await assertGradebookOk(response, `Could not load assignments (HTTP ${response.status}).`);
  return (await response.json()) as Assignment[];
}

/** GET /api/v1/gradebook/assignments/:id/scores - the current score for every student who has one on this assignment (not one row per roster student - a student with no score yet has no row here). */
export async function fetchAssignmentScores(assignmentId: string, signal?: AbortSignal): Promise<Score[]> {
  const response = await gradebookFetch(`/assignments/${encodeURIComponent(assignmentId)}/scores`, { signal });
  await assertGradebookOk(response, `Could not load scores (HTTP ${response.status}).`);
  return (await response.json()) as Score[];
}

/** POST /api/v1/gradebook/assignments/:id/scores - the teacher's batched save for ONE assignment column. See `EnterScoresInput.idempotencyKey`'s own comment. Rejected outright (422, no partial write) when the assignment's grading period is locked. */
export async function enterScores(assignmentId: string, input: EnterScoresInput): Promise<EnterScoresResult> {
  const response = await gradebookFetch(`/assignments/${encodeURIComponent(assignmentId)}/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await assertGradebookOk(response, `Could not save these scores (HTTP ${response.status}).`);
  return (await response.json()) as EnterScoresResult;
}

/** GET /api/v1/gradebook/sections/:sectionId/grades - every enrolled student's computed percentage/letter/breakdown for `gradingPeriodId`. */
export async function fetchSectionGrades(
  sectionId: string,
  gradingPeriodId: string,
  signal?: AbortSignal,
): Promise<StudentSectionGrade[]> {
  const response = await gradebookFetch(
    `/sections/${encodeURIComponent(sectionId)}/grades?gradingPeriodId=${encodeURIComponent(gradingPeriodId)}`,
    { signal },
  );
  await assertGradebookOk(response, `Could not load grades (HTTP ${response.status}).`);
  return (await response.json()) as StudentSectionGrade[];
}

/** GET /api/v1/gradebook/students/:personId/grades - one entry per section the student is currently enrolled in that has assignments in `gradingPeriodId` (their whole report card for that period, not a single number). */
export async function fetchStudentGrades(
  personId: string,
  gradingPeriodId: string,
  signal?: AbortSignal,
): Promise<StudentSectionGrade[]> {
  const response = await gradebookFetch(
    `/students/${encodeURIComponent(personId)}/grades?gradingPeriodId=${encodeURIComponent(gradingPeriodId)}`,
    { signal },
  );
  await assertGradebookOk(response, `Could not load this student's grades (HTTP ${response.status}).`);
  return (await response.json()) as StudentSectionGrade[];
}

/** GET /api/v1/gradebook/grading-periods/:id/lock - `null` means never locked (see this section's own top comment), not "unknown". */
export async function fetchGradingPeriodLock(
  gradingPeriodId: string,
  signal?: AbortSignal,
): Promise<GradingPeriodLock | null> {
  const response = await gradebookFetch(`/grading-periods/${encodeURIComponent(gradingPeriodId)}/lock`, { signal });
  await assertGradebookOk(response, `Could not load the grading period lock status (HTTP ${response.status}).`);
  return (await response.json()) as GradingPeriodLock | null;
}
