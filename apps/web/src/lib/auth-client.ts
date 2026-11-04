import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { API_URL, ApiUnreachableError } from './api';

/**
 * Better Auth is mounted at {API origin}/api/v1/auth. `credentials: 'include'`
 * is required on every request so the session cookie travels cross-origin
 * between the web app (port 3000 in dev) and the API (port 3333).
 */
// Better Auth's client rejects a relative baseURL, so behind the same-origin
// proxy (API_URL is '') it uses the page's own origin. The server-render
// placeholder is never requested - auth calls only happen in the browser.
const authOrigin = API_URL || (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
export const AUTH_BASE_URL = `${authOrigin}/api/v1/auth`;

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [twoFactorClient()],
});

/**
 * A sign-in response that still needs a second factor comes back from Better
 * Auth as `{ twoFactorRedirect: true, twoFactorMethods: [...] }` instead of a
 * completed session. Narrow the response data down to that shape so call
 * sites can branch on it without a full page reload.
 */
export function isTwoFactorRedirect(data: unknown): data is { twoFactorRedirect: true } {
  return (
    Boolean(data) &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).twoFactorRedirect === true
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthTenant {
  id: string;
  name: string;
  slug: string;
}

export interface AuthMembership {
  tenantId: string;
  tenantName: string;
  status: string;
}

export interface AuthMeResponse {
  user: AuthUser;
  activeTenant: AuthTenant | null;
  memberships: AuthMembership[];
  twoFactorEnabled: boolean;
}

/**
 * Fetches the current session. Resolves to `null` for an unauthenticated
 * caller (HTTP 401) rather than throwing - that is the expected, common
 * state on every public page, not an error condition. Any other failure
 * (API unreachable, 5xx, malformed body) throws so callers can render a
 * degraded state instead of silently treating it as "signed out".
 */
export async function fetchMe(signal?: AbortSignal): Promise<AuthMeResponse | null> {
  let response: Response;
  try {
    response = await fetch(`${AUTH_BASE_URL}/me`, {
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Could not load the current session (HTTP ${response.status}).`);
  }

  return (await response.json()) as AuthMeResponse;
}
