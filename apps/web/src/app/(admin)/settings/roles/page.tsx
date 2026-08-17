'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import { Button, EmptyState, PageHeader, Skeleton } from '@sms/ui';
import { fetchAccessPermissions, fetchAccessRoles } from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { PermissionMatrix } from './permission-matrix';
import { RoleList } from './role-list';

/**
 * Read-only for M1: the pinned contract has no endpoint to mutate a role's
 * permission grants, and every "system" role is immutable by definition
 * regardless. Selecting a role loads its permission matrix; nothing here
 * ever writes.
 */
export default function RolesPermissionsPage() {
  const [selectedRoleId, setSelectedRoleId] = React.useState<string | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: ({ signal }) => fetchAccessRoles(signal),
  });

  const permissionsQuery = useQuery({
    queryKey: ['access', 'permissions'],
    queryFn: ({ signal }) => fetchAccessPermissions(signal),
  });

  // Adopt the first role once the list loads, same pattern as the scope
  // switcher - a picked value is never overridden once the user (or this
  // default) has set it.
  React.useEffect(() => {
    if (selectedRoleId) return;
    const first = rolesQuery.data?.[0];
    if (first) setSelectedRoleId(first.id);
  }, [rolesQuery.data, selectedRoleId]);

  const roles = rolesQuery.data;
  const selectedRole = roles?.find((role) => role.id === selectedRoleId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Access control"
        title="Roles & permissions"
        description="Every role defined for this school, and exactly what each one can see and do."
      />

      {rolesQuery.isPending ? (
        <RolesPageSkeleton />
      ) : !roles ? (
        <RolesPageError
          error={rolesQuery.error ?? new Error('Could not load roles.')}
          onRetry={() => {
            void rolesQuery.refetch();
          }}
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_1fr]">
          <RoleList roles={roles} selectedRoleId={selectedRoleId} onSelect={setSelectedRoleId} />
          <PermissionMatrix selectedRole={selectedRole} catalogQuery={permissionsQuery} />
        </div>
      )}
    </div>
  );
}

function RolesPageSkeleton() {
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_1fr]">
      <div className="flex flex-col gap-2 rounded-card border border-border p-4">
        <Skeleton className="mb-1 h-4 w-16" />
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-border p-4">
        <Skeleton className="mb-1 h-4 w-40" />
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

function RolesPageError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ForbiddenError) {
    return (
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title="You don't have permission to view this"
        description="Viewing roles requires the access.role:read permission. Ask an administrator if you believe this is a mistake."
        className="min-h-[24rem] justify-center"
      />
    );
  }

  return (
    <EmptyState
      icon={<WifiOff className="size-5" />}
      title="Couldn't load roles"
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
