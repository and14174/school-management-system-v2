'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button, Input, InputOTP, Label } from '@sms/ui';
import { authClient } from '../../../lib/auth-client';
import { sanitizeNextPath } from '../../../lib/safe-redirect';

type Mode = 'totp' | 'backup';

// useSearchParams() opts the subtree out of static rendering unless it is
// wrapped in Suspense, so the part of the page that reads `next` is split
// out into its own component.
export default function TwoFactorPage() {
  return (
    <React.Suspense fallback={<TwoFactorFormSkeleton />}>
      <TwoFactorForm />
    </React.Suspense>
  );
}

function TwoFactorFormSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <div className="flex size-10 items-center justify-center rounded-control bg-primary-soft text-primary-soft-fg">
          <ShieldCheck className="size-5" />
        </div>
        <h1 className="mt-3 text-xl font-semibold text-fg">Two-factor verification</h1>
      </div>
    </div>
  );
}

function TwoFactorForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  // Same override as the sign-in page - see its own comment.
  const next = sanitizeNextPath(searchParams.get('next'), '/');

  const [mode, setMode] = React.useState<Mode>('totp');
  const [code, setCode] = React.useState('');
  const [backupCode, setBackupCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const verify = React.useCallback(
    async (value: string) => {
      if (!value) return;
      setSubmitting(true);
      setError(null);

      const result =
        mode === 'totp'
          ? await authClient.twoFactor.verifyTotp({ code: value })
          : await authClient.twoFactor.verifyBackupCode({ code: value });

      if (result.error) {
        setSubmitting(false);
        setError(
          mode === 'totp'
            ? 'That code is incorrect or has expired. Please try again.'
            : 'That backup code is invalid or has already been used.',
        );
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      router.push(next as Route);
    },
    [mode, next, queryClient, router],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void verify(mode === 'totp' ? code : backupCode);
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setError(null);
    setCode('');
    setBackupCode('');
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <div className="flex size-10 items-center justify-center rounded-control bg-primary-soft text-primary-soft-fg">
          <ShieldCheck className="size-5" />
        </div>
        <h1 className="mt-3 text-xl font-semibold text-fg">Two-factor verification</h1>
        <p className="text-sm text-fg-muted">
          {mode === 'totp'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Enter one of your unused backup codes.'}
        </p>
      </div>

      {error ? (
        <Alert variant="danger">
          <AlertTitle>Verification failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        {mode === 'totp' ? (
          <div className="flex flex-col gap-2">
            <Label id="otp-label">Verification code</Label>
            <InputOTP
              length={6}
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              disabled={submitting}
              autoFocus
              invalid={Boolean(error)}
              aria-labelledby="otp-label"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="backup-code">Backup code</Label>
            <Input
              id="backup-code"
              autoComplete="one-time-code"
              placeholder="xxxxx-xxxxx"
              autoFocus
              disabled={submitting}
              aria-invalid={Boolean(error) || undefined}
              value={backupCode}
              onChange={(event) => setBackupCode(event.target.value)}
            />
          </div>
        )}

        <Button type="submit" className="w-full" loading={submitting}>
          Verify
        </Button>
      </form>

      <button
        type="button"
        onClick={() => switchMode(mode === 'totp' ? 'backup' : 'totp')}
        className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-fg-muted transition-colors duration-150 hover:text-fg"
      >
        <KeyRound className="size-3.5" />
        {mode === 'totp' ? 'Use a backup code instead' : 'Use your authenticator app instead'}
      </button>
    </div>
  );
}
