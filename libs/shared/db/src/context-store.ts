import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from '@sms/kernel';

const storage = new AsyncLocalStorage<ExecutionContext>();

/** Runs `fn` with `context` available to `getContext()` / `requireContext()` for its entire call tree. */
export function runWithContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Returns the current execution context, or `undefined` if none is set. */
export function getContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/** Returns the current execution context, throwing if none is set (a bug: every request must set one). */
export function requireContext(): ExecutionContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'No execution context is set. Did you forget runWithContext() (the tenant-context interceptor sets this for every HTTP request)?',
    );
  }
  return context;
}
