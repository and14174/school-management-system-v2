'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle, Button, Input, Label } from '@sms/ui';
import { authClient, isTwoFactorRedirect } from '../../../lib/auth-client';
import { sanitizeNextPath } from '../../../lib/safe-redirect';

const signInSchema = z.object({
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

type SignInValues = z.infer<typeof signInSchema>;

interface FormError {
  title: string;
  description: string;
}

// useSearchParams() opts the subtree out of static rendering unless it is
// wrapped in Suspense, so the part of the page that reads `next` is split
// out into its own component.
export default function SignInPage() {
  return (
    <React.Suspense fallback={<SignInFormSkeleton />}>
      <SignInForm />
    </React.Suspense>
  );
}

function SignInFormSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold text-fg">Welcome back</h1>
        <p className="text-sm text-fg-muted">Sign in to your school workspace.</p>
      </div>
    </div>
  );
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  // Default fallback overridden to '/' (not `sanitizeNextPath`'s own
  // '/dashboard' default) - the root page is what now decides staff vs.
  // portal destination by real capability (see apps/web/src/app/page.tsx),
  // so a plain sign-in with no explicit `next` must go through it rather
  // than assuming every account is staff.
  const next = sanitizeNextPath(searchParams.get('next'), '/');

  const [formError, setFormError] = React.useState<FormError | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({ resolver: zodResolver(signInSchema) });

  const onSubmit = async (values: SignInValues) => {
    setFormError(null);

    const result = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (result.error) {
      const status = result.error.status;
      // Never reveal whether the email exists - every credential failure
      // (unknown user, wrong password, unverified account) reads the same.
      // Only a missing/5xx status gets a different, honest message.
      setFormError(
        !status || status >= 500
          ? {
              title: "Can't reach the server",
              description: 'The service is unreachable right now. Please try again in a moment.',
            }
          : {
              title: "Couldn't sign you in",
              description: 'Incorrect email or password. Please try again.',
            },
      );
      return;
    }

    if (isTwoFactorRedirect(result.data)) {
      router.push(`/two-factor?next=${encodeURIComponent(next)}` as Route);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    router.push(next as Route);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold text-fg">Welcome back</h1>
        <p className="text-sm text-fg-muted">Sign in to your school workspace.</p>
      </div>

      {formError ? (
        <Alert variant="danger">
          <AlertTitle>{formError.title}</AlertTitle>
          <AlertDescription>{formError.description}</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@school.edu"
            aria-invalid={Boolean(errors.email) || undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...register('email')}
          />
          {errors.email ? (
            <p id="email-error" className="text-xs text-danger">
              {errors.email.message}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-primary transition-colors duration-150 hover:text-primary-hover"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password) || undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
          />
          {errors.password ? (
            <p id="password-error" className="text-xs text-danger">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="mt-1 w-full" loading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
