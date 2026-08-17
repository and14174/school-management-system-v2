'use client';

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { RefreshCw, Search, ShieldOff, WifiOff } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Skeleton,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sms/ui';
import {
  fetchAccessRolePermissions,
  type AccessPermissionCatalogEntry,
  type AccessRoleSummary,
  type AccessScope,
} from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';

const SCOPE_LABELS: Record<AccessScope, string> = {
  own: 'Own records',
  section: 'Section',
  grade_level: 'Grade level',
  campus: 'Campus',
  tenant: 'Whole school',
};

function formatScope(scope: AccessScope): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** "people.student" -> "People › Student" */
function formatResource(resource: string): string {
  return resource
    .split('.')
    .map((segment) => segment.replace(/_/g, ' '))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' › ');
}

/** "read_medical" -> "Read medical" */
function formatAction(action: string): string {
  const spaced = action.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface MatrixRow {
  key: string;
  resource: string;
  action: string;
  description: string | null;
  scope: AccessScope | null;
}

interface MatrixGroup {
  resource: string;
  rows: MatrixRow[];
}

export interface PermissionMatrixProps {
  selectedRole: AccessRoleSummary | null;
  catalogQuery: UseQueryResult<AccessPermissionCatalogEntry[], Error>;
}

export function PermissionMatrix({ selectedRole, catalogQuery }: PermissionMatrixProps) {
  const [search, setSearch] = React.useState('');

  const roleId = selectedRole?.id ?? null;
  const roleQuery = useQuery({
    queryKey: ['access', 'roles', roleId, 'permissions'],
    queryFn: ({ signal }) => fetchAccessRolePermissions(roleId as string, signal),
    enabled: roleId !== null,
  });

  if (!selectedRole) {
    return (
      <EmptyState
        title="Select a role"
        description="Choose a role on the left to see exactly which permissions it grants, and at what scope."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const catalogPending = catalogQuery.isPending;
  const rolePending = roleQuery.isPending;

  if (catalogPending || rolePending) {
    return <MatrixSkeleton />;
  }

  const primaryError = catalogQuery.error ?? roleQuery.error;
  if (primaryError) {
    return (
      <MatrixError
        error={primaryError}
        onRetry={() => {
          void catalogQuery.refetch();
          void roleQuery.refetch();
        }}
      />
    );
  }

  const catalog = catalogQuery.data ?? [];
  const granted = new Map<string, AccessScope>((roleQuery.data ?? []).map((p) => [p.key, p.scope]));

  if (catalog.length === 0) {
    return (
      <EmptyState
        title="No permissions defined"
        description="The permission catalog is empty."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  const rows: MatrixRow[] = catalog.map((permission) => ({
    key: permission.key,
    resource: permission.resource,
    action: permission.action,
    description: permission.description,
    scope: granted.get(permission.key) ?? null,
  }));

  const needle = search.trim().toLowerCase();
  const filteredRows = needle
    ? rows.filter((row) =>
        [row.key, row.resource, row.action, row.description ?? '', formatResource(row.resource)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : rows;

  const groups: MatrixGroup[] = Object.values(
    filteredRows.reduce<Record<string, MatrixGroup>>((acc, row) => {
      (acc[row.resource] ??= { resource: row.resource, rows: [] }).rows.push(row);
      return acc;
    }, {}),
  )
    .sort((a, b) => formatResource(a.resource).localeCompare(formatResource(b.resource)))
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => a.action.localeCompare(b.action)),
    }));

  const grantedCount = rows.filter((row) => row.scope !== null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-fg">{selectedRole.name}</h2>
          <p className="text-xs text-fg-muted">
            {grantedCount} of {rows.length} permissions granted
            {selectedRole.isSystem ? ' · System role, read-only' : ''}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by resource or permission…"
            aria-label="Filter permissions"
            className="ps-9"
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Search className="size-5" />}
          title="No permissions match"
          description="Try a different resource or permission name."
          className="min-h-[16rem] justify-center"
        />
      ) : (
        <div className="max-h-[34rem] overflow-y-auto rounded-card border border-border">
          <table className="w-full caption-bottom text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>Permission</TableHead>
                <TableHead className="w-40">Granted scope</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <React.Fragment key={group.resource}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={2}
                      className="bg-surface-sunken py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle"
                    >
                      {formatResource(group.resource)}
                    </TableCell>
                  </TableRow>
                  {group.rows.map((row) => (
                    <TableRow key={row.key} className={row.scope === null ? 'opacity-60' : undefined}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5 py-0.5">
                          <span className="font-medium text-fg">{formatAction(row.action)}</span>
                          {row.description ? (
                            <span className="text-xs text-fg-muted">{row.description}</span>
                          ) : null}
                          <span className="font-mono text-[11px] text-fg-subtle">{row.key}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.scope ? (
                          <Badge variant="info">{formatScope(row.scope)}</Badge>
                        ) : (
                          <span className="text-xs text-fg-subtle">Not granted</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </table>
        </div>
      )}
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-control w-72" />
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-border p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

function MatrixError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing role permissions requires the access.role:read permission. Ask an administrator if you need access."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load this role's permissions"
      description={error.message}
      action={
        <Button onClick={onRetry}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      }
      className="min-h-[24rem] justify-center"
    />
  );
}
