import { of, lastValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@sms/kernel';
import { FieldMaskingInterceptor } from './field-masking.interceptor.js';
import { MASK_FIELDS_RESOURCE_KEY } from './mask-fields.decorator.js';
import type { AccessContract } from '../contract.js';
import type { AppAbility } from '../application/ability.types.js';

/**
 * Guards the timing bug this interceptor shipped with: it read the ambient
 * context via `requireContext()` from an RxJS operator in the RESPONSE
 * pipeline. `TenantContextInterceptor` establishes that context with
 * `runWithContext(ctx, () => next.handle())`, which builds the Observable
 * inside the AsyncLocalStorage scope and returns before anything subscribes -
 * so by the time a value flows back through here, the scope is gone and
 * `requireContext()` throws.
 *
 * It went unnoticed for a whole milestone because no route carried
 * `@MaskFields` until the people module existed, so the branch never ran. The
 * point of this test is that the interceptor must work with NO AsyncLocalStorage
 * scope active at all - which is exactly the condition it runs under in
 * production. Do not "fix" a failure here by wrapping the call in
 * `runWithContext`; that would recreate the bug and hide it again.
 */
describe('FieldMaskingInterceptor', () => {
  const tenantContext = {
    tenantId: '00000000-0000-7000-8000-000000000001',
    userId: '00000000-0000-7000-8000-0000000000aa',
    roles: [],
    requestId: 'test',
  } as unknown as TenantContext;

  function makeContext(request: Record<string, unknown>, handlerMeta?: string) {
    const handler = () => undefined;
    if (handlerMeta) {
      Reflect.defineMetadata(MASK_FIELDS_RESOURCE_KEY, handlerMeta, handler);
    }
    return {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  function makeAccess(can: (action: string, resource: string) => boolean): AccessContract {
    const ability = { can } as unknown as AppAbility;
    return { compileAbility: vi.fn().mockResolvedValue(ability) } as unknown as AccessContract;
  }

  const record = {
    id: 'p1',
    givenName: 'Sara',
    hasMedicalAlerts: true,
    hasSafeguardingAlerts: true,
  };

  it('masks fields the caller lacks permission for, with no ALS scope active', async () => {
    const interceptor = new FieldMaskingInterceptor(
      makeAccess((action) => action !== 'read_medical' && action !== 'read_safeguarding'),
    );

    const result = (await lastValueFrom(
      interceptor.intercept(makeContext({ tenantContext }, 'people.person'), {
        handle: () => of(record),
      } as never),
    )) as Record<string, unknown>;

    expect(result.givenName).toBe('Sara');
    expect('hasMedicalAlerts' in result).toBe(false);
    expect('hasSafeguardingAlerts' in result).toBe(false);
  });

  it('keeps fields the caller is permitted to see', async () => {
    const interceptor = new FieldMaskingInterceptor(makeAccess(() => true));

    const result = (await lastValueFrom(
      interceptor.intercept(makeContext({ tenantContext }, 'people.person'), {
        handle: () => of(record),
      } as never),
    )) as Record<string, unknown>;

    expect(result.hasMedicalAlerts).toBe(true);
    expect(result.hasSafeguardingAlerts).toBe(true);
  });

  it('passes undecorated routes straight through', async () => {
    const interceptor = new FieldMaskingInterceptor(makeAccess(() => false));

    const result = await lastValueFrom(
      interceptor.intercept(makeContext({ tenantContext }), { handle: () => of(record) } as never),
    );

    expect(result).toBe(record);
  });

  it('does not throw when the request carries no resolved context', async () => {
    const interceptor = new FieldMaskingInterceptor(makeAccess(() => true));

    const result = await lastValueFrom(
      interceptor.intercept(makeContext({}, 'people.person'), { handle: () => of(record) } as never),
    );

    expect(result).toEqual(record);
  });
});
