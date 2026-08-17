# Decision log

Non-obvious calls made while building, and what breaks if they're undone. Each
one exists because something went wrong or nearly did — they are not
preferences. If you're about to change one, read the entry first.

Architecture and roadmap: [phase-1-architecture.html](phase-1-architecture.html).

---

## Database

### `SET LOCAL`, never plain `SET`

`withTenantTx` sets the RLS session variables with `set_config(name, value, true)`
— the third argument makes it transaction-scoped.

Plain `SET` is *session*-scoped, and sessions are pooled connections reused
across requests. One tenant's `app.tenant_id` would still be set when the
connection is handed to the next tenant's request, and every RLS policy would
silently return the wrong school's rows.

`libs/shared/db/src/tx.spec.ts` guards this by forcing the pool to a single
connection and asserting the value is gone after commit. Do not "simplify" that
test — a single-connection pool is the only way it reproduces.

### Three transaction helpers, three different privilege levels

| helper | connects as | sees |
| --- | --- | --- |
| `withTenantTx` | `sms_app` | one tenant's rows, via RLS |
| `withAuthTx` | `sms_app` | only the caller's own membership rows |
| `withSystemTx` | `sms_owner` | **everything — bypasses all RLS** |

`withSystemTx` connects as the table owner, and Postgres exempts table owners
from row-level security. It is for migrations and system jobs. Reaching for it
in request-handling code silently removes tenant isolation from that path.

`withAuthTx` exists because authentication has a bootstrapping problem: resolving
which tenants a user belongs to happens before any tenant is known. It runs as
the ordinary app role with only `app.user_id` set, matched by the
`membership_self_read` policy (migration `0302`).

### `MembershipService.listForUserDuringAuthentication` is the one exception

It uses `withSystemTx` deliberately. Better Auth's `session.create.before` hook
runs while Better Auth's own write is in flight on the pooled client, and opening
a nested transaction there **deadlocks** — sign-in hangs until it times out, with
no error anywhere.

Bounded on purpose: once per sign-in, not per request. `AuthGuard` uses
`getForUserAndTenant`, which is tenant-scoped.

### Migrations live in the module that owns them

`libs/<layer>/<module>/migrations/*.sql`, discovered by glob, ordered by a
globally-unique numeric prefix with a reserved range per module:

```
0000–0099  shared/db bootstrap
0100–0199  platform/audit      (first: later modules attach its trigger)
0200–0299  platform/tenancy
0300–0399  platform/identity
0400–0449  platform/access
0450–0499  platform/custom-fields
0500–0599  domain/people
0600–0699  domain/academic
0700–0799  domain/enrollment
0800–0849  platform/import-export
0850–0899  platform/outbox
0900–0999  domain/attendance
1000+      allocated as modules are built
```

The runner refuses to start if two modules claim the same filename.

**Test specs must read their module's migrations folder, not name files.** A
hardcoded list stops applying anything added later, so a new migration becomes
invisible to the tests that exist to exercise it. This was fixed three times
before the lesson stuck.

### The outbox publishes on the CALLER's transaction

`OutboxContract.publish(tx, …)` takes the transaction as a required argument.
That is the entire design, not an ergonomic detail.

If it opened its own transaction you get one of two failures back: the event
commits while the fact rolls back (a parent notified about an absence that never
happened), or the fact commits while the event is lost (a notification silently
owed forever). Only writing the event to the same database in the same
transaction avoids both. Publishing to a message bus after commit avoids
neither.

`sms_app` has INSERT/SELECT but **not** UPDATE on `outbox.message`: marking a
message published is the dispatcher's job, and an application that can mark its
own events published can silently drop them.

Delivery is at-least-once by design. Subscribers must be idempotent; the
alternative — marking published before handling — drops events instead.

### Conflict detection belongs in the database

A teacher cannot be in two rooms at once and a room cannot hold two sections at
once. Those are exclusion constraints and triggers on `academic.section_meeting`,
not service-layer checks.

A service check is skipped by the first bulk import, admin script or concurrent
request that does not go through it, and the resulting double-booking is found
by a teacher on a Tuesday morning. Application checks may exist for better error
messages; they are not the enforcement.

(Room over-capacity is the deliberate exception — it *warns*. Over-capacity is
common and legitimate in real schools, and hard-failing on a frequently-stale
number blocks real scheduling decisions.)

### Every audited table needs an `id` column

`audit.record_history()` derives `record_id` from it generically and raises
otherwise. This is why `access.role_permission` has a surrogate key instead of
the natural `(role_id, permission_id)` composite.

---

## Security

### `pnpm check:db` is the enforcement mechanism

It interrogates the Postgres catalog directly, so it cannot be satisfied by a
convention nobody follows:

1. every module table has `tenant_id`, RLS **enabled**, and at least one policy
2. every table carries the audit history trigger
3. `sms_app` is not superuser and lacks `BYPASSRLS`
4. `sms_app` owns no tables — owners bypass RLS regardless of policy

Opting out is explicit: a table COMMENT containing `@global` or `@no-audit`.
When it fails, fix the schema. Never weaken the check.

### A safety check must discover, never rely on a list

`check:db` originally held a hardcoded list of schema names. Three modules —
`custom_fields`, `import_export`, `outbox` — were added later and none was ever
checked. They could have shipped tables with no RLS and no audit trigger while
the script reported "all architecture checks passed".

That is the worst failure a safety check can have, because its green result is
what everyone trusts *instead of* looking. It now checks every schema except
explicit Postgres internals, so a new module is covered the moment it exists and
forgetting to register one is impossible.

Applies generally: any check enumerating what to inspect will silently stop
inspecting things. Enumerate what to *skip*.

### Seed data is computed relative to today, never hardcoded

The seed used to create academic year 2025-2026 ending 2026-06-30. Once the
clock passed that date the "current" year was already over, no term contained
today, and every screen keyed to *now* — this week's timetable, today's
register, current teacher workload — was empty for reasons unrelated to the
code. Two separate agents wasted time diagnosing symptoms of it.

The demo year now straddles today by construction, and terms are cut from the
year. Real school years do have a summer gap; demo data that reproduces the gap
on the day someone evaluates the product is not realism, it is an empty screen.

### A GRANT without a matching policy is a silent denial

Under RLS, a command with no applicable permissive policy is denied outright,
whatever the GRANTs say. `audit.access_log` had `GRANT INSERT` and only a
`FOR SELECT` policy, so every read-access log write failed in production with
`42501`. The two halves of "who may do this" have to agree.

### Unresolvable permission scopes deny, never widen

Scope is `own | section | grade_level | campus | tenant`. A scope that cannot be
resolved emits **no rule** — it never falls through to something broader.

For a whole milestone the seeded Teacher role granted *nothing*, because
`section` had no resolver until `@sms/academic` landed. That was the correct
interim state, and the temptation throughout was to "fix" it by widening the
grants to `campus` — which would have made the role appear to work while letting
any teacher edit any student's grades campus-wide. Because it works, nothing
would ever have prompted anyone to narrow it again.

`section` now resolves (via the `SECTION_SCOPE_RESOLVER` port `@sms/academic`
implements) and the role does exactly what it always claimed. `grade_level` is
still unresolvable and still grants nothing.

**The default binding for that port returns `[]`.** If the implementation is
ever unregistered, section-scoped grants collapse to nothing rather than
silently widening. Keep it that way.

### A list endpoint cannot be secured by a per-row check it never performs

`@RequirePermission('academic.section:read')` answers one question: may this user
read sections *at all*. A LIST request names no particular section, so the guard
has nothing to test a `section`-scoped grant against — and `GET /academic/sections`
returned all 12 of the school's sections to a teacher who teaches three.

Every read endpoint must apply `AccessContract.resolveScopeConstraints` itself:
the **list**, and the **single-record read** too (otherwise a scoped caller just
fetches by id instead). `sections.controller.ts` is the reference implementation.

That is the whole reason `resolveScopeConstraints` exists alongside CASL: CASL is
the decision layer, the constraint set is the data-filtering layer, and a list
endpoint needs both.

### Sensitive fields are separate permissions, not a mask list

`people.student:read` vs `read_medical` vs `read_safeguarding`, enforced by a
field registry and a serialisation interceptor.

A deny-list was rejected: every newly added medical column would be visible to
everyone until someone remembered to mask it. The failure mode is silent
over-exposure, and you find out from a parent rather than a test.

### `actorUserId`, `userId` and `personId` are three different facts

| field | meaning |
| --- | --- |
| `actorUserId` | the real signed-in human — never the impersonation target; audit records this |
| `userId` | the effective user, which impersonation legitimately changes |
| `personId` | the `people.person` record — a person may have no login at all |

`audit.record_history.changed_by_user_id` is stamped from `app.actor_user_id`.
Attributing an impersonated write to the target would launder the very action
the audit trail exists to record. Collapsing any two of these re-introduces a
bug that has already been fixed once.

### Reverting an import archives, it does not delete

`people.person` grants `sms_app` no DELETE on purpose — a person id lives on in
URLs, exports and external integrations. Correct for a merge; but it also meant
a bulk import that created 1,200 people could not be undone at all, because
`revert()` undoes a CREATE by deleting.

So `revert` sets `archived_at` for tables listed in `ARCHIVABLE_TABLES`
(`pipeline.service.ts`) and deletes only for those that aren't. The row survives
so its id still resolves; every read path excludes it, which is what "undo my
import" means to the person asking.

A table added to that set must have `archived_at` + `archived_reason` AND filter
them out of its reads — see `PersonService.searchPeople`. Adding one without the
filter silently un-deletes data.

### A grade resolves against the scale version its scores were entered under

Not against today's scale. Schools change their grade boundaries mid-year, and a
transcript that re-grades itself when they do is a legal problem, not a display
bug. Every `gradebook.score` is stamped with `grade_scale_version_id` at entry;
`calculateSectionGrades` resolves the letter through that stamp, and GPA is
computed from the stored `gpa_points`, never re-resolved.

Two bugs lived here, both worth knowing about:

1. The stamp was written and then **ignored** — the calculation resolved the
   current default version. Publishing a stricter scale silently turned an
   existing 82.2% B into a C.
2. When a student's scores straddle a republish, the **earliest** stamp wins,
   not the newest. Newest-wins means one late-entered make-up mark re-grades
   every other score in the period. A grading period is graded under the scale
   in force when its grading began; late entries join the period rather than
   redefining it.

### Test the dish, not the ingredients

The gradebook's own headline test asserted that the score row kept its
`grade_scale_version_id`, then recomputed the letter by calling `resolveLetter`
with the old bands directly. Both assertions were true for the entire time the
system was re-grading, because the test never called `calculateSectionGrades` —
the path a report card actually uses.

When a property matters, assert it through the production entry point. A test
that verifies the inputs exist and the pure helper works can pass while the
thing they are for is broken.

The same bug was ultimately caught by reading a letter grade in a screenshot
that did not match the scale. Both fixes to this area needed a second look.

### A preview computed by different logic than the commit is a preview that lies

Both the enrollment rollover and the CSV import run their dry run through the
*same* write path as the commit, and force a `ROLLBACK`. The rollover throws a
sentinel error carrying the computed plan; the pipeline discards the transaction.

This is deliberately not "compute an estimate separately" — a preview that does
not execute real constraints, foreign keys and unique indexes will disagree with
the commit exactly when it matters, and the school finds out after importing
their whole student body.

### An authorization cache keyed per user cannot express a role change

`AbilityCache` is keyed `(tenantId, userId)`. Changing a ROLE's permissions
changes what every holder of that role can do, and there is no per-user key to
clear — so `grantPermission` had no effect until the process restarted. An admin
could revoke access, be told it worked, and the permission would keep working.

`invalidateTenant` is the (deliberately coarse) answer. Role definitions change
rarely and always by admin action; an authorization cache that serves revoked
permissions is never acceptable.

### Impersonation requires a stated reason and is ended by the actor

`endImpersonation` must key on `actorUserId`. Using the effective `userId`
matched the target against `actor_user_id`, hit zero rows, and made impersonation
a one-way door — hidden because the endpoint reported success for a write that
never happened. Report what happened, not what was requested.

### A dedupe key must guard a write that is already atomic

`notify()` inserts a `notifications.notification` row with `on conflict do
nothing`, and a conflict means "the outbox redelivered this; do not send twice".
That is only true if the delivery rows are written **in the same transaction**.

They were not. The notification row committed on its own, then recipients were
resolved and delivery rows inserted separately, then SMTP was called. A crash
anywhere in that window left a committed notification row and no deliveries — so
the redelivery hit the dedupe key, returned `deduped: true` with zero deliveries,
and the guardian was never told their child was absent. The system reported
success. **An idempotency guard over a non-atomic write does not prevent
duplicates, it converts crashes into silent permanent drops.**

Now: recipients resolve first (a read, outside any transaction — the resolver
reaches `@sms/people` through an inverted port and opens its own transactions;
nesting those is what deadlocked `withAuthTx` inside Better Auth's session hook),
then the notification and every delivery row are written in one transaction, then
sending happens after commit. Delivery rows land as `queued`, and the dedupe path
**re-dispatches anything still `queued`** rather than assuming it went out — that
retry is what makes the window recoverable rather than permanent. Rows already
`sent` are left alone, so redelivery still never sends a second email.

### A `@Global()` registry override can close a cycle Nest cannot report

`NOTIFICATION_CHANNEL_REGISTRY` and `SECTION_SCOPE_RESOLVER` use one shape: the
platform module binds nothing, and a `@Global()` module in `apps/api` supplies
the real implementation. That works because nothing the override depends on
depends back on the platform module.

Approvals broke it. `CreditNoteApprovalHandlerModule` imports `BillingModule`
(for the handler); `BillingModule` imports `ApprovalsModule` (to raise the
request); `ApprovalsService` needs the handler registry that first module
supplies. A cycle — but the closing edge is a `@Global()` token rather than an
`imports` entry, so **Nest does not detect it and reports nothing**.
`NestFactory.create` simply never returns, and because `bufferLogs: true` holds
every log until the app is ready, **not one line is ever printed**. The symptom
is a process that appears to start, writes zero bytes even to a file, and never
listens. Three agents sat waiting on a health check that could never pass.

Fix: `ApprovalsModule` owns an **empty, mutable** registry and exports it;
handlers push themselves in at `onModuleInit`. The graph becomes one-way
(handler → {approvals, billing}, billing → approvals). Fail-closed behaviour is
unchanged: an unregistered request type still resolves to `undefined` and
`decide` refuses it.

**Diagnosing this class of hang:** bisect with a probe that (1) imports the
module graph, (2) calls `Test.createTestingModule().compile()`, (3) calls
`init()`. Whichever step never returns tells you whether it is import, DI
construction, or a lifecycle hook — the logs will not.

### Nobody may approve their own request, enforced in the database

Before the approvals engine, "a teacher must not approve their own attendance
correction" was enforced only by *not granting* `attendance.correction:approve`
to Teacher. An administrator who also teaches could therefore approve their own
correction, and nothing anywhere would stop them. The engine enforces
`decided_by_user_id <> requested_by_user_id` as a database rule, so it holds
regardless of which roles a person happens to hold.

There is deliberately **no generic "approve" permission**. Whether a caller may
approve a request is decided by the permission its own policy names. A blanket
approver permission would become the single grant that bypasses every other
control in the system.

### API keys: hashed at rest, and never wider than their creator

A database dump must not yield working credentials, so only an HMAC of the
secret is stored, alongside a non-secret prefix for identification in logs and
UI. The plaintext is shown once.

A key's permissions must be a subset of what its creator holds — checked at mint
time **and again on every request** against the creator's live ability. Checking
only at mint time would freeze a permission into the key that its owner has since
lost, which is how a revoked privilege quietly keeps working.

Key auth slots into the existing guard pipeline rather than running beside it: it
populates the same `request.identity` a cookie session would, and
`PermissionGuard`, the tenant-context interceptor and field masking all run
unchanged. A second, weaker auth path is how these systems get breached. The
guard ordering is load-bearing and commented as such; note that `request.identity`
is a server-side property, not a header, so a client cannot forge it.

### Money is integer minor units, and there is no balance column

Every monetary value is `amount_minor bigint` plus an ISO-4217 currency. No
`float`, no `numeric` cents, in SQL or TypeScript or tests. Display formats from
the integer with integer arithmetic — a cent lost to `parseFloat` is a support
ticket nobody can reproduce.

And nothing stores a balance. What a family owes is derived: charges − allocated
payments − credits. A stored balance is wrong the first time any write path
forgets to update it, and from then on the system reports a false number with
complete confidence. Deriving it cannot drift.

### An issued invoice is corrected by a credit note, never an UPDATE

Enforced by a trigger that refuses the write even to `sms_owner`, not by a
service-layer check. Someone must always be able to answer "what exactly were
they billed, and what changed since" — an amount that was silently edited cannot
answer it. The trigger's error message names the credit note, so the caller is
told what to do instead of just being refused.

Same rule, same enforcement, for `admissions.application_decision` and
`application_stage_history`: an admissions decision gets challenged by parents
months later, and an overwritten status column cannot defend itself. A reversal
appends a new row.

### An aggregate endpoint leaks differently from a list

`GET /billing/summary` had to narrow by the caller's scope constraint exactly as
`listInvoices` does. It is easy to remember scoping when returning rows and to
forget it when returning a single number — but that number is the whole school's
debt, handed to any parent who asks. Aggregate in SQL with the constraint in the
`WHERE` clause; never total up rows you fetched unfiltered.

Verified by computing the same totals independently in raw SQL and comparing:
tenant 897500, one guardian's children 222500. Do that rather than trusting the
endpoint to agree with itself.

### Split money permissions by duty, not by table

`billing.fee_schedule:manage` (what things cost), `billing.payment:record`
(taking money) and `billing.credit_note:issue` (reversing a charge) are separate
permissions because in a real school they are separate jobs. Someone who can both
invent a charge and mark it paid can hide the difference between them.
`admissions.application:decide` is split from `:write` for the same reason:
recording an applicant's details is clerical, making an offer is not.

### An applicant is not yet a person

No `people.person` row is created for an enquiry. The application carries the
applicant's own details plus an optional `person_id` for families already known
(a sibling, a re-application); a person is created only on acceptance. Otherwise
every enquiry that never enrols is permanently in the student directory, and
removing them later is far harder than never adding them.

Conversion to an enrolment claims `converted_at` with a single
`UPDATE … WHERE converted_at IS NULL RETURNING *`, so a double-clicked accept
cannot produce two enrolments. Note the residual, documented rather than hidden:
the person and enrolment are created through other modules' contracts, which
cannot join one literal database transaction.

### A guardian's right to see a record is not consent to be emailed

`people.relationship.may_receive_comms` governs whether someone is sent
broadcast communications. It says nothing about whether a parent may see their
child's grades. The `dependants` scope resolver and `GET /people/me/dependants`
both deliberately ignore it — filtering on it would hide a child from their own
parent because of a mailing preference, a denial nobody would think to look for.

### `documents.document:read` must not be wired up until that controller has scope narrowing

`DocumentsController` is gated on `people.person:read`/`:write` rather than its
own `documents.document:*` pair, and the obvious cleanup is to swap them. **Do
not**, not as a one-line change: only tenant-scoped roles have ever reached that
controller, so it contains no scope-constraint logic whatsoever. Parent, student
and teacher all hold `documents.document:read`, so swapping the gate would let a
guardian call `GET /documents` and `GET /documents/:id/download-url` for *any*
student in the tenant. The swap has to land together with per-record narrowing of
the kind `RecordsController.assertReportCardAccess` already does. Report cards
reach parents through the records endpoints, which are narrowed, so nothing is
blocked on this.

### Landing routes are chosen by capability, never by role name

Roles are tenant-configurable rows: a school can rename "Parent/Guardian" or
invent one. `/` sends a user to `/portal` unless they hold a permission at
`tenant`, `campus` or `section` scope — the scopes that only ever mean "acting on
other people's records". A permissions-fetch failure falls closed to the portal,
the least-privileged destination. Someone who is both staff and a parent lands on
the dashboard and reaches the portal by an explicit link, rather than one of the
two being unreachable.

### Never render a fabricated figure

The first dashboard hardcoded an enrolment of 1,284, a 96.4% attendance rate,
"$48,210" of balances and three students who existed nowhere in the data. It read
as real. A page with fewer tiles is strictly better than one whose numbers cannot
be trusted, because a viewer cannot tell which are which. Where no endpoint can
source a figure, the tile is omitted and recorded as unsourced — the three above
are gone, not replaced with different guesses. The same rule killed "their fees"
from the portal header: billing has a permission catalogue entry but no
controller, so promising it advertises a feature that does not exist.

Corollary for empty states: a bare `0` that might mean "failed to load" is a bug.
"No sessions scheduled today — sections meet Monday, Wednesday and Friday" is an
answer.

### Seed enrolments are per term, or the timetable rots

Students were round-robined across all 12 sections at once. Nine of those belong
to Term 1, whose meetings stop at that term's end — so once "today" moved into
Term 2, only 3 of 16 students still had a section that meets. The other 13 were
"currently enrolled" with an empty timetable, which reads as a broken feature
rather than as stale seed data, and left both portals showing nothing. Every
student is now enrolled once per term, which is both what a real record looks
like and drift-proof. Same family as the M4 date-rot fixes.

### A demo login's display name comes from the person it links to

`seed-demo-logins.ts` chooses each account's person; the name in `DEMO_LOGINS` is
only a seed for accounts that link to nobody. Leaving the hardcoded name in place
after a re-link made the app greet "Michael" above Rosa's children — which reads
as a data-integrity bug in exactly the screen meant to demonstrate correctness.

### Announcement audiences and demo-login person links are both frozen facts

An announcement's audience is resolved once, at publish time, into
`announcement_recipient` rows. "All Grade 9 parents" must mean whoever was in
Grade 9 *when it was sent*; re-resolving later silently rewrites who was told.
Same family as a grade resolving against a newer scale version.

The mirror-image bug is a link that *should* keep up and does not.
`seed-demo-logins.ts` picks each demo account a person who makes its scope
mean something, but it only did so when creating the membership — so
`parent@greenwood.test` stayed bound to a guardian whose relationships were all
`may_receive_comms = false`, seeing an empty portal that looks exactly like a
permissions bug. The criteria now live in one `pickPredicate` used both to
choose a person and to re-check an existing link, and a link that no longer
qualifies is re-pointed. Deriving both from one predicate is the point: if they
could drift, a login could keep a link the rules no longer allow.

### `db:seed` order is not module order

`@sms/communications`' seed runs **after** `seed-demo-logins.ts`, not in
migration order, because it needs `parent@greenwood.test`'s person link to exist
before it can build a thread for that parent. Re-sorting the chain into tidy
module order silently strips the demo parent of their content.

---

## HTTP

### CORS: `@fastify/cors` defaults `methods` to GET, HEAD, POST

Without an explicit `methods` list, **every DELETE, PUT and PATCH from a browser
fails its preflight**, across the whole API. curl does not enforce CORS, so this
passes every command-line check and only appears once an update or delete is
wired into the UI.

### CORS: `reply.hijack()` skips every Fastify response hook

The Better Auth handler writes to the raw socket, which also bypasses the
`onSend` hook `@fastify/cors` uses to attach `Access-Control-Allow-Origin`. Those
routes set the headers by hand and answer OPTIONS themselves. Nest controllers
are unaffected, so the gap looks like "sign-in is broken but everything else
works".

**Both CORS bugs were invisible to curl and only found by driving a real
browser.** Verify UI-facing changes in a browser.

### Required query parameters need a schema, or a bad request becomes a 500

`@Query('date') date: string` types the parameter as present without checking
it is. Omitting `date` on `/attendance/unmarked-sessions` reached
`isoDayOfWeek(undefined)` and returned `INTERNAL_ERROR` — telling the caller our
service broke when in fact their request was malformed. Bodies were already
validated with `ZodValidationPipe`; the two attendance endpoints with genuinely
required parameters now are too.

**Still outstanding:** query parameters are unvalidated across the rest of the
API (gradebook's `gradingPeriodId`, records', documents'). Same latent 500 in
each. Left for the M8 hardening pass rather than swept in mid-milestone — noted
here so it is a known debt, not a discovery.

---

## Tooling

### `nodeLinker: hoisted`

pnpm's default isolated linker hashes each package directory by its resolved peer
context, so `apps/api` and `libs/platform/*` ended up with physically different
copies of `@nestjs/common` and `@nestjs/core` despite identical versions.
Anything relying on class identity across that boundary breaks: `instanceof
HttpException` failed (turning 400s into 500s) and injecting `Reflector` failed
at boot.

This is an application monorepo, not a published library, so the
phantom-dependency risk isolated mode guards against does not outweigh silently
broken `instanceof`.

### TypeScript is pinned to 6.0.x

`typescript-eslint` declares `typescript >=4.8.4 <6.1.0`. TS 7 is released, but
adopting it silently disables type-aware linting. Revisit when typescript-eslint
ships support.

### A seed that builds a Nest module must `close()` it

`Test.createTestingModule().compile()` wires providers but runs no lifecycle
hooks. `@sms/records`' seed builds a module containing `PdfRenderer`, which
lazily launches a shared Chromium and closes it in `onModuleDestroy` — a hook
that only fires on `close()`. Without the call, the browser subprocess kept
Node's event loop alive, so the script printed `seed complete` and then hung
**forever**, taking every later step of `db:seed`'s `&&` chain with it. A fresh
machine could never finish `pnpm db:seed`.

Every seed that compiles a module now closes it, including the three that do not
start a browser today — the trap re-arms silently the moment one of them imports
a heavier module.

This only surfaced because the database was rebuilt from empty. **Incremental
seeding over a long-lived dev database hides ordering and lifecycle bugs**; do a
full `infra:reset` before believing the chain works.

### Run one testcontainers suite at a time

Concurrent vitest runs starve each other and every test times out at 120s. That
symptom is contention, not a logic bug — do not go looking for one.
