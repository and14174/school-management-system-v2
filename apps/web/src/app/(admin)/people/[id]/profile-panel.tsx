import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@sms/ui';
import type { Person } from '../../../../lib/api';
import { formatCustomFieldValue, formatDateOnly, humanizeFieldKey } from '../format';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-fg-subtle">{label}</dt>
      <dd className="text-sm text-fg">{value}</dd>
    </div>
  );
}

export function ProfilePanel({ person }: { person: Person }) {
  const customFieldEntries = Object.entries(person.customFields);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Given name" value={person.givenName} />
            <Field label="Family name" value={person.familyName} />
            <Field label="Preferred name" value={person.preferredName || '—'} />
            <Field
              label="Date of birth"
              value={person.dateOfBirth ? formatDateOnly(person.dateOfBirth) : '—'}
            />
            <Field label="Gender" value={person.gender || '—'} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom fields</CardTitle>
        </CardHeader>
        <CardContent>
          {customFieldEntries.length === 0 ? (
            <EmptyState title="No custom fields recorded" description="Nothing has been entered for this person yet." />
          ) : (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {customFieldEntries.map(([key, value]) => (
                <Field key={key} label={humanizeFieldKey(key)} value={formatCustomFieldValue(value)} />
              ))}
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
