'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CircleCheck, FileUp, ShieldOff, UploadCloud, X } from 'lucide-react';
import {
  Button,
  cn,
  EmptyState,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@sms/ui';
import { createImportJob, fetchImportTargets, type CreateImportJobResult } from '../../../../../lib/api';
import { usePermissions } from '../../../../../lib/permissions';
import { writeCachedImportUpload } from '../mapping-storage';

export default function NewImportPage() {
  const router = useRouter();
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const [entityType, setEntityType] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [parsed, setParsed] = React.useState<CreateImportJobResult | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const targetsQuery = useQuery({
    queryKey: ['import', 'targets'],
    queryFn: ({ signal }) => fetchImportTargets(signal),
    enabled: can('people.person:read'),
  });

  React.useEffect(() => {
    if (!entityType && targetsQuery.data && targetsQuery.data.length > 0) {
      setEntityType(targetsQuery.data[0]!.entityType);
    }
  }, [entityType, targetsQuery.data]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a CSV file first.');
      const csv = await file.text();
      return createImportJob({ entityType, filename: file.name, csv });
    },
    onSuccess: (result) => {
      // The suggested mapping is only ever returned here (createJob is a
      // one-shot parse) - cached so a same-session refresh of the mapping
      // step still gets the pre-fill. A different browser/shared link
      // won't have it (sessionStorage is per-tab), which is a real,
      // documented limitation: the job and its rows are never lost, only
      // this one convenience. See the mapping step's own comment.
      writeCachedImportUpload(result.job.id, { suggestedMapping: result.suggestedMapping, headers: result.headers });
      setParsed(result);
    },
    onError: (error: Error) => {
      toast.error('Could not parse this file', { description: error.message });
    },
  });

  function pickFile(candidate: File | undefined) {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith('.csv') && candidate.type !== 'text/csv') {
      toast.error('Choose a .csv file', { description: `"${candidate.name}" doesn't look like a CSV file.` });
      return;
    }
    setFile(candidate);
    setParsed(null);
  }

  if (!permissionsLoading && !permissionsError && !can('people.person:write')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Settings · Import" title="New import" />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to do this"
          description="Starting an import requires the people.person:write permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  // Step 1's "show the row count before going further": once the file is
  // parsed server-side (createJob), the wizard pauses here on the count
  // rather than jumping straight to mapping - a school importing 1,200 rows
  // should see "1,200 rows parsed" and sanity-check that before continuing.
  if (parsed) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <PageHeader
          eyebrow="Settings · Import · Step 1 of 4"
          title="File parsed"
          description={`"${parsed.job.filename}" was parsed successfully.`}
        />

        <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-surface-sunken px-6 py-10 text-center">
          <CircleCheck className="size-8 text-success" />
          <p className="text-2xl font-semibold tabular-nums text-fg" data-tabular>
            {parsed.job.rowCount} {parsed.job.rowCount === 1 ? 'row' : 'rows'}
          </p>
          <p className="text-sm text-fg-muted">
            parsed across {parsed.headers.length} {parsed.headers.length === 1 ? 'column' : 'columns'}:{' '}
            {parsed.headers.join(', ')}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-5">
          <Button variant="outline" onClick={() => setParsed(null)}>
            <ArrowLeft className="size-4" />
            Choose a different file
          </Button>
          <Button onClick={() => router.push(`/settings/import/${parsed.job.id}?step=map` as Route)}>
            Continue to column mapping
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/settings/import' as Route)}>
          <ArrowLeft className="size-3.5" />
          Back to import history
        </Button>
      </div>

      <PageHeader
        eyebrow="Settings · Import · Step 1 of 4"
        title="Upload a CSV file"
        description="Choose what you're importing and the file to import it from."
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="import-entity-type">What are you importing?</Label>
        {targetsQuery.isPending ? (
          <Skeleton className="h-control w-full" />
        ) : targetsQuery.isError ? (
          <p className="text-sm text-danger">Could not load import targets: {targetsQuery.error.message}</p>
        ) : (
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger id="import-entity-type" aria-label="Entity type">
              <SelectValue placeholder="Choose an entity type" />
            </SelectTrigger>
            <SelectContent>
              {targetsQuery.data.map((target) => (
                <SelectItem key={target.entityType} value={target.entityType}>
                  {target.entityType}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>CSV file</Label>
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            pickFile(event.dataTransfer.files[0]);
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors duration-150 ease-out motion-reduce:transition-none',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            isDragging ? 'border-primary bg-primary-soft' : 'border-border hover:border-border-strong',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
          {file ? (
            <>
              <FileUp className="size-8 text-primary" />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-fg">{file.name}</p>
                <p className="text-xs text-fg-subtle">{formatFileSize(file.size)}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  setFile(null);
                }}
              >
                <X className="size-3.5" />
                Choose a different file
              </Button>
            </>
          ) : (
            <>
              <UploadCloud className="size-8 text-fg-subtle" />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-fg">Drag and drop a CSV file, or click to browse</p>
                <p className="text-xs text-fg-subtle">The first row must be column headers.</p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-5">
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!file || !entityType}
          loading={createMutation.isPending}
        >
          Parse file
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
