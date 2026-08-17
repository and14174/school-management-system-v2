'use client';

import * as React from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Inbox, MessagesSquare, Send } from 'lucide-react';
import { Badge, Button, EmptyState, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@sms/ui';
import {
  fetchAnnouncements,
  fetchThread,
  fetchThreads,
  markAnnouncementRead,
  markThreadRead,
  postThreadMessage,
  type Announcement,
  type Thread,
  type ThreadDetail,
} from '../../../../lib/portal-api';
import { CardErrorState, CardSkeletonRows } from '../../_components/card-states';
import { formatDateTime } from '../../_lib/date';
import { useMyPerson, usePortalUnreadCounts } from '../../_lib/queries';

export default function PortalMessagesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Messages"
        title="Messages"
        description="Announcements from the school and your conversations."
      />
      <Tabs defaultValue="announcements">
        <TabsList>
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
          <TabsTrigger value="threads">Conversations</TabsTrigger>
        </TabsList>
        <TabsContent value="announcements">
          <AnnouncementsPanel />
        </TabsContent>
        <TabsContent value="threads">
          <ThreadsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Announcements. There is genuinely no endpoint that reports PER-ANNOUNCEMENT
// read state to a non-tenant caller (see portal-api.ts's own comment) - only
// the aggregate unread count. Opening an announcement marks it read (the same
// "open = read" convention as email) and the aggregate updates for real;
// no per-row "unread" dot is rendered, since that would have to be guessed.
// ---------------------------------------------------------------------------

function AnnouncementsPanel() {
  const query = useQuery<Announcement[], Error>({
    queryKey: ['portal', 'communications', 'announcements'],
    queryFn: ({ signal }) => fetchAnnouncements(signal),
  });
  const unreadQuery = usePortalUnreadCounts();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [readIds, setReadIds] = React.useState<Set<string>>(new Set());

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markAnnouncementRead(id),
    onSuccess: (_result, id) => {
      setReadIds((current) => new Set(current).add(id));
      void queryClient.invalidateQueries({ queryKey: ['portal', 'communications', 'unread-counts'] });
    },
  });

  if (query.isPending) return <CardSkeletonRows count={3} />;
  if (query.isError) return <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  if (query.data.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-5" />}
        title="No announcements"
        description="Announcements from the school will appear here."
        className="min-h-48 justify-center py-10"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      {unreadQuery.data ? (
        <p className="text-xs text-fg-subtle" aria-live="polite">
          {unreadQuery.data.unreadAnnouncements > 0
            ? `${unreadQuery.data.unreadAnnouncements} unread announcement${unreadQuery.data.unreadAnnouncements === 1 ? '' : 's'}.`
            : 'You are caught up on announcements.'}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {query.data.map((announcement) => {
          const expanded = expandedId === announcement.id;
          return (
            <li key={announcement.id} className="rounded-card border border-border bg-surface">
              <button
                type="button"
                onClick={() => {
                  const next = expanded ? null : announcement.id;
                  setExpandedId(next);
                  if (next && !readIds.has(announcement.id)) {
                    markReadMutation.mutate(announcement.id);
                  }
                }}
                aria-expanded={expanded}
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-fg">{announcement.title}</span>
                  <span className="text-xs text-fg-muted">
                    {announcement.category}
                    {announcement.publishedAt ? ` · ${formatDateTime(announcement.publishedAt)}` : ' · Not yet published'}
                  </span>
                </div>
                {announcement.supersededByAnnouncementId ? (
                  <Badge variant="neutral" className="shrink-0">
                    Superseded
                  </Badge>
                ) : null}
              </button>
              {expanded ? (
                <div className="border-t border-border px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm text-fg">{announcement.body}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threads. Unlike announcements, real per-thread unread state IS derivable
// (see `computeUnread`'s own comment) - so this list, unlike the
// announcements one, can honestly show which conversations have unread
// messages.
// ---------------------------------------------------------------------------

function ThreadsPanel() {
  const [selectedThreadId, setSelectedThreadId] = React.useState<string | null>(null);

  if (selectedThreadId) {
    return <ThreadDetailView threadId={selectedThreadId} onBack={() => setSelectedThreadId(null)} />;
  }
  return <ThreadListView onSelect={setSelectedThreadId} />;
}

/** Mirrors the exact logic `ThreadService.countUnreadThreads` runs server-side for the aggregate: a message not authored by me, newer than my own `lastReadAt` on this thread. */
function computeUnread(detail: ThreadDetail | undefined, myPersonId: string | undefined): boolean {
  if (!detail || !myPersonId) return false;
  const me = detail.participants.find((participant) => participant.personId === myPersonId);
  const lastReadAt = me?.lastReadAt ? new Date(me.lastReadAt).getTime() : 0;
  return detail.messages.some(
    (message) => message.authorPersonId !== myPersonId && new Date(message.sentAt).getTime() > lastReadAt,
  );
}

function ThreadListView({ onSelect }: { onSelect: (id: string) => void }) {
  const myPersonQuery = useMyPerson();
  const threadsQuery = useQuery<Thread[], Error>({
    queryKey: ['portal', 'communications', 'threads'],
    queryFn: ({ signal }) => fetchThreads(signal),
  });

  const threadIds = threadsQuery.data?.map((thread) => thread.id) ?? [];
  // Bounded by the thread list itself (this account's own participation,
  // realistically a handful) - fetching each detail is what makes a real
  // per-thread unread indicator possible at all, see `computeUnread`.
  const detailQueries = useQueries({
    queries: threadIds.map((id) => ({
      queryKey: ['portal', 'communications', 'thread', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchThread(id, signal),
      staleTime: 15_000,
    })),
  });

  if (threadsQuery.isPending || myPersonQuery.isPending) return <CardSkeletonRows count={3} />;
  if (threadsQuery.isError) {
    return <CardErrorState message={threadsQuery.error.message} onRetry={() => void threadsQuery.refetch()} />;
  }
  if (myPersonQuery.isError) {
    return <CardErrorState message={myPersonQuery.error.message} onRetry={() => void myPersonQuery.refetch()} />;
  }

  if (threadsQuery.data.length === 0) {
    return (
      <EmptyState
        icon={<MessagesSquare className="size-5" />}
        title="No conversations yet"
        description="Conversations with the school will appear here."
        className="min-h-48 justify-center py-10"
      />
    );
  }

  const myPersonId = myPersonQuery.data.id;

  return (
    <ul className="flex flex-col gap-2 pt-1">
      {threadsQuery.data.map((thread, index) => {
        const unread = computeUnread(detailQueries[index]?.data, myPersonId);
        return (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => onSelect(thread.id)}
              className={
                'flex w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 text-start ' +
                'transition-colors duration-150 ease-out hover:bg-surface-sunken motion-reduce:transition-none ' +
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              }
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold text-fg">{thread.subject}</span>
                <span className="text-xs text-fg-muted">
                  {thread.lastMessageAt ? `Last message ${formatDateTime(thread.lastMessageAt)}` : 'No messages yet'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {unread ? <Badge variant="info">Unread</Badge> : null}
                {thread.status === 'closed' ? <Badge variant="neutral">Closed</Badge> : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ThreadDetailView({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const myPersonQuery = useMyPerson();
  const detailQuery = useQuery<ThreadDetail, Error>({
    queryKey: ['portal', 'communications', 'thread', threadId],
    queryFn: ({ signal }) => fetchThread(threadId, signal),
  });
  const [body, setBody] = React.useState('');
  const idempotencyKeyRef = React.useRef(crypto.randomUUID());
  const markedReadRef = React.useRef(false);

  const markReadMutation = useMutation({
    mutationFn: () => markThreadRead(threadId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal', 'communications', 'unread-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['portal', 'communications', 'thread', threadId] });
    },
  });

  React.useEffect(() => {
    if (detailQuery.data && !markedReadRef.current) {
      markedReadRef.current = true;
      markReadMutation.mutate();
    }
    // Deliberately keyed on `detailQuery.data` only, not `markReadMutation` -
    // `mutate` is a fresh function identity every render, and this must fire
    // exactly once per thread view, not on every render.
  }, [detailQuery.data]);

  const sendMutation = useMutation({
    mutationFn: () => postThreadMessage(threadId, { body, idempotencyKey: idempotencyKeyRef.current }),
    onSuccess: () => {
      setBody('');
      idempotencyKeyRef.current = crypto.randomUUID();
      void queryClient.invalidateQueries({ queryKey: ['portal', 'communications', 'thread', threadId] });
      void queryClient.invalidateQueries({ queryKey: ['portal', 'communications', 'threads'] });
    },
  });

  return (
    <div className="flex flex-col gap-4 pt-1">
      <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
        <ArrowLeft className="size-4" />
        Back to conversations
      </Button>

      {detailQuery.isPending || myPersonQuery.isPending ? (
        <CardSkeletonRows count={3} />
      ) : detailQuery.isError ? (
        <CardErrorState message={detailQuery.error.message} onRetry={() => void detailQuery.refetch()} />
      ) : myPersonQuery.isError ? (
        <CardErrorState message={myPersonQuery.error.message} onRetry={() => void myPersonQuery.refetch()} />
      ) : (
        <>
          <h2 className="text-base font-semibold text-fg">{detailQuery.data.thread.subject}</h2>
          <ul className="flex flex-col gap-3">
            {detailQuery.data.messages.map((message) => {
              const mine = message.authorPersonId === myPersonQuery.data.id;
              return (
                <li
                  key={message.id}
                  className={
                    mine
                      ? 'ms-8 flex flex-col gap-1 rounded-card border border-primary/30 bg-primary-soft px-4 py-3'
                      : 'me-8 flex flex-col gap-1 rounded-card border border-border bg-surface px-4 py-3'
                  }
                >
                  <span className="text-xs text-fg-subtle">
                    {formatDateTime(message.sentAt)}
                    {mine ? ' · You' : ''}
                  </span>
                  <p className="whitespace-pre-wrap text-sm text-fg">{message.body}</p>
                </li>
              );
            })}
          </ul>

          {detailQuery.data.thread.status === 'closed' ? (
            <p className="text-sm text-fg-muted">This conversation is closed.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (body.trim()) sendMutation.mutate();
              }}
              className="flex flex-col gap-2"
            >
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write a reply…"
                aria-label="Reply"
                disabled={sendMutation.isPending}
              />
              {sendMutation.isError ? <p className="text-xs text-danger">{sendMutation.error.message}</p> : null}
              <Button type="submit" size="sm" className="w-fit" loading={sendMutation.isPending} disabled={!body.trim()}>
                <Send className="size-3.5" />
                Send
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
