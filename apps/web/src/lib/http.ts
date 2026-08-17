/**
 * Thrown by API helpers when the server responds 401. Kept distinct from a
 * plain Error so callers - in particular the global QueryCache listener in
 * QueryProvider - can single out "the session is no longer valid" from every
 * other failure mode and react by sending the user back to sign-in, instead
 * of leaving them on a screen that just silently failed to load.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Thrown by API helpers when the server responds 403 - the session is valid
 * but the permission check failed. Kept distinct from UnauthorizedError so
 * callers can render "you don't have permission" inline instead of bouncing
 * the user to sign-in, which would be both wrong and useless here.
 */
export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do this.") {
    super(message);
    this.name = 'ForbiddenError';
  }
}
