#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: one tenant ("Greenwood International",
 * slug `greenwood`), two campuses (Main Campus, the default; North Campus)
 * and two academic years (2024-2025, archived; 2025-2026, open and current).
 *
 * Safe to run repeatedly - every step checks for an existing row (by slug /
 * code / name) before creating one, rather than relying on ON CONFLICT, so
 * partial prior runs and full re-runs both converge to the same state.
 *
 * Usage: tsx src/seed.ts - wired to `apps/api`'s `db:seed` script, and from
 * there to the root `pnpm db:seed` (see the deviation note in the module
 * report: `apps/api/package.json` needed a `db:seed` script added, since
 * `pnpm db:seed` at the repo root already called it, but it did not exist).
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSqlClients, runWithContext } from '@sms/db';
import { newId, type TenantContext } from '@sms/kernel';
import { AcademicYearService } from './application/academic-year.service.js';
import type { CreateAcademicYearInput, CreateCampusInput } from './application/schemas.js';
import { CampusService } from './application/campus.service.js';
import { TenantService } from './application/tenant.service.js';
import type { AcademicYear, Campus } from './domain/types.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see migrate.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const tenantService = new TenantService();
const campusService = new CampusService();
const academicYearService = new AcademicYearService();

async function upsertTenant() {
  const existing = await tenantService.getBySlug('greenwood');
  if (existing.ok) {
    console.log('  skip   tenant "greenwood" (already exists)');
    return existing.value;
  }

  const created = await tenantService.create({
    slug: 'greenwood',
    name: 'Greenwood International',
    legalName: 'Greenwood International School',
    locale: 'en',
    timezone: 'UTC',
    currency: 'USD',
    status: 'active',
    branding: {},
    featureFlags: {},
    terminology: {},
  });
  if (!created.ok) {
    throw created.error;
  }
  console.log('  create tenant "greenwood"');
  return created.value;
}

async function upsertCampus(existing: Campus[], input: CreateCampusInput): Promise<void> {
  if (existing.some((campus) => campus.code === input.code)) {
    console.log(`  skip   campus "${input.code}" (already exists)`);
    return;
  }
  const created = await campusService.create(input);
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create campus "${input.code}"`);
}

async function upsertAcademicYear(existing: AcademicYear[], input: CreateAcademicYearInput): Promise<void> {
  if (existing.some((year) => year.name === input.name)) {
    console.log(`  skip   academic year "${input.name}" (already exists)`);
    return;
  }
  const created = await academicYearService.create(input);
  if (!created.ok) {
    throw created.error;
  }
  console.log(`  create academic year "${input.name}"`);
}

/**
 * Academic years for the demo tenant, computed relative to today rather than
 * hardcoded.
 *
 * Hardcoded dates rot: the seed originally created 2025-2026 ending 2026-06-30,
 * so once the clock passed that date the "current" year was one that had already
 * finished and no term contained today. Everything keyed to "now" then looks
 * broken for reasons that have nothing to do with the code - marking today's
 * attendance, this week's timetable, a teacher's current workload.
 *
 * The current year deliberately STRADDLES today (roughly ten months behind, two
 * ahead) so there is history to look at and today is always inside a live term.
 * A real school's year has a summer gap; demo data that reproduces the gap on
 * the day someone evaluates the product is not demonstrating realism, it is
 * demonstrating an empty screen.
 */
function demoAcademicYears(): {
  previous: { name: string; startsOn: string; endsOn: string };
  current: { name: string; startsOn: string; endsOn: string };
} {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const addMonths = (d: Date, months: number): Date => {
    const next = new Date(d);
    next.setMonth(next.getMonth() + months);
    return next;
  };

  const today = new Date();
  const currentStart = addMonths(today, -10);
  const currentEnd = addMonths(today, 2);
  const previousStart = addMonths(currentStart, -12);
  const previousEnd = addMonths(currentStart, -1);

  const label = (from: Date, to: Date): string => `${from.getFullYear()}-${to.getFullYear()}`;

  return {
    previous: { name: label(previousStart, previousEnd), startsOn: iso(previousStart), endsOn: iso(previousEnd) },
    current: { name: label(currentStart, currentEnd), startsOn: iso(currentStart), endsOn: iso(currentEnd) },
  };
}

async function main(): Promise<void> {
  const tenant = await upsertTenant();

  const ctx: TenantContext = { tenantId: tenant.id, roles: [], requestId: newId() };

  await runWithContext(ctx, async () => {
    const existingCampuses = await campusService.list();
    await upsertCampus(existingCampuses, {
      code: 'main',
      name: 'Main Campus',
      address: {},
      timezone: tenant.timezone,
      locale: tenant.locale,
      isDefault: true,
      status: 'active',
    });
    await upsertCampus(existingCampuses, {
      code: 'north',
      name: 'North Campus',
      address: {},
      timezone: tenant.timezone,
      locale: tenant.locale,
      isDefault: false,
      status: 'active',
    });

    const existingYears = await academicYearService.list();
    const { previous, current } = demoAcademicYears();

    await upsertAcademicYear(existingYears, { ...previous, status: 'archived', isCurrent: false });
    await upsertAcademicYear(existingYears, { ...current, status: 'open', isCurrent: true });
  });

  console.log('seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
