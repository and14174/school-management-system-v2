import Link from 'next/link';
import { CalendarCheck, GraduationCap, ShieldCheck, Wallet } from 'lucide-react';

/**
 * The unauthenticated shell: no sidebar, no topbar. A two-panel layout - the
 * form on one side, a quiet branded panel on the other - so sign-in reads as
 * the front door of a considered product rather than a bare form on grey.
 * The branded panel is decorative-only and collapses below `lg`, so at
 * narrow widths (375px included) the page is just the form, full width.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <div className="flex w-full flex-col justify-center px-6 py-12 sm:px-10 lg:w-1/2 lg:px-16 xl:px-24">
        <div className="mx-auto flex w-full max-w-sm flex-col">
          <Link href="/sign-in" className="mb-10 inline-flex items-center gap-2.5 self-start">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary text-fg-on-accent">
              <GraduationCap className="size-4.5" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-fg">School Management System</span>
          </Link>

          {children}
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-primary lg:flex lg:w-1/2">
        <div
          aria-hidden
          className="pointer-events-none absolute -end-24 -top-24 size-96 rounded-full border border-fg-on-accent/15"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -start-16 size-80 rounded-full border border-fg-on-accent/10"
        />

        <div className="relative z-10 flex w-full flex-col justify-center px-16 py-12">
          <p className="max-w-md text-2xl font-semibold leading-snug text-fg-on-accent">
            One calm place to run the whole school.
          </p>
          <p className="mt-3 max-w-md text-sm text-fg-on-accent/75">
            Admissions, attendance, gradebook and billing, kept in sync across every campus and
            academic year.
          </p>

          <ul className="mt-10 flex flex-col gap-4">
            <FeatureRow icon={<GraduationCap className="size-4" />} label="Enrolment & admissions" />
            <FeatureRow icon={<CalendarCheck className="size-4" />} label="Attendance & scheduling" />
            <FeatureRow icon={<Wallet className="size-4" />} label="Billing & finance" />
            <FeatureRow icon={<ShieldCheck className="size-4" />} label="Role-based access, every campus" />
          </ul>
        </div>
      </div>
    </div>
  );
}

function FeatureRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-3 text-sm text-fg-on-accent/90">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fg-on-accent/10">
        {icon}
      </span>
      {label}
    </li>
  );
}
