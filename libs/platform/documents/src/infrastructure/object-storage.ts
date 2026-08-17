import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStoragePutInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * A small port so a test can swap in something other than real S3/MinIO if
 * it ever needs to - see the module report on why the real suite here uses
 * the actual `S3ObjectStorage` below against the locally-running MinIO
 * (`.env.example`'s `S3_*` vars) instead: it was reachable, so faking it
 * would have proven less than the real thing does.
 */
export interface ObjectStorage {
  put(input: ObjectStoragePutInput): Promise<void>;

  /** A time-limited URL a client can download directly - PDFs never proxy through the API. */
  presignedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env before using @sms/documents' S3ObjectStorage.`);
  }
  return value;
}

let cachedClient: S3Client | undefined;
let cachedBucket: string | undefined;

/** Lazily built, reused across calls - same one-client-per-process shape as `@sms/db`'s `getAppSqlClient`. */
function getClient(): { client: S3Client; bucket: string } {
  if (!cachedClient || !cachedBucket) {
    cachedClient = new S3Client({
      endpoint: requireEnv('S3_ENDPOINT'),
      region: requireEnv('S3_REGION'),
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false').toLowerCase() === 'true',
      credentials: {
        accessKeyId: requireEnv('S3_ACCESS_KEY'),
        secretAccessKey: requireEnv('S3_SECRET_KEY'),
      },
    });
    cachedBucket = requireEnv('S3_BUCKET');
  }
  return { client: cachedClient, bucket: cachedBucket };
}

/**
 * The real implementation, wired in both `apps/api` (via `DocumentsModule`)
 * and this module's own testcontainers suite - MinIO runs locally
 * (`docker ps` shows `sms-minio-1`) and is reachable from the test process,
 * so the suite exercises actual S3 `PutObject` + presigned `GetObject` calls
 * rather than a fake.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  async put(input: ObjectStoragePutInput): Promise<void> {
    const { client, bucket } = getClient();
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentType: input.contentType }),
    );
  }

  async presignedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { client, bucket } = getClient();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}
