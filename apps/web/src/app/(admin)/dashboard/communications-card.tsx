'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sms/ui';
import { usePermissions } from '../../../lib/permissions';
import { fetchUnreadCounts } from '../../../lib/dashboard-api';
import { ForbiddenError } from '../../../lib/http';
import { CardErrorState, CardSkeletonRows } from './card-states';

/**
 * The caller's own unread announcements/threads. Gated on `people.student:
 * read` (whatever scope) - that is the permission `CommunicationsController`
 * actually checks for every read - but the endpoint itself additionally
 * requires the caller to have a LINKED `people.person` record (it always
 * resolves "mine" from the session, never takes an id - see
 * `requireOwnPersonId`), which a permission check alone cannot know. An
 * account with none (e.g. this seed's admin@greenwood.test, which has no
 * person link at all) gets a real 403 for a reason that is not "access
 * denied" but "there is no personal inbox here" - this card renders nothing
 * in that specific case rather than a misleading permission-error banner,
 * exactly the "only when its data is genuinely available" carve-out the
 * dashboard brief calls for.
 */
export function CommunicationsCard() {
  const { can } = usePermissions();
  const applicable = can('people.student:read');

  const query = useQuery({
    queryKey: ['dashboard', 'communications', 'unread-counts'],
    queryFn: ({ signal }) => fetchUnreadCounts(signal),
    enabled: applicable,
    retry: (failureCount, error) => !(error instanceof ForbiddenError) && failureCount < 2,
  });

  if (!applicable) return null;
  if (query.isError && query.error instanceof ForbiddenError) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Communications</CardTitle>
        <CardDescription>Your unread announcements and messages.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending ? (
          <CardSkeletonRows count={1} />
        ) : query.isError ? (
          <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <div className="flex items-center gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-soft-fg">
              <MessageSquare className="size-4" />
            </div>
            <div className="flex flex-col">
              <p className="text-sm text-fg">
                <span className="font-semibold tabular-nums" data-tabular>
                  {query.data.unreadAnnouncements}
                </span>{' '}
                unread announcement{query.data.unreadAnnouncements === 1 ? '' : 's'}
              </p>
              <p className="text-sm text-fg">
                <span className="font-semibold tabular-nums" data-tabular>
                  {query.data.unreadThreads}
                </span>{' '}
                thread{query.data.unreadThreads === 1 ? '' : 's'} with unread messages
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
