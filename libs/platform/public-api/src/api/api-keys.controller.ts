import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { PUBLIC_API_CONTRACT, type PublicApiContract } from '../contract.js';
import { MintApiKeyDto, RevokeApiKeyDto } from './dto/api-keys.dto.js';

/**
 * `api/v1/public-api/keys/*` - mint/list/read/revoke machine API keys.
 * Gated by the real `api.key:read`/`api.key:manage` catalogue permissions
 * (already granted to School Administrator - see the task this module was
 * built against), reached the ordinary way through a human's cookie
 * session; a key that itself holds `api.key:manage` can also reach these
 * routes (nothing here special-cases that), but minting/revoking keys via a
 * key is not the expected path.
 *
 * Every response shape here is `ApiKeySummary`/`MintedApiKey` - never the
 * raw table row - so `key_hash` can never leak through this controller even
 * by accident (there is no field to forget to strip).
 */
@ApiTags('public-api')
@Controller('public-api/keys')
export class ApiKeysController {
  constructor(@Inject(PUBLIC_API_CONTRACT) private readonly keys: PublicApiContract) {}

  @RequirePermission('api.key:read')
  @Get()
  list() {
    return this.keys.list();
  }

  @RequirePermission('api.key:read')
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.keys.get(id));
  }

  @RequirePermission('api.key:manage')
  @Post()
  async mint(@Body(new ZodValidationPipe(MintApiKeyDto)) body: MintApiKeyDto) {
    return unwrap(
      await this.keys.mint({
        name: body.name,
        grantedPermissions: body.grantedPermissions,
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
        ...(body.neverExpires !== undefined ? { neverExpires: body.neverExpires } : {}),
      }),
    );
  }

  @RequirePermission('api.key:manage')
  @Post(':id/revoke')
  async revoke(@Param('id') id: string, @Body(new ZodValidationPipe(RevokeApiKeyDto)) body: RevokeApiKeyDto) {
    unwrap(await this.keys.revoke({ id, reason: body.reason }));
    return { revoked: true };
  }
}
