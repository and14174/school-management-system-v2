import { createZodDto } from 'nestjs-zod';
import { mintApiKeySchema, revokeApiKeySchema } from '../../application/schemas.js';

/** Validated by an explicit `new ZodValidationPipe(...)` per param - see `ApiKeysController`. */
export class MintApiKeyDto extends createZodDto(mintApiKeySchema) {}
export class RevokeApiKeyDto extends createZodDto(revokeApiKeySchema) {}
