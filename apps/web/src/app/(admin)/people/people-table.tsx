'use client';

import * as React from 'react';
import { flexRender } from '@tanstack/react-table';
import { getCoreRowModel, legacyCreateColumnHelper, useLegacyTable } from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback, Skeleton, cn } from '@sms/ui';
import type { Person } from '../../../lib/api';
import { AlertIndicator } from './alert-indicator';
import { displayName, formatDateOnly, fullName, initials } from './format';

/**
 * A grid of `div`s (ARIA `role="table"`), not a native `<table>` - a real
 * `<table>` cannot have its rows absolutely positioned for virtualization
 * without breaking column alignment. Every visual token (borders, sticky
 * header, tabular numerals via `data-tabular`) matches the shared `<Table>`
 * primitive; this is a layout substitution, not a style departure.
 */
const GRID_TEMPLATE = 'minmax(220px,2.2fr) minmax(150px,1fr) minmax(120px,0.8fr) 64px';
const ROW_HEIGHT = 60;

const columnHelper = legacyCreateColumnHelper<Person>();

const columns = [
  columnHelper.display({
    id: 'name',
    header: 'Name',
    cell: (info) => <NameCell person={info.row.original} />,
  }),
  columnHelper.display({
    id: 'dob',
    header: 'Date of birth',
    cell: (info) => {
      const value = info.row.original.dateOfBirth;
      return value ? (
        <span data-tabular className="text-sm text-fg-muted">
          {formatDateOnly(value)}
        </span>
      ) : (
        <span className="text-sm text-fg-subtle">—</span>
      );
    },
  }),
  columnHelper.display({
    id: 'gradeLevel',
    header: 'Grade level',
    cell: (info) => {
      const gradeLevel = info.row.original.customFields.grade_level;
      return typeof gradeLevel === 'string' && gradeLevel ? (
        <span className="text-sm text-fg">{gradeLevel}</span>
      ) : (
        <span className="text-sm text-fg-subtle">—</span>
      );
    },
  }),
  columnHelper.display({
    id: 'alerts',
    header: 'Alerts',
    cell: (info) => <AlertIndicator personId={info.row.original.id} />,
  }),
];

function NameCell({ person }: { person: Person }) {
  const legalName = fullName(person);
  const shownName = displayName(person);
  const showLegalNameSubtitle = shownName !== legalName;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar className="size-8 shrink-0">
        <AvatarFallback>{initials(person)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-fg">{shownName}</span>
        {showLegalNameSubtitle ? (
          <span className="truncate text-xs text-fg-subtle">{legalName}</span>
        ) : null}
      </div>
    </div>
  );
}

export interface PeopleTableProps {
  rows: Person[];
  onRowClick: (person: Person) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  className?: string;
}

/**
 * Virtualized, keyboard-navigable directory grid. Only the visible window
 * (plus overscan) is ever mounted, so this stays smooth whether there are 44
 * rows or several thousand - and because each row's alert indicator does its
 * own bounded fetch (see AlertIndicator), that stays bounded too.
 */
export function PeopleTable({
  rows,
  onRowClick,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  className,
}: PeopleTableProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const rowRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());

  const table = useLegacyTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  const tableRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const endIndex = rowVirtualizer.range?.endIndex ?? 0;

  // Load the next keyset page once scroll nears the end of what's mounted -
  // the only trigger keyset pagination needs, no page-number UI required.
  React.useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (endIndex >= tableRows.length - 1 - 8) {
      fetchNextPage();
    }
  }, [endIndex, tableRows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  React.useEffect(() => {
    if (focusedIndex > tableRows.length - 1) {
      setFocusedIndex(Math.max(0, tableRows.length - 1));
    }
  }, [tableRows.length, focusedIndex]);

  function focusRow(index: number) {
    const clamped = Math.min(Math.max(index, 0), tableRows.length - 1);
    setFocusedIndex(clamped);
    rowVirtualizer.scrollToIndex(clamped, { align: 'auto' });
    // The target row may not be mounted yet (just scrolled into view) - wait
    // a frame for the virtualizer to mount it before moving DOM focus.
    requestAnimationFrame(() => rowRefs.current.get(clamped)?.focus());
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, index: number, person: Person) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(tableRows.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onRowClick(person);
        break;
      default:
        break;
    }
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-card border border-border bg-surface', className)}>
      <div ref={scrollRef} className="relative flex-1 overflow-auto" role="table" aria-label="People directory">
        <div
          role="row"
          className="sticky top-0 z-10 grid items-center border-b border-border bg-surface-sunken"
          style={{ gridTemplateColumns: GRID_TEMPLATE }}
        >
          {table.getHeaderGroups()[0]?.headers.map((header) => (
            <div
              key={header.id}
              role="columnheader"
              className="h-control-compact whitespace-nowrap px-3 text-start align-middle text-xs font-medium text-fg-muted"
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        <div role="rowgroup" style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            if (!row) return null;
            const isFocused = virtualRow.index === focusedIndex;

            return (
              <div
                key={row.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(virtualRow.index, node);
                  else rowRefs.current.delete(virtualRow.index);
                }}
                role="row"
                tabIndex={isFocused ? 0 : -1}
                aria-rowindex={virtualRow.index + 1}
                onFocus={() => setFocusedIndex(virtualRow.index)}
                onKeyDown={(event) => handleRowKeyDown(event, virtualRow.index, row.original)}
                onClick={() => onRowClick(row.original)}
                className={cn(
                  'absolute start-0 top-0 grid w-full cursor-pointer items-center border-b border-border px-0',
                  'transition-colors duration-150 ease-out hover:bg-surface-sunken/60 motion-reduce:transition-none',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                )}
                style={{
                  gridTemplateColumns: GRID_TEMPLATE,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div key={cell.id} role="cell" className="min-w-0 px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {isFetchingNextPage ? (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-fg-subtle">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading more people…
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PeopleTableSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="grid items-center border-b border-border bg-surface-sunken" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
        {['Name', 'Date of birth', 'Grade level', 'Alerts'].map((label) => (
          <div key={label} className="h-control-compact px-3 text-xs font-medium text-fg-muted">
            {label}
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 10 }).map((_, index) => (
          <div
            key={index}
            className="grid items-center gap-3 border-b border-border px-3 py-3"
            style={{ gridTemplateColumns: GRID_TEMPLATE }}
          >
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="size-6 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
