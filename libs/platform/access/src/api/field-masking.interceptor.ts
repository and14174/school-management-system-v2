import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, mergeMap, type Observable } from 'rxjs';
import { isSystemContext, type ExecutionContext as KernelExecutionContext } from '@sms/kernel';
import { fieldRegistryFor } from '../domain/field-registry.js';
import { ACCESS_CONTRACT, type AccessContract } from '../contract.js';
import type { AppAbility } from '../application/ability.types.js';
import { MASK_FIELDS_RESOURCE_KEY } from './mask-fields.decorator.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips a single record's fields the caller's ability does not grant.
 * Exported (not just used internally by the interceptor) so `access.spec.ts`
 * can exercise the masking rule directly, against a real compiled ability,
 * without having to construct a full Nest `ExecutionContext`/`CallHandler`.
 *
 * Sensitive fields are their own permissions, not a mask/deny-list column -
 * see the `0400` migration header and `domain/field-registry.ts`. This is
 * the enforcement point: a field with no registry entry for `resource` is
 * never touched (returned as-is), which is exactly why every sensitive
 * field MUST be registered the moment it is added, not left for this
 * function to "remember" to hide.
 */
export function maskFields<T extends Record<string, unknown>>(record: T, resource: string, ability: AppAbility): T {
  const entries = fieldRegistryFor(resource);
  if (entries.length === 0) {
    return record;
  }

  let result: Record<string, unknown> = record;
  let cloned = false;
  for (const entry of entries) {
    if (!(entry.field in result)) {
      continue;
    }
    const separatorIndex = entry.requiredPermission.lastIndexOf(':');
    const permResource = entry.requiredPermission.slice(0, separatorIndex);
    const permAction = entry.requiredPermission.slice(separatorIndex + 1);
    if (!ability.can(permAction, permResource)) {
      if (!cloned) {
        result = { ...record };
        cloned = true;
      }
      delete result[entry.field];
    }
  }
  return result as T;
}

/** Applies `maskFields` to a single object, an array of objects, or leaves anything else (primitives, `null`) untouched. */
export function maskResponse(data: unknown, resource: string, ability: AppAbility): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => (isPlainRecord(item) ? maskFields(item, resource, ability) : item));
  }
  if (isPlainRecord(data)) {
    return maskFields(data, resource, ability);
  }
  return data;
}

/**
 * Applied globally (`APP_INTERCEPTOR` in `apps/api`'s `AppModule`), registered
 * after `TenantContextInterceptor`, which stashes the resolved context on the
 * request for this interceptor to read. It does NOT use AsyncLocalStorage - see
 * the comment in `intercept()` for why that does not survive into the response
 * pipeline.
 *
 * A route response is only masked if its handler (or controller) carries
 * `@MaskFields(resource)` - undecorated routes (the overwhelming majority
 * today, since the resources this masks - `people.student` et al - don't
 * exist as real endpoints until M2) pass straight through with zero
 * overhead.
 */
@Injectable()
export class FieldMaskingInterceptor implements NestInterceptor {
  constructor(@Inject(ACCESS_CONTRACT) private readonly access: AccessContract) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource =
      (Reflect.getMetadata(MASK_FIELDS_RESOURCE_KEY, context.getHandler()) as string | undefined) ??
      (Reflect.getMetadata(MASK_FIELDS_RESOURCE_KEY, context.getClass()) as string | undefined);
    if (!resource) {
      return next.handle();
    }

    // Read the context off the REQUEST, not AsyncLocalStorage.
    //
    // TenantContextInterceptor establishes the ambient context with
    // `runWithContext(ctx, () => next.handle())`. That call builds the response
    // Observable inside the ALS scope but does not subscribe to it - emission
    // happens later, after runWithContext has already returned, so anything
    // downstream that reads the context when a value flows through sees
    // nothing. `requireContext()` here does not fall back, it THROWS, so every
    // masked route would 500 - and because no route carried @MaskFields until
    // the people module existed, this path had never once been executed.
    const request = context.switchToHttp().getRequest<{ tenantContext?: KernelExecutionContext }>();
    const ctx = request.tenantContext;

    return next.handle().pipe(mergeMap((data) => from(this.mask(resource, ctx, data))));
  }

  private async mask(
    resource: string,
    ctx: KernelExecutionContext | undefined,
    data: unknown,
  ): Promise<unknown> {
    if (!ctx || isSystemContext(ctx) || !ctx.userId) {
      // Nothing to mask against - a system/unauthenticated call has no
      // ability to check fields against, so it sees the unmasked response.
      // Every real HTTP request has an ambient TenantContext with userId by
      // the time this interceptor runs (see AuthGuard/TenantContextInterceptor);
      // this branch only matters for non-request callers exercising the
      // interceptor directly.
      return data;
    }
    const ability = await this.access.compileAbility(ctx.userId, ctx.tenantId);
    return maskResponse(data, resource, ability);
  }
}
