'use client';

import { useQuery } from '@tanstack/react-query';
import { Lock, ShieldAlert, WifiOff } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@sms/ui';
import { fetchPersonAlerts, type AlertSeverity, type PersonAlert, type PersonDetail } from '../../../../lib/api';
import { ALERT_SEVERITY_LABELS, formatDateOnly } from '../format';

const SEVERITY_BADGE_VARIANT: Record<AlertSeverity, 'info' | 'warning' | 'danger'> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
};

function AlertCard({ alert }: { alert: PersonAlert }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-border p-3">
      <div className="flex items-center gap-2">
        <Badge variant={SEVERITY_BADGE_VARIANT[alert.severity]}>{ALERT_SEVERITY_LABELS[alert.severity]}</Badge>
        <span className="text-xs text-fg-subtle">Since {formatDateOnly(alert.validFrom)}</span>
      </div>
      <p className="text-sm font-medium text-fg">{alert.summary}</p>
      {alert.detail ? <p className="text-sm text-fg-muted">{alert.detail}</p> : null}
    </div>
  );
}

/**
 * Restricted section (medical or safeguarding). `person.hasMedicalAlerts` /
 * `hasSafeguardingAlerts` come back from `GET /people/:id` field-masked:
 * ABSENT (not `false`) when the caller lacks the matching permission - see
 * `PersonDetail`'s own doc comment. That is the one signal that can tell
 * "known: none" apart from "unknown: hidden", so it - not an empty
 * `alerts` array - decides what this section renders. Rendering "No alerts
 * on file" for a masked flag would tell a nurse a child has no allergies
 * when the truth is simply that this caller cannot see the answer.
 */
function RestrictedAlertSection({
  title,
  requiredPermission,
  hasFlag,
  alerts,
}: {
  title: string;
  requiredPermission: string;
  hasFlag: boolean | undefined;
  alerts: PersonAlert[];
}) {
  if (hasFlag === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <Alert variant="warning" icon={<Lock className="mt-0.5 size-4 shrink-0 text-warning" />}>
          <AlertTitle>You don&apos;t have permission to view this</AlertTitle>
          <AlertDescription>
            Viewing {title.toLowerCase()} alerts requires the {requiredPermission} permission. This is not a
            statement that none exist.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {alerts.length === 0 ? (
        <p className="text-sm text-fg-muted">No {title.toLowerCase()} alerts on file.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AlertsPanel({ person }: { person: PersonDetail }) {
  const alertsQuery = useQuery({
    queryKey: ['people', 'alerts', person.id],
    queryFn: ({ signal }) => fetchPersonAlerts(person.id, signal),
  });

  if (alertsQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 2 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (alertsQuery.isError) {
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load alerts"
        description={alertsQuery.error.message}
      />
    );
  }

  // The LIST endpoint already row-filters medical/safeguarding rows by the
  // caller's ability (see AlertService.listAlerts) - safe to render every row
  // present here as-is. Only 'access'/'other' rows are never masked.
  const allAlerts = alertsQuery.data;
  const medicalAlerts = allAlerts.filter((alert) => alert.category === 'medical');
  const safeguardingAlerts = allAlerts.filter((alert) => alert.category === 'safeguarding');
  const otherAlerts = allAlerts.filter((alert) => alert.category === 'access' || alert.category === 'other');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-fg-subtle" />
          Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <RestrictedAlertSection
          title="Medical"
          requiredPermission="people.student:read_medical"
          hasFlag={person.hasMedicalAlerts}
          alerts={medicalAlerts}
        />
        <RestrictedAlertSection
          title="Safeguarding"
          requiredPermission="people.student:read_safeguarding"
          hasFlag={person.hasSafeguardingAlerts}
          alerts={safeguardingAlerts}
        />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">Other</h3>
          {otherAlerts.length === 0 ? (
            <p className="text-sm text-fg-muted">No other alerts on file.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {otherAlerts.map((alert) => (
                <AlertCard key={alert.id} alert={alert} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
