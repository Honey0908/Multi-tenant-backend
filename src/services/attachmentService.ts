import { randomUUID } from 'node:crypto';
import { tenantDb, withOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import type { Attachment, Prisma } from '../generated/prisma/client.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { createPresignedUploadUrl, headObject, deleteObject } from '../lib/s3.js';
import { NotFoundError, ConflictError, PayloadTooLargeError } from '../lib/errors.js';
import { serializeAttachment } from '../lib/serialize.js';
import { getIssue } from './issueService.js';
import type { ReserveAttachmentInput } from '../validators/attachment.js';

const RESERVATION_TTL_SECONDS = Number(process.env.ATTACHMENT_RESERVATION_TTL_MINUTES ?? '15') * 60;
const MAX_FILE_SIZE_BYTES = Number(process.env.ATTACHMENT_MAX_FILE_SIZE_MB ?? '200') * 1024 * 1024;

function buildStorageKey(orgId: string, issueId: string, attachmentId: string, fileName: string): string {
  // Sanitized, not trusted verbatim: the validator already rejects path
  // separators, but this also strips anything else that could be
  // surprising in an S3 object key.
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `attachments/${orgId}/${issueId}/${attachmentId}/${sanitized}`;
}

/**
 * Finds RESERVED attachments for `orgId` whose reservation TTL has lapsed
 * without a commit, releases their claimed storage bytes, and marks them
 * EXPIRED. Run at the start of every reserve so an abandoned upload (client
 * got a presigned URL and never used it) doesn't permanently eat into the
 * org's storage quota — there's no background job runner in this app, so
 * the sweep piggybacks on the one code path guaranteed to run regularly.
 */
async function releaseExpiredReservations(tx: Prisma.TransactionClient, orgId: string) {
  const expired = await tx.attachment.findMany({
    where: { organisation_id: orgId, status: 'RESERVED', expires_at: { lt: new Date() } },
    select: { id: true, size_bytes: true },
  });
  if (expired.length === 0) {
    return;
  }

  const totalBytes = expired.reduce((sum, a) => sum + a.size_bytes, 0n);
  await tx.attachment.updateMany({
    where: { id: { in: expired.map((a) => a.id) } },
    data: { status: 'EXPIRED', expires_at: null },
  });
  await releaseUsage(tx, orgId, ResourceType.STORAGE_BYTES, totalBytes);
}

/**
 * Reserves storage quota for an upload and hands back a presigned PUT URL.
 * The client uploads bytes directly to SeaweedFS — the app never proxies
 * file contents. The reservation must be finalized via commitAttachment
 * within RESERVATION_TTL_SECONDS or it's swept and its quota released.
 */
export async function reserveAttachment(projectId: string, issueId: string, input: ReserveAttachmentInput) {
  await getIssue(projectId, issueId);
  const { orgId, userId } = getTenantContext();

  if (input.sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new PayloadTooLargeError(
      `File size ${input.sizeBytes} bytes exceeds the maximum allowed upload size of ${MAX_FILE_SIZE_BYTES} bytes`,
    );
  }

  const attachmentId = randomUUID();
  const storageKey = buildStorageKey(orgId, issueId, attachmentId, input.fileName);
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_SECONDS * 1000);

  const attachment = await withOrgContext(orgId, async (tx) => {
    await releaseExpiredReservations(tx, orgId);

    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    await claimUsage(tx, orgId, ResourceType.STORAGE_BYTES, organisation.plan.name, BigInt(input.sizeBytes));

    return tx.attachment.create({
      data: {
        id: attachmentId,
        organisation_id: orgId,
        issue_id: issueId,
        uploaded_by: userId,
        file_name: input.fileName,
        content_type: input.contentType,
        size_bytes: BigInt(input.sizeBytes),
        storage_key: storageKey,
        status: 'RESERVED',
        expires_at: expiresAt,
      },
    });
  });

  // Presigning is a local HMAC computation, not a network round-trip — safe
  // to do after the transaction commits, keeping the transaction itself
  // free of any I/O beyond Postgres.
  const uploadUrl = await createPresignedUploadUrl(storageKey, input.contentType, RESERVATION_TTL_SECONDS);

  return { attachment: serializeAttachment(attachment), uploadUrl };
}

type CommitResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_status'; status: string }
  | { kind: 'expired' }
  | { kind: 'not_uploaded' }
  | { kind: 'quota_exceeded'; storageKey: string; message: string }
  | { kind: 'committed'; attachment: Attachment };

/**
 * Verifies the reserved object actually landed in storage (server-side
 * HeadObject — a client can never just claim a size) and flips the
 * reservation to COMMITTED. If the real size differs from what was
 * reserved, reconciles the storage-quota claim to match: claims the
 * difference if larger (rejecting the commit and deleting the orphaned
 * object if that would exceed the plan's quota), or releases it if smaller.
 */
export async function commitAttachment(projectId: string, issueId: string, attachmentId: string) {
  await getIssue(projectId, issueId);
  const { orgId } = getTenantContext();

  const result = await withOrgContext(orgId, async (tx): Promise<CommitResult> => {
    // FOR UPDATE: serializes two concurrent commit attempts on the same
    // reservation (e.g. a retried request) so only one reconciles the quota.
    const rows = await tx.$queryRaw<Array<{ size_bytes: bigint; status: string; storage_key: string; expires_at: Date | null }>>`
      SELECT size_bytes, status, storage_key, expires_at FROM "Attachment"
      WHERE id = ${attachmentId}::uuid AND organisation_id = ${orgId}::uuid AND issue_id = ${issueId}::uuid
      FOR UPDATE
    `;
    if (rows.length === 0) {
      return { kind: 'not_found' };
    }

    const current = rows[0]!;
    if (current.status !== 'RESERVED') {
      return { kind: 'invalid_status', status: current.status };
    }

    if (current.expires_at && current.expires_at.getTime() < Date.now()) {
      await releaseUsage(tx, orgId, ResourceType.STORAGE_BYTES, current.size_bytes);
      await tx.attachment.update({ where: { id: attachmentId }, data: { status: 'EXPIRED', expires_at: null } });
      return { kind: 'expired' };
    }

    const head = await headObject(current.storage_key);
    if (!head) {
      return { kind: 'not_uploaded' };
    }

    const actualBytes = BigInt(head.sizeBytes);
    const diff = actualBytes - current.size_bytes;

    if (diff > 0n) {
      const organisation = await tx.organisation.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });
      try {
        await claimUsage(tx, orgId, ResourceType.STORAGE_BYTES, organisation.plan.name, diff);
      } catch (error) {
        if (error instanceof ConflictError) {
          await tx.attachment.update({ where: { id: attachmentId }, data: { status: 'EXPIRED', expires_at: null } });
          return { kind: 'quota_exceeded', storageKey: current.storage_key, message: error.message };
        }
        throw error;
      }
    } else if (diff < 0n) {
      await releaseUsage(tx, orgId, ResourceType.STORAGE_BYTES, -diff);
    }

    const updated = await tx.attachment.update({
      where: { id: attachmentId },
      data: { status: 'COMMITTED', size_bytes: actualBytes, expires_at: null },
    });
    return { kind: 'committed', attachment: updated };
  });

  switch (result.kind) {
    case 'not_found':
      throw new NotFoundError(`Attachment ${attachmentId} not found`);
    case 'invalid_status':
      throw new ConflictError(`Attachment is not awaiting upload (status: ${result.status})`);
    case 'expired':
      throw new ConflictError('Attachment reservation expired before the upload was committed; reserve again');
    case 'not_uploaded':
      throw new ConflictError('No file has been uploaded to the reserved location yet');
    case 'quota_exceeded':
      // The transaction above already committed the EXPIRED status change
      // and released the claim it briefly attempted — only the storage
      // side-effect (deleting the orphaned object) remains, done here
      // outside the DB transaction since it's a network call, not a query.
      await deleteObject(result.storageKey);
      throw new ConflictError(result.message);
    case 'committed':
      return serializeAttachment(result.attachment);
  }
}

/** Lists an issue's successfully uploaded attachments — RESERVED (not yet uploaded) and EXPIRED ones are never public. */
export async function listAttachments(projectId: string, issueId: string) {
  await getIssue(projectId, issueId);
  const attachments = await tenantDb().attachment.findMany({
    where: { issue_id: issueId, status: 'COMMITTED' },
    orderBy: { created_at: 'asc' },
  });
  return attachments.map(serializeAttachment);
}

export async function getAttachment(projectId: string, issueId: string, id: string) {
  await getIssue(projectId, issueId);
  const attachment = await tenantDb().attachment.findFirst({ where: { id, issue_id: issueId, status: 'COMMITTED' } });
  if (!attachment) {
    throw new NotFoundError(`Attachment ${id} not found`);
  }
  return serializeAttachment(attachment);
}

export async function deleteAttachment(projectId: string, issueId: string, id: string) {
  await getIssue(projectId, issueId);
  const { orgId } = getTenantContext();

  const storageKey = await withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ size_bytes: bigint; status: string; storage_key: string }>>`
      SELECT size_bytes, status, storage_key FROM "Attachment"
      WHERE id = ${id}::uuid AND organisation_id = ${orgId}::uuid AND issue_id = ${issueId}::uuid
      FOR UPDATE
    `;
    if (rows.length === 0) {
      return null;
    }
    const current = rows[0]!;

    const { count } = await tx.attachment.deleteMany({ where: { id, organisation_id: orgId, issue_id: issueId } });
    if (count === 0) {
      return null;
    }

    // EXPIRED attachments already released their claim during the sweep —
    // releasing again here would under-count the org's real usage.
    if (current.status === 'RESERVED' || current.status === 'COMMITTED') {
      await releaseUsage(tx, orgId, ResourceType.STORAGE_BYTES, current.size_bytes);
    }
    return current.storage_key;
  });

  if (storageKey === null) {
    throw new NotFoundError(`Attachment ${id} not found`);
  }
  await deleteObject(storageKey);
}
