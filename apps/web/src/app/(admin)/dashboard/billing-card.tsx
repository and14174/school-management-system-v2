'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sms/ui';
import { usePermissions } from '../../../lib/permissions';
import { fetchBillingSummary, permissionScope, type BillingSummary } from '../../../lib/dashboard-api';
import { formatMoneyMinor } from '../../../lib/money';
import { CardErrorState, CardSkeletonRows } from './card-states';

/**
 * Outstanding balances - `GET /billing/summary`, gated on
 * `billing.invoice:read` and, per this card, only rendered for a caller
 * whose grant resolves at `tenant` scope (finance/school_administrator - see
 * `@sms/access`'s `seed.ts`). The `dependants` scope the SAME permission
 * also grants belongs to a guardian's own portal home page, not this admin
 * dashboard - see `dashboard-api.ts`'s `permissionScope` for why the SCOPE,
 * not just `can()`, decides whether this card renders at all.
 *
 * This card did not exist before: the original dashboard hardcoded
 * "$48,210" of balances with no controller behind it and it was deleted -
 * see `docs/decisions.md`'s "Never render a fabricated figure". It exists
 * now because `GET /billing/summary` does.
 */
export function BillingCard() {
  const { can, permissions } = usePermissions();
  const applicable = can('billing.invoice:read') && permissionScope(permissions, 'billing.invoice:read') === 'tenant';

  const query = useQuery({
    queryKey: ['dashboard', 'billing', 'summary'],
    queryFn: ({ signal }) => fetchBillingSummary(signal),
    enabled: applicable,
  });

  if (!applicable) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Outstanding balances</CardTitle>
        <CardDescription>Fees owed across the school.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending ? (
          <CardSkeletonRows count={2} />
        ) : query.isError ? (
          <CardErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <BillingSummaryBody summary={query.data} />
        )}
      </CardContent>
    </Card>
  );
}

function BillingSummaryBody({ summary }: { summary: BillingSummary }) {
  if (summary.currency === null) {
    // A real, distinguishable state - not a "$0.00" that could equally mean
    // "nothing owed" or "failed to load".
    return <p className="text-sm text-fg-muted">No invoices have been issued yet.</p>;
  }

  return (
    <>
      <div className="flex items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
          <DollarSign className="size-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-semibold tabular-nums text-fg" data-tabular>
            {formatMoneyMinor(summary.outstandingMinor, summary.currency)}
          </span>
          <span className="text-xs text-fg-muted">outstanding</span>
        </div>
      </div>

      {summary.overdueInvoiceCount === 0 ? (
        <div className="flex items-center gap-3 rounded-control border border-success/30 bg-success-soft px-3 py-2.5">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          <p className="text-sm font-medium text-success">No overdue invoices.</p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-control border border-warning/30 bg-warning-soft px-3 py-2.5">
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <p className="text-sm font-medium text-warning">
            {summary.overdueInvoiceCount} invoice{summary.overdueInvoiceCount === 1 ? '' : 's'} overdue.
          </p>
        </div>
      )}

      <p className="text-xs text-fg-muted">
        {formatMoneyMinor(summary.collectedMinor, summary.currency)} collected in the last {summary.collectedWindowDays} days.
      </p>
    </>
  );
}
