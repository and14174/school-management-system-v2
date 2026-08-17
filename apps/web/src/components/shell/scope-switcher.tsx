'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, Layers, Lock, TriangleAlert } from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from '@sms/ui';
import { fetchScope, type ScopeAcademicYear, type ScopeResponse } from '../../lib/api';

/**
 * The most important piece of chrome in the product: every record is filed
 * under a school, a campus and an academic year, so what is selected here
 * changes the meaning of every other screen.
 *
 * Fed by GET /api/v1/tenancy/scope. The API validates the triple against the
 * database, so a campus that belongs to another tenant is rejected there
 * rather than trusted here.
 */
export function ScopeSwitcher() {
  const [campusId, setCampusId] = React.useState<string | null>(null);
  const [yearId, setYearId] = React.useState<string | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['tenancy', 'scope'],
    queryFn: ({ signal }) => fetchScope(undefined, signal),
  });

  // Adopt the server's defaults once, then leave the user's choice alone.
  React.useEffect(() => {
    if (!data) return;
    setCampusId((current) => current ?? data.current.campusId ?? data.campuses[0]?.id ?? null);
    setYearId(
      (current) => current ?? data.current.academicYearId ?? data.academicYears[0]?.id ?? null,
    );
  }, [data]);

  if (isPending) {
    return <Skeleton className="h-control w-64" />;
  }

  if (error || !data) {
    return (
      <div
        className="flex h-control items-center gap-2 rounded-control border border-border bg-surface-sunken px-3 text-sm text-fg-muted"
        role="status"
      >
        <TriangleAlert className="size-4 shrink-0 text-warning" />
        <span className="truncate">Scope unavailable</span>
      </div>
    );
  }

  const campus = data.campuses.find((c) => c.id === campusId) ?? data.campuses[0];
  const year = data.academicYears.find((y) => y.id === yearId) ?? data.academicYears[0];
  const yearIsReadOnly = year ? year.status === 'locked' || year.status === 'archived' : false;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Change working scope"
          className={cn(
            'flex h-control items-center gap-2 rounded-control border border-border bg-surface-sunken px-3 text-sm text-fg',
            'transition-colors duration-150 ease-out hover:bg-surface-raised motion-reduce:transition-none',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          <Layers className="size-4 shrink-0 text-fg-subtle" />
          <span className="hidden max-w-48 truncate font-medium sm:inline">{data.tenant.name}</span>
          {campus ? (
            <>
              <span className="hidden text-fg-subtle md:inline">/</span>
              <span className="hidden max-w-32 truncate text-fg-muted md:inline">
                {campus.name}
              </span>
            </>
          ) : null}
          {year ? (
            <>
              <span className="hidden text-fg-subtle lg:inline">/</span>
              <span className="hidden text-fg-muted lg:inline">{year.name}</span>
              {yearIsReadOnly ? (
                <Lock className="hidden size-3.5 shrink-0 text-warning lg:inline" />
              ) : null}
            </>
          ) : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className={cn(
            'z-50 w-80 rounded-card border border-border bg-surface-raised p-4 shadow-overlay',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'motion-reduce:animate-none',
          )}
        >
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">
            Working scope
          </p>
          <div className="flex flex-col gap-3">
            <ScopeField label="School">
              {/* M1c: a user with access to more than one school picks here. */}
              <Select value={data.tenant.id} disabled>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={data.tenant.id}>{data.tenant.name}</SelectItem>
                </SelectContent>
              </Select>
            </ScopeField>

            <ScopeField label="Campus">
              <Select value={campus?.id ?? ''} onValueChange={setCampusId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.campuses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ScopeField>

            <ScopeField label="Academic year">
              <Select value={year?.id ?? ''} onValueChange={setYearId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.academicYears.map((y) => (
                    <SelectItem key={y.id} value={y.id}>
                      {y.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ScopeField>

            {year ? <YearStatusNote year={year} /> : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A locked or archived year is read-only in the database, not just in the UI -
 * tenancy.assert_year_writable() raises on write. Saying so here means the
 * refusal is never a surprise.
 */
function YearStatusNote({ year }: { year: ScopeAcademicYear }) {
  if (year.status === 'open' || year.status === 'planning') {
    return (
      <p className="text-xs text-fg-subtle">
        {year.name} is open. Changes you make apply to this year.
      </p>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-control bg-warning-soft p-2.5">
      <Lock className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <p className="text-xs text-fg-muted">
        <Badge variant="warning" className="me-1.5 align-middle">
          {year.status}
        </Badge>
        {year.name} is read-only. You can view its records, but not change them.
      </p>
    </div>
  );
}

export type { ScopeResponse };

function ScopeField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
