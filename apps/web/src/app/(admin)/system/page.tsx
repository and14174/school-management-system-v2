'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, WifiOff, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Skeleton,
} from '@sms/ui';
import { API_URL, fetchHealth, type HealthDependency } from '../../../lib/api';

interface HealthResult {
  latencyMs: number;
  entries: Array<{ name: string; status: string; raw: HealthDependency }>;
  overallStatus: string;
}

async function loadHealth(): Promise<HealthResult> {
  const start = performance.now();
  const data = await fetchHealth();
  const latencyMs = Math.round(performance.now() - start);

  const merged: Record<string, HealthDependency> = { ...data.info, ...data.error, ...data.details };
  const entries = Object.entries(merged).map(([name, raw]) => ({
    name,
    status: raw?.status ?? 'unknown',
    raw,
  }));

  return { latencyMs, entries, overallStatus: data.status };
}

export default function SystemPage() {
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['health'],
    queryFn: loadHealth,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Diagnostics"
        title="System health"
        description={`Live status of core infrastructure dependencies, from ${API_URL}/api/v1/health.`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />
            Retry
          </Button>
        }
      />

      {isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={<WifiOff className="size-5" />}
              title="The API is unreachable"
              description={`We couldn't reach ${API_URL}. It may not be running yet, or it's temporarily unavailable. This page will keep working once the API comes back.`}
              action={
                <Button onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw className={isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />
                  Retry
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Overall status</CardTitle>
                <CardDescription>Round-trip latency: {data.latencyMs}ms</CardDescription>
              </div>
              <StatusPill status={data.overallStatus} />
            </CardHeader>
          </Card>

          {data.entries.length === 0 ? (
            <Card>
              <CardContent className="pt-5">
                <EmptyState
                  title="No dependencies reported"
                  description="The health endpoint responded, but didn't include any dependency checks."
                />
              </CardContent>
            </Card>
          ) : (
            data.entries.map((entry) => (
              <Card key={entry.name}>
                <CardHeader className="flex-row items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <StatusPill status={entry.status} />
                    <CardTitle className="font-mono text-sm">{entry.name}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <details className="group">
                    <summary className="cursor-pointer text-sm font-medium text-fg-muted transition-colors duration-150 hover:text-fg">
                      Raw payload
                    </summary>
                    <pre
                      data-tabular
                      className="mt-2 overflow-x-auto rounded-control bg-surface-sunken p-3 text-xs text-fg-muted"
                    >
                      {JSON.stringify(entry.raw, null, 2)}
                    </pre>
                  </details>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const isUp = status === 'up' || status === 'ok';
  return (
    <Badge variant={isUp ? 'success' : 'danger'}>
      {isUp ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {status}
    </Badge>
  );
}
