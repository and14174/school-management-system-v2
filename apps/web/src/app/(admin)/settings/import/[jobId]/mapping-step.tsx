'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@sms/ui';
import {
  fetchImportRows,
  fetchImportTargets,
  setImportMapping,
  type ColumnMapping,
  type ImportJob,
} from '../../../../../lib/api';
import { readCachedImportUpload } from '../mapping-storage';

const UNMAPPED = '__unmapped__';
const SAMPLE_ROW_COUNT = 5;

export interface MappingStepProps {
  job: ImportJob;
  onMapped: () => void;
}

export function MappingStep({ job, onMapped }: MappingStepProps) {
  const queryClient = useQueryClient();

  const targetsQuery = useQuery({
    queryKey: ['import', 'targets'],
    queryFn: ({ signal }) => fetchImportTargets(signal),
  });

  // Sample rows double as the source of truth for the CSV's headers (a
  // header -> value map's keys) - the job itself doesn't store headers
  // separately (see CreateImportJobResult's own comment: they're returned
  // once, at creation). Falls back to the sessionStorage cache written at
  // upload time only for the edge case of a header-only file with zero
  // data rows, where there is no row to read headers off of.
  const sampleRowsQuery = useQuery({
    queryKey: ['import', 'job', job.id, 'rows', 'sample'],
    queryFn: ({ signal }) => fetchImportRows(job.id, { limit: SAMPLE_ROW_COUNT }, signal),
  });

  const cached = React.useMemo(() => readCachedImportUpload(job.id), [job.id]);

  const headers = React.useMemo(() => {
    const fromRows = sampleRowsQuery.data?.items[0]?.raw;
    if (fromRows) return Object.keys(fromRows);
    return cached?.headers ?? [];
  }, [sampleRowsQuery.data, cached]);

  const samplesByHeader = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const header of headers) map.set(header, []);
    for (const row of sampleRowsQuery.data?.items ?? []) {
      for (const header of headers) {
        const value = row.raw[header];
        if (value) map.get(header)?.push(value);
      }
    }
    return map;
  }, [headers, sampleRowsQuery.data]);

  const target = targetsQuery.data?.find((entry) => entry.entityType === job.entityType);

  const [mapping, setMapping] = React.useState<ColumnMapping>(() =>
    Object.keys(job.columnMapping).length > 0 ? job.columnMapping : (cached?.suggestedMapping ?? {}),
  );
  const initialisedFromJob = React.useRef(Object.keys(job.columnMapping).length > 0);
  React.useEffect(() => {
    if (!initialisedFromJob.current && Object.keys(job.columnMapping).length > 0) {
      setMapping(job.columnMapping);
      initialisedFromJob.current = true;
    }
  }, [job.columnMapping]);

  const saveMutation = useMutation({
    mutationFn: () => setImportMapping(job.id, mapping),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['import', 'job', job.id] });
      onMapped();
    },
    onError: (error: Error) => {
      toast.error('Could not save the column mapping', { description: error.message });
    },
  });

  const requiredFields = target?.fields.filter((field) => field.required) ?? [];
  const unmappedRequired = requiredFields.filter((field) => !mapping[field.key]);

  if (targetsQuery.isPending || sampleRowsQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (targetsQuery.isError) {
    return (
      <Alert variant="danger">
        <AlertTitle>Could not load the target field list</AlertTitle>
        <AlertDescription>{targetsQuery.error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!target) {
    return (
      <Alert variant="danger">
        <AlertTitle>Unknown import target</AlertTitle>
        <AlertDescription>
          No import target is registered for entity type &quot;{job.entityType}&quot;.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        Match each field Greenwood expects to a column from your file. Fields marked <span className="text-danger">*</span> are
        required.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
            Columns found in your file ({headers.length})
          </h3>
          <div className="flex flex-col gap-2 rounded-card border border-border p-3">
            {headers.length === 0 ? (
              <p className="text-sm text-fg-subtle">No columns could be read from this file.</p>
            ) : (
              headers.map((header) => {
                const samples = samplesByHeader.get(header) ?? [];
                return (
                  <div key={header} className="rounded-control border border-border bg-surface-sunken px-3 py-2">
                    <p className="truncate text-sm font-medium text-fg">{header}</p>
                    <p className="truncate text-xs text-fg-subtle">
                      {samples.length > 0 ? samples.map((value) => `"${value}"`).join(', ') : 'No sample values'}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Greenwood fields</h3>
          <div className="flex flex-col gap-2 rounded-card border border-border p-3">
            {target.fields.map((field) => {
              const isUnmapped = field.required && !mapping[field.key];
              return (
                <div
                  key={field.key}
                  className="flex flex-col gap-1.5 rounded-control border border-transparent px-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-1.5 sm:w-48 sm:shrink-0">
                    <span className="truncate text-sm font-medium text-fg">{field.label}</span>
                    {field.required ? <span className="text-danger">*</span> : null}
                  </div>
                  <Select
                    value={mapping[field.key] ?? UNMAPPED}
                    onValueChange={(value) =>
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (value === UNMAPPED) delete next[field.key];
                        else next[field.key] = value;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={`Map ${field.label}`}
                      aria-invalid={isUnmapped || undefined}
                      className="sm:flex-1"
                    >
                      <SelectValue placeholder="— Not mapped —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED}>— Not mapped —</SelectItem>
                      {headers.map((header) => {
                        const sample = samplesByHeader.get(header)?.[0];
                        return (
                          <SelectItem key={header} value={header}>
                            {header}
                            {sample ? <span className="text-fg-subtle"> — e.g. &quot;{sample}&quot;</span> : null}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {unmappedRequired.length > 0 ? (
        <Alert variant="warning" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />}>
          <AlertTitle>Required fields still need a column</AlertTitle>
          <AlertDescription>
            Map every required field before continuing:{' '}
            {unmappedRequired.map((field) => (
              <Badge key={field.key} variant="warning" className="me-1">
                {field.label}
              </Badge>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-border pt-5">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={unmappedRequired.length > 0}
          loading={saveMutation.isPending}
        >
          Continue to preview
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
