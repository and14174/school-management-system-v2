#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: a realistic attendance code catalogue
 * (Present, Absent, Late, Authorised absence, Illness) and ~2 weeks of
 * attendance history across every section `@sms/academic`'s seed creates,
 * with a believable ~94% present rate, a few lates, and one student with a
 * run of 3 consecutive absences immediately before today (so the
 * consecutive-absence / "who needs a call home" case has real data to look
 * at).
 *
 * Deliberately marks history for [today-13, today-1] and leaves TODAY's
 * sessions unmarked - so `GET /attendance/unmarked-sessions?date=<today>`
 * and the marking screen both have something real to show, rather than the
 * demo re-editing an already-marked session.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s, `@sms/identity`'s, `@sms/access`'s, `@sms/people`'s and
 * `@sms/academic`'s own `seed.ts`: all five must have already run (this
 * script looks up the "greenwood" tenant, its sections/meetings/rosters, and
 * `teacher@greenwood.test`, and fails with a clear message if any is
 * missing).
 *
 * Usage: tsx src/seed.ts (run after tenancy's, identity's, access's,
 * people's and academic's). Not wired into `apps/api`'s `db:seed` chain -
 * that script lives at `apps/api/package.json`, outside this module's
 * allowed edit paths (see the module report's constraints); run this seed
 * manually as the last step.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { closeSqlClients, runWithContext, withSystemTx } from '@sms/db';
import { OUTBOX_CONTRACT, OutboxModule, type OutboxContract } from '@sms/outbox';
import { formatDateOnly, newId, todayDateOnly, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { AttendanceCodeService } from './application/code.service.js';
import { AttendanceRecordService } from './application/attendance-record.service.js';
import type { AttendanceCategory } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const TEACHER_EMAIL = 'teacher@greenwood.test';

const codes = new AttendanceCodeService();

/**
 * `OutboxService` (the concrete `OUTBOX_CONTRACT` implementation) is an
 * internal `@sms/outbox` class, not part of its public entrypoint (only the
 * port/token and `OutboxModule` are exported - module-boundary, same
 * reasoning as every other module's own `application/*` staying private).
 * A minimal Nest DI container just for `OutboxModule` is the only way to
 * obtain a real one outside `apps/api`'s own bootstrap - `.compile()` alone
 * (no `.init()`) deliberately does NOT run `OutboxModule.onApplicationBootstrap`,
 * so this does not start a background dispatcher loop that would otherwise
 * keep the seed script's process alive.
 */
async function buildRecordService(): Promise<AttendanceRecordService> {
  seedModule = await Test.createTestingModule({ imports: [OutboxModule] }).compile();
  const moduleRef = seedModule;
  const outbox = moduleRef.get<OutboxContract>(OUTBOX_CONTRACT);
  return new AttendanceRecordService(outbox);
}

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first.');
  }
  return row.id as TenantId;
}

async function findTeacherUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) => db.execute<{ id: string }>(sql`select id from identity.user where email = ${TEACHER_EMAIL} limit 1`));
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(`No user "${TEACHER_EMAIL}" found. Run @sms/academic's seed first (it creates this login).`);
  }
  return row.id as UserId;
}

interface CodeSeed {
  readonly code: string;
  readonly label: string;
  readonly category: AttendanceCategory;
  readonly countsAsPresent: boolean;
  readonly isDefault?: boolean;
  readonly requiresReason?: boolean;
  readonly sequence: number;
}

const CODE_SEEDS: CodeSeed[] = [
  { code: 'PRESENT', label: 'Present', category: 'present', countsAsPresent: true, isDefault: true, sequence: 1 },
  { code: 'ABSENT', label: 'Absent', category: 'absent', countsAsPresent: false, sequence: 2 },
  { code: 'LATE', label: 'Late', category: 'late', countsAsPresent: true, sequence: 3 },
  { code: 'AUTH_ABSENCE', label: 'Authorised absence', category: 'excused', countsAsPresent: false, requiresReason: true, sequence: 4 },
  { code: 'ILLNESS', label: 'Illness', category: 'excused', countsAsPresent: false, sequence: 5 },
];

async function ensureCodes(tenantId: TenantId): Promise<Map<string, string>> {
  const existing = await codes.listCodes(tenantId);
  const byCode = new Map(existing.map((c) => [c.code, c.id]));

  for (const seed of CODE_SEEDS) {
    if (byCode.has(seed.code)) {
      console.log(`  skip   attendance code "${seed.code}" (already exists)`);
      continue;
    }
    const created = await codes.createCode(tenantId, {
      code: seed.code,
      label: seed.label,
      category: seed.category,
      countsAsPresent: seed.countsAsPresent,
      isDefault: seed.isDefault ?? false,
      requiresReason: seed.requiresReason ?? false,
      sequence: seed.sequence,
    });
    if (!created.ok) {
      throw created.error;
    }
    byCode.set(seed.code, created.value.id);
    console.log(`  create attendance code "${seed.code}"`);
  }
  return byCode;
}

type SectionMeetingRow = {
  readonly section_id: string;
  readonly section_code: string;
  readonly meeting_id: string;
  readonly day_of_week: number;
};

async function listSectionMeetings(tenantId: TenantId): Promise<Map<string, Map<number, { meetingId: string; sectionCode: string }>>> {
  const rows = await withSystemTx((db) =>
    db.execute<SectionMeetingRow>(sql`
      select sec.id as section_id, sec.code as section_code, sm.id as meeting_id, sm.day_of_week
      from academic.section_meeting sm
      join academic.section sec on sec.id = sm.section_id
      where sm.tenant_id = ${tenantId}
      order by sec.code, sm.day_of_week
    `),
  );

  const bySection = new Map<string, Map<number, { meetingId: string; sectionCode: string }>>();
  for (const row of rows as unknown as SectionMeetingRow[]) {
    const byDay = bySection.get(row.section_id) ?? new Map<number, { meetingId: string; sectionCode: string }>();
    byDay.set(row.day_of_week, { meetingId: row.meeting_id, sectionCode: row.section_code });
    bySection.set(row.section_id, byDay);
  }
  return bySection;
}

type RosterRow = { readonly person_id: string; readonly given_name: string; readonly family_name: string };

async function listRoster(tenantId: TenantId, sectionId: string): Promise<Array<{ personId: PersonId; givenName: string; familyName: string }>> {
  const rows = await withSystemTx((db) =>
    db.execute<RosterRow>(sql`
      select se.person_id, p.given_name, p.family_name
      from academic.section_enrollment se
      join people.person p on p.id = se.person_id
      where se.tenant_id = ${tenantId} and se.section_id = ${sectionId}
      order by p.family_name, p.given_name
    `),
  );
  return (rows as unknown as RosterRow[]).map((row) => ({
    personId: row.person_id as PersonId,
    givenName: row.given_name,
    familyName: row.family_name,
  }));
}

function isoDayOfWeek(date: DateOnly): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function addDays(date: DateOnly, days: number): DateOnly {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + days);
  return formatDateOnly(next);
}

/** Deterministic (not random) so re-running this seed produces the exact same history - required for idempotency, same reasoning as `markSession`'s idempotency key below. */
function pickCategory(dateIndex: number, studentIndex: number): 'present' | 'absent' | 'late' {
  const hash = (dateIndex * 7 + studentIndex * 3) % 100;
  if (hash < 3) return 'late'; // ~3%
  if (hash < 6) return 'absent'; // ~3% -> ~94% present overall
  return 'present';
}

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const teacherUserId = await findTeacherUserId();
  const records = await buildRecordService();

  const codeIdByCode = await ensureCodes(tenantId);
  const presentCodeId = codeIdByCode.get('PRESENT')!;
  const absentCodeId = codeIdByCode.get('ABSENT')!;
  const lateCodeId = codeIdByCode.get('LATE')!;
  const codeIdByCategory: Record<'present' | 'absent' | 'late', string> = {
    present: presentCodeId,
    absent: absentCodeId,
    late: lateCodeId,
  };

  const meetingsBySection = await listSectionMeetings(tenantId);
  if (meetingsBySection.size === 0) {
    throw new Error('No section meetings found. Run @sms/academic\'s seed first.');
  }

  // Mon/Wed/Fri occurrences in [today-13, today-1] - see this file's own
  // header for why TODAY is deliberately excluded. Oldest first, so the
  // LAST 3 entries are the most recent school days before today - the
  // window the consecutive-absence student is marked absent for.
  const today = todayDateOnly();
  const qualifyingDates: DateOnly[] = [];
  for (let offset = 13; offset >= 1; offset -= 1) {
    const date = addDays(today, -offset);
    const dayOfWeek = isoDayOfWeek(date);
    if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) {
      qualifyingDates.push(date);
    }
  }
  const streakDates = new Set(qualifyingDates.slice(-3));

  // The one student who gets a run of 3 consecutive absences - the first
  // roster entry of the first section (by code) that has any students at
  // all, picked deterministically rather than by name so this does not rot
  // if @sms/academic's own seed data changes shape.
  let streakPersonId: PersonId | null = null;

  const ctx = { tenantId, userId: teacherUserId, actorUserId: teacherUserId, roles: [], requestId: newId() };

  const sortedSectionIds = [...meetingsBySection.keys()].sort((a, b) => {
    const aCode = [...meetingsBySection.get(a)!.values()][0]?.sectionCode ?? '';
    const bCode = [...meetingsBySection.get(b)!.values()][0]?.sectionCode ?? '';
    return aCode.localeCompare(bCode);
  });

  let sessionsMarked = 0;
  for (const sectionId of sortedSectionIds) {
    const roster = await listRoster(tenantId, sectionId);
    if (roster.length === 0) {
      continue;
    }
    if (streakPersonId === null) {
      streakPersonId = roster[0]!.personId;
    }

    const byDay = meetingsBySection.get(sectionId)!;

    for (const [dateIndex, date] of qualifyingDates.entries()) {
      const dayOfWeek = isoDayOfWeek(date);
      const meeting = byDay.get(dayOfWeek);
      if (!meeting) {
        continue;
      }

      const marks = roster.map((student, studentIndex) => {
        let category = pickCategory(dateIndex, studentIndex);
        if (student.personId === streakPersonId && streakDates.has(date)) {
          category = 'absent';
        }
        return { personId: student.personId, codeId: codeIdByCategory[category] };
      });

      const result = await runWithContext(ctx, () =>
        records.markSession(tenantId, {
          sectionMeetingId: meeting.meetingId,
          date,
          idempotencyKey: `seed-${meeting.meetingId}-${date}`,
          marks,
        }),
      );
      if (!result.ok) {
        throw result.error;
      }
      if (!result.value.replayed) {
        sessionsMarked += 1;
      }
    }
  }

  console.log(`  mark   attendance for ${sessionsMarked} new session(s) across ${sortedSectionIds.length} section(s)`);
  console.log(`  streak person ${streakPersonId} marked absent on: ${[...streakDates].join(', ')}`);
  console.log('seed complete');
  console.log('');
  console.log(`  Today (${today}) is deliberately left UNMARKED for every section - the live demo target.`);
}

/**
 * Closed in the `finally` below. `compile()` does not run lifecycle hooks, so
 * nothing a module holds is released until `close()` - and a provider that
 * owns an OS resource (the shared Chromium in `@sms/documents`' `PdfRenderer`
 * is the one that bit us) then keeps the event loop alive and hangs the whole
 * `db:seed` chain. Cheap here, and it stops that trap being re-armed the day
 * this seed imports a heavier module.
 */
let seedModule: TestingModule | undefined;

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await seedModule?.close();
    await closeSqlClients();
  });
