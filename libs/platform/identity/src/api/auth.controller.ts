import { Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { TenantId } from '@sms/kernel';
import { TENANCY_CONTRACT, type TenancyContract } from '@sms/tenancy';
import { IDENTITY_CONTRACT, type IdentityContract } from '../contract.js';
import { SetActiveTenantDto } from './dto/set-active-tenant.dto.js';

/**
 * This module's own endpoints, alongside (not instead of) Better Auth's own
 * routes mounted directly on Fastify at `/api/v1/auth/*` (see
 * `mount-auth-handler.ts`) - Fastify's router prefers a static route like
 * `/api/v1/auth/me` over that wildcard regardless of registration order, so
 * both coexist. Gated by the global `AuthGuard` like any other controller
 * (not `@Public()`): both endpoints need a real session, they just don't
 * need a *resolved tenant* one (`GET /me` reports whether there is one;
 * `POST /set-active-tenant` is how a multi-membership session gets one).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(IDENTITY_CONTRACT) private readonly identity: IdentityContract,
    @Inject(TENANCY_CONTRACT) private readonly tenancy: TenancyContract,
  ) {}

  @Get('me')
  async me(@Req() request: FastifyRequest) {
    const session = await this.identity.getSession(fromNodeHeaders(request.headers));
    if (!session) {
      throw new UnauthorizedException('No valid session.');
    }

    const [memberships, activeTenantResult] = await Promise.all([
      this.identity.listMemberships(session.user.id),
      session.activeTenantId ? this.tenancy.getTenant(session.activeTenantId) : Promise.resolve(null),
    ]);

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
      activeTenant:
        activeTenantResult && activeTenantResult.ok
          ? { id: activeTenantResult.value.id, name: activeTenantResult.value.name, slug: activeTenantResult.value.slug }
          : null,
      memberships: memberships.map((membership) => ({
        id: membership.id,
        tenantId: membership.tenantId,
        status: membership.status,
      })),
      twoFactorEnabled: session.user.twoFactorEnabled,
    };
  }

  // `new ZodValidationPipe(SetActiveTenantDto)` explicitly, rather than
  // relying on the global pipe's metatype auto-detection - see
  // @sms/tenancy's CampusesController for why (esbuild/tsx's
  // emitDecoratorMetadata output is not reliable enough here to trust for
  // picking the right DTO).
  @Post('set-active-tenant')
  @HttpCode(200)
  async setActiveTenant(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(SetActiveTenantDto)) body: SetActiveTenantDto,
  ) {
    const session = await this.identity.getSession(fromNodeHeaders(request.headers));
    if (!session) {
      throw new UnauthorizedException('No valid session.');
    }

    const result = await this.identity.setActiveTenant(session.sessionToken, body.tenantId as TenantId);
    if (!result.ok) {
      throw result.error;
    }
    return { ok: true };
  }
}
