/**
 * The permission catalogue - the source of truth for "which actions exist on
 * which resources" across the whole system. `access.permission` (see the
 * `0400` migration) is seeded FROM this list, never the other way round; a
 * test in `access.spec.ts` asserts the two never drift apart.
 *
 * `resource` names are dotted module.entity strings (`people.student`,
 * `academic.gradebook`) so the catalogue reads consistently once M2+ modules
 * add their own resources here. `people.*`, `academic.*`, `billing.*` and
 * `admissions.*` entries below are deliberately minimal placeholders - those
 * modules don't exist yet (M2+) - included only so this module's field
 * registry (`domain/field-registry.ts`), seed roles, and tests have
 * something concrete to grant/deny against. The modules that actually own
 * those resources should feel free to extend (never remove/rename - `key` is
 * a stable identifier other tenants' `access.role_permission` rows point at)
 * this list when they land.
 */
export interface PermissionDefinition {
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  // --- access: this module's own management surface -------------------------
  { resource: 'access.role', action: 'read', description: 'View roles and their permission grants.' },
  {
    resource: 'access.role',
    action: 'manage',
    description: 'Create/update roles and assign or revoke role assignments.',
  },
  {
    resource: 'access.impersonation',
    action: 'create',
    description: 'Start an impersonation session, acting as another user in this tenant.',
  },

  // --- people: the real M2 @sms/people module --------------------------------
  // people.person is the "one person, one record" resource: a student,
  // guardian, staff member or alumnus alike is gated by the SAME read/write
  // pair, since they are the same kind of row (see @sms/people's 0500
  // migration header). people.student.* below predates this module and
  // stays reserved for the medical/safeguarding alert split specifically -
  // see @sms/people's AlertService and this file's field registry.
  { resource: 'people.person', action: 'read', description: "View a person's core profile - student, guardian, staff or alumnus alike." },
  { resource: 'people.person', action: 'write', description: "Create or edit a person's core profile, roles, households, relationships and identifiers." },
  { resource: 'people.person', action: 'merge', description: 'Merge two duplicate person records into one surviving record.' },

  // --- people.student / people.staff: placeholders ahead of the M2 people
  // module when this file was first written. people.student:read/write and
  // people.staff:read are now superseded by people.person:read/write above
  // and kept only because `key` is a stable identifier (never removed/
  // renamed - see this file's own header comment); read_medical/
  // read_safeguarding remain load-bearing - see the field registry.
  { resource: 'people.student', action: 'read', description: "View a student's core profile." },
  { resource: 'people.student', action: 'write', description: "Edit a student's core profile." },
  {
    resource: 'people.student',
    action: 'read_medical',
    description: "View a person's medical alerts - a separate permission, not a field mask exception.",
  },
  {
    resource: 'people.student',
    action: 'read_safeguarding',
    description: "View a person's safeguarding alerts - a separate permission, not a field mask exception.",
  },
  { resource: 'people.staff', action: 'read', description: "View a staff member's core profile." },

  // --- academic: placeholder resource ahead of the M2 academic module -------
  { resource: 'academic.gradebook', action: 'read', description: 'View grades.' },
  { resource: 'academic.gradebook', action: 'write', description: 'Enter or change grades.' },

  // --- academic: the real M2 @sms/academic module ----------------------------
  // Academic structure (terms, grade levels, departments, subjects, courses,
  // rooms) is reference data managed by administrative staff; sections and
  // their teacher/student rosters are the operational records teachers also
  // need read access to (scoped `section`, resolved by @sms/academic's
  // SECTION_SCOPE_RESOLVER implementation - see application/ability.service.ts).
  { resource: 'academic.term', action: 'read', description: 'View terms.' },
  { resource: 'academic.term', action: 'write', description: 'Create or edit terms and grading periods.' },
  { resource: 'academic.grade_level', action: 'read', description: 'View grade levels.' },
  { resource: 'academic.grade_level', action: 'write', description: 'Create or edit grade levels.' },
  { resource: 'academic.department', action: 'read', description: 'View departments.' },
  { resource: 'academic.department', action: 'write', description: 'Create or edit departments.' },
  { resource: 'academic.subject', action: 'read', description: 'View subjects.' },
  { resource: 'academic.subject', action: 'write', description: 'Create or edit subjects.' },
  { resource: 'academic.course', action: 'read', description: 'View courses.' },
  { resource: 'academic.course', action: 'write', description: 'Create or edit courses.' },
  { resource: 'academic.room', action: 'read', description: 'View rooms.' },
  { resource: 'academic.room', action: 'write', description: 'Create or edit rooms.' },
  { resource: 'academic.section', action: 'read', description: 'View sections.' },
  { resource: 'academic.section', action: 'write', description: 'Create or edit sections.' },
  {
    resource: 'academic.section_roster',
    action: 'manage',
    description: 'Assign/end section teachers and enrol/transfer/withdraw students.',
  },
  {
    resource: 'academic.timetable',
    action: 'read',
    description: 'View bell schedules, periods, section meetings, timetables, teacher workload and schedule conflicts.',
  },
  {
    resource: 'academic.timetable',
    action: 'write',
    description: 'Manage bell schedules and periods, set section meetings, and assign substitutes.',
  },

  // --- enrollment: the real @sms/enrollment module ---------------------------
  // School enrolment - which campus, grade level and academic year a person
  // belongs to - is distinct from academic.section_roster above (which CLASS
  // a student sits in). Registrar/School Administrator manage it tenant-wide;
  // Teacher deliberately gets neither grant.
  { resource: 'enrollment.enrollment', action: 'read', description: 'View school enrolments - which campus, grade level and academic year a person belongs to, and their status history.' },
  { resource: 'enrollment.enrollment', action: 'write', description: 'Enrol students, transition enrolment status, and transfer a student to another campus.' },
  {
    resource: 'enrollment.rollover',
    action: 'run',
    description: 'Roll enrolled students over into the next academic year, promoting each to the next grade level.',
  },

  // --- attendance: the real @sms/attendance module ----------------------------
  // The screen teachers touch every single day. record:read/write cover the
  // roster/marking/summary/unmarked-sessions surface (scoped `section` for
  // Teacher, resolved by the same SECTION_SCOPE_RESOLVER `academic.section`
  // above uses); correction:approve is deliberately its OWN permission, never
  // granted to Teacher - a teacher must not approve their own correction.
  // code:manage covers the tenant-owned attendance code catalogue (config,
  // not a per-record scoped resource - see @sms/attendance's 0900 migration
  // header).
  { resource: 'attendance.record', action: 'read', description: 'View attendance records - session rosters, marks, summaries and the unmarked-sessions report.' },
  { resource: 'attendance.record', action: 'write', description: 'Mark attendance for a session and request corrections to a locked record.' },
  { resource: 'attendance.correction', action: 'approve', description: 'Approve or reject a requested attendance correction - the only way to change a record locked past the free-edit window.' },
  { resource: 'attendance.code', action: 'manage', description: 'Create, edit or deactivate attendance codes (the tenant-owned code catalogue).' },

  // --- gradebook: the real @sms/gradebook module ------------------------------
  // academic.gradebook:read/write (above, pre-existing) cover the day-to-day
  // surface a Teacher needs - categories, assignments, scores, computed
  // grades - scoped `section`, resolved by the same SECTION_SCOPE_RESOLVER
  // attendance/academic.section use. gradebook.scale:manage and
  // gradebook.grade:approve are deliberately their OWN permissions, never
  // granted to Teacher: a teacher must not redefine the school's grade scale
  // or weighting policy, and must not approve their own correction - same
  // posture as attendance.code:manage / attendance.correction:approve.
  {
    resource: 'gradebook.scale',
    action: 'manage',
    description: 'Create/publish grade scales and calculation rule sets, and manage the learning-outcome catalogue.',
  },
  {
    resource: 'gradebook.grade',
    action: 'approve',
    description: 'Approve or reject a requested grade correction, and lock/unlock a grading period - the only way to change a score once its grading period is locked.',
  },

  // --- documents: issued artefacts (report cards, transcripts, certificates) ---
  // Generating is separated from reading on purpose: issuing a document is a
  // write that produces something a school hands to a parent, and it is
  // expensive (a Chromium render per document). Plenty of roles should be able
  // to read a previously issued report card without being able to reissue one.
  {
    resource: 'documents.document',
    action: 'read',
    description: 'View and download documents already issued for a person.',
  },
  {
    resource: 'documents.document',
    action: 'generate',
    description: 'Issue or reissue a document from a published template - creates a new immutable artefact.',
  },
  {
    resource: 'documents.template',
    action: 'manage',
    description: 'Publish new versions of a document template (report card layout, transcript, certificate).',
  },

  // --- records: the real @sms/records module -----------------------------
  // The permanent academic record - append-only transcript entries, GPA and
  // versioned credit/promotion rules. Deliberately separate from
  // documents.document:read/generate above: a report card is an issued
  // ARTEFACT (a document), while a transcript is the underlying append-only
  // RECORD it is drawn from - a school may want staff to read one without
  // the other. finalise is its own permission, never granted to Teacher
  // (same posture as gradebook.grade:approve/attendance.correction:approve):
  // a teacher must not be the one who closes the book on a term's grades.
  { resource: 'records.transcript', action: 'read', description: 'View transcript entries, cumulative GPA and credits, and promotion eligibility.' },
  {
    resource: 'records.transcript',
    action: 'finalise',
    description: "Finalise a term's transcript entries from computed grades (permanent, append-only) and manage credit/promotion rule sets.",
  },

  // --- notifications: the real @sms/notifications module ---------------------
  // Closes the loop the transactional outbox (@sms/outbox) was built for:
  // attendance.marked_absent becoming a real message to a guardian.
  // template:manage covers the tenant-owned template catalogue (read + publish
  // together, same posture as attendance.code:manage); delivery:read is
  // separate so a role can audit "did that parent actually get told?" without
  // being able to touch template copy. preference:manage is granted 'tenant'
  // to School Administrator/Registrar (manage anyone's preferences) and 'own'
  // to Parent/Guardian and Student (manage only their own - see
  // NotificationsController.assertCanManagePreferences for how 'own' is
  // enforced past this coarse grant).
  { resource: 'notifications.template', action: 'manage', description: 'View and publish notification template versions (email/SMS/push copy) for each channel.' },
  { resource: 'notifications.delivery', action: 'read', description: 'View delivery status (queued/sent/delivered/failed/suppressed) and the reason for any suppression.' },
  { resource: 'notifications.preference', action: 'manage', description: "View or change a person's per-channel, per-category notification preferences." },

  // --- billing (M7) -----------------------------------------------------------
  // Deliberately split by DUTY, not by table. Deciding what a family owes,
  // taking their money, and reversing a charge are three different jobs, and in
  // a real school they are done by different people - a bursar who can both
  // invent a charge and mark it paid can hide the difference. `invoice:read`
  // and `invoice:write` keep their original keys (a key is never renamed - see
  // this file's header); the finer-grained actions are additions.
  { resource: 'billing.invoice', action: 'read', description: 'View invoices, payments and outstanding balances.' },
  { resource: 'billing.invoice', action: 'write', description: 'Draft and issue invoices.' },
  { resource: 'billing.fee_schedule', action: 'manage', description: 'Define what things cost - fee schedules and their published versions.' },
  { resource: 'billing.payment', action: 'record', description: 'Record a payment received against an invoice.' },
  { resource: 'billing.credit_note', action: 'issue', description: 'Reverse or reduce an issued invoice by raising a credit note.' },

  // --- admissions (M7) --------------------------------------------------------
  // `decide` is separate from `write` for the same reason: recording an
  // applicant's details is clerical, and making an offer is not.
  { resource: 'admissions.application', action: 'read', description: 'View admissions applications and their decision history.' },
  { resource: 'admissions.application', action: 'write', description: 'Create and update applications, and move them through the pipeline.' },
  { resource: 'admissions.application', action: 'decide', description: 'Record an admissions decision - offer, rejection or withdrawal.' },

  // --- public API (M8) --------------------------------------------------------
  // Minting a key that can act on the tenant's data is strictly more dangerous
  // than any single thing the key can do, so it is its own permission rather
  // than being folded into an admin catch-all.
  { resource: 'api.key', action: 'read', description: 'List API keys and their scopes, last use and revocation status - never the secret itself.' },
  { resource: 'api.key', action: 'manage', description: 'Mint and revoke API keys for machine access to this tenant.' },

  // --- approvals (M8) ---------------------------------------------------------
  // There is deliberately NO generic "approve anything" permission: what may
  // approve a request is named by that request type's own policy (e.g. an
  // attendance correction still requires `attendance.correction:approve`).
  // A blanket approver permission would quietly become the one grant that
  // bypasses every other control in the system.
  { resource: 'approvals.policy', action: 'manage', description: 'Configure which permission approves a request type, and how many approvals it needs.' },
  { resource: 'approvals.request', action: 'read', description: 'View approval requests, their policy and their decision history.' },
];

export function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/** Every catalogue entry, with its derived `key` - what the `0400` seed inserts and `AbilityService` rules key off. */
export const PERMISSION_CATALOGUE: ReadonlyArray<PermissionDefinition & { readonly key: string }> =
  PERMISSION_DEFINITIONS.map((def) => ({ ...def, key: permissionKey(def.resource, def.action) }));

/** `true` iff `key` names a permission that actually exists in the catalogue - used to validate the field registry. */
export function isKnownPermission(key: string): boolean {
  return PERMISSION_CATALOGUE.some((permission) => permission.key === key);
}
