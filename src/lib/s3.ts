import '../env.js';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const endpoint = requireEnv('S3_ENDPOINT');
const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
export const ATTACHMENTS_BUCKET = requireEnv('S3_BUCKET');
const region = process.env.S3_REGION ?? 'us-east-1';

// forcePathStyle is required for S3-compatible stores like SeaweedFS: they
// don't support the AWS-style virtual-hosted bucket subdomain
// (bucket.endpoint.com), only path-style (endpoint.com/bucket).
//
// requestChecksumCalculation: 'WHEN_REQUIRED' turns off the SDK v3 default
// of always attaching a flexible checksum (x-amz-checksum-crc32) to PutObject
// requests. For a *presigned* PutObject that checksum gets computed over an
// empty body (the SDK doesn't have the real bytes yet at signing time) and
// baked into the signed URL's query string — so the actual upload's real
// checksum then mismatches it and SeaweedFS (and real S3) reject the PUT
// with BadDigest. Direct SDK calls are unaffected either way.
export const s3Client = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: { accessKeyId, secretAccessKey },
});

/**
 * Idempotently creates the attachments bucket if it doesn't already exist.
 * Called once at app startup (see src/index.ts) rather than per-request —
 * bucket creation is a one-time operational concern, not something that
 * should race against or block the request path.
 */
export async function ensureBucketExists(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: ATTACHMENTS_BUCKET }));
    return;
  } catch {
    // Falls through to create — HeadBucket fails for both "doesn't exist"
    // and transient errors, so we just attempt creation and let a genuine
    // connectivity problem surface from CreateBucket itself.
  }

  try {
    await s3Client.send(new CreateBucketCommand({ Bucket: ATTACHMENTS_BUCKET }));
    logger.info({ bucket: ATTACHMENTS_BUCKET }, 'created attachments bucket');
  } catch (error) {
    const code = (error as { name?: string })?.name;
    if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists') {
      return;
    }
    throw error;
  }
}

/**
 * Returns a presigned PUT URL the client uploads directly to — the app
 * never proxies file bytes through itself. Signing is a local HMAC
 * computation (no network round-trip), so this is cheap to call inline.
 */
export function createPresignedUploadUrl(
  storageKey: string,
  contentType: string,
  expiresInSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: ATTACHMENTS_BUCKET,
    Key: storageKey,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Server-side verification that an object actually landed in storage —
 * used by the commit step so a client can never just claim a size without
 * having uploaded the bytes. Returns null if the object isn't there.
 */
export async function headObject(storageKey: string): Promise<{ sizeBytes: number } | null> {
  try {
    const result = await s3Client.send(new HeadObjectCommand({ Bucket: ATTACHMENTS_BUCKET, Key: storageKey }));
    return { sizeBytes: result.ContentLength ?? 0 };
  } catch (error) {
    if (error instanceof NotFound || (error as { name?: string })?.name === 'NotFound') {
      return null;
    }
    throw error;
  }
}

/**
 * Best-effort delete: called after the DB row is already gone (see
 * attachmentService.deleteAttachment), so a failure here just leaves an
 * orphaned object in storage rather than an inconsistent DB/storage state.
 * Logged, not thrown, for that reason.
 */
export async function deleteObject(storageKey: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: ATTACHMENTS_BUCKET, Key: storageKey }));
  } catch (error) {
    logger.error({ storageKey, err: error }, 'failed to delete attachment object from storage');
  }
}
