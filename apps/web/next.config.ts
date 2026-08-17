import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sms/ui'],
  typedRoutes: true,
  // Don't let `next dev` write AGENTS.md/CLAUDE.md into the app directory.
  agentRules: false,
  // The dev overlay badge is pinned bottom-start, directly over the sidebar's
  // collapse control. Off, so the real UI is what gets reviewed.
  devIndicators: false,
};

export default nextConfig;
