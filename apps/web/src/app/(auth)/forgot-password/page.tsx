'use client';

import * as React from 'react';
import Link from 'next/link';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { Button, Input, Label } from '@sms/ui';
import { authClient } from '../../../lib/auth-client';

const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address'),
});

type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = async (values: ForgotPasswordValues) => {
    try {
      await authClient.requestPasswordReset({
        email: values.email,
        redirectTo: '/reset-password',
      });
    } catch {
      // Swallowed deliberately: the confirmation below is neutral regardless
      // of outcome, so the response never reveals whether the address is
      // registered - nor does a network hiccup leak that distinction either.
    } finally {
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex size-10 items-center justify-center rounded-control bg-success-soft text-success">
          <MailCheck className="size-5" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-fg">Check your email</h1>
          <p className="text-sm text-fg-muted">
            If that email is registered, we&apos;ve sent a link to reset your password. It may take
            a few minutes to arrive.
          </p>
        </div>
        <Link
          href="/sign-in"
          className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary transition-colors duration-150 hover:text-primary-hover"
        >
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold text-fg">Forgot your password?</h1>
        <p className="text-sm text-fg-muted">
          Enter the email you sign in with and we&apos;ll send you a link to reset it.
        </p>
      </div>

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

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Send reset link
        </Button>
      </form>

      <Link
        href="/sign-in"
        className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-fg-muted transition-colors duration-150 hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        Back to sign in
      </Link>
    </div>
  );
}
