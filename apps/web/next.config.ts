import type { NextConfig } from 'next';

// Deployed (Vercel): API_ORIGIN is the API's own origin, and every /api/v1
// request is proxied through this app. The browser only ever talks to the web
// origin, so the Better Auth session cookie is first-party - browsers that
// block cross-site cookies (Safari, Firefox strict) would otherwise drop it.
// Local dev leaves API_ORIGIN unset and calls the API directly on :3333.
const apiOrigin = process.env.API_ORIGIN?.replace(/\/+$/, '');

const nextConfig: NextConfig = {
  transpilePackages: ['@sms/ui'],
  typedRoutes: true,
  // Don't let `next dev` write AGENTS.md/CLAUDE.md into the app directory.
  agentRules: false,
  // The dev overlay badge is pinned bottom-start, directly over the sidebar's
  // collapse control. Off, so the real UI is what gets reviewed.
  devIndicators: false,
  ...(apiOrigin && {
    // An empty API_URL makes every client call same-origin (see lib/api.ts).
    env: { NEXT_PUBLIC_API_URL: '' },
    async rewrites() {
      return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
    },
  }),
};

export default nextConfig;
