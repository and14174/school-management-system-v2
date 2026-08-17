'use client';

import { Users2 } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, ScrollArea, cn } from '@sms/ui';
import type { AccessRoleSummary } from '../../../../lib/api';

export interface RoleListProps {
  roles: AccessRoleSummary[];
  selectedRoleId: string | null;
  onSelect: (roleId: string) => void;
}

export function RoleList({ roles, selectedRoleId, onSelect }: RoleListProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Roles</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {roles.length === 0 ? (
          <EmptyState
            icon={<Users2 className="size-5" />}
            title="No roles yet"
            description="Roles created for this school will show up here."
          />
        ) : (
          <ScrollArea className="h-[36rem] -mx-1 px-1">
            <div className="flex flex-col gap-1">
              {roles.map((role) => {
                const active = role.id === selectedRoleId;
                const grantCount = role.grants?.length ?? 0;
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => onSelect(role.id)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-control border px-3 py-2.5 text-start',
                      'transition-colors duration-150 ease-out motion-reduce:transition-none',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      active
                        ? 'border-primary/40 bg-primary-soft'
                        : 'border-transparent hover:bg-surface-sunken',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          active ? 'text-primary-soft-fg' : 'text-fg',
                        )}
                      >
                        {role.name}
                      </span>
                      {role.isSystem ? (
                        <Badge variant="info" className="shrink-0">
                          System
                        </Badge>
                      ) : null}
                    </div>
                    {role.description ? (
                      <p className="line-clamp-2 text-xs text-fg-muted">{role.description}</p>
                    ) : null}
                    <div className="flex items-center gap-3 text-xs text-fg-subtle">
                      <span>
                        {grantCount} permission{grantCount === 1 ? '' : 's'} granted
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
