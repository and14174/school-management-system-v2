import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Toaster } from '@sms/ui';
import { QueryProvider } from '../components/providers/query-provider';
import { SessionProvider } from '../components/providers/session-provider';
import { ThemeProvider } from '../components/providers/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'School Management System',
  description: 'The operating system for the whole school - admin, teacher, and parent portals.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ThemeProvider>
          <QueryProvider>
            <SessionProvider>
              {children}
              <Toaster />
            </SessionProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
