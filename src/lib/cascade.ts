import type { Prisma } from '../generated/prisma/client.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { releaseUsage } from './usageCounters.js';

/**
 * A row deleted by one of the purges below: the quota it was holding, and
 * the storage object that now needs dropping from SeaweedFS.
 */
interface PurgedAttachment {
  size_bytes: bigint;
  status: string;
  storage_key: string;
}

/**
 * Deleting a parent row (Project, Issue) makes its children disappear via
 * `ON DELETE CASCADE`, but a cascade is invisible to the application: it
 * reports no row count, so the storage quota those children were holding
 * would never be released and the org would permanently lose that headroom
 * with no API path to reclaim it.
 *
 * So the delete paths remove children *explicitly*, before the parent, and
 * settle the quota from what the DELETE actually returned. `DELETE ...
 * RETURNING` is a single statement, so there's no count-then-delete gap for
 * a concurrent write to slip through — we account for exactly the rows that
 * were removed, never a stale count. The FK cascade stays in place as a
 * backstop for anything that deletes rows outside these paths.
 */
function settle(
  tx: Prisma.TransactionClient,
  orgId: string,
  purged: PurgedAttachment[],
): Promise<string[]> {
  // EXPIRED reservations already gave their bytes back when they were swept
  // (see attachmentService.releaseExpiredReservations) — releasing again
  // here would under-count the org's real usage.
  const heldBytes = purged
    .filter((a) => a.status === 'RESERVED' || a.status === 'COMMITTED')
    .reduce((sum, a) => sum + a.size_bytes, 0n);

  const release =
    heldBytes > 0n
      ? releaseUsage(tx, orgId, ResourceType.STORAGE_BYTES, heldBytes)
      : Promise.resolve();

  // Every purged row's object is orphaned regardless of status — an EXPIRED
  // reservation may still have had bytes PUT to it before it lapsed.
  return release.then(() => purged.map((a) => a.storage_key));
}

/** Deletes one issue's attachments, releasing their storage quota. Returns the orphaned storage keys. */
export async function purgeAttachmentsOfIssue(
  tx: Prisma.TransactionClient,
  orgId: string,
  issueId: string,
): Promise<string[]> {
  const purged = await tx.$queryRaw<PurgedAttachment[]>`
    DELETE FROM "Attachment"
    WHERE organisation_id = ${orgId}::uuid AND issue_id = ${issueId}::uuid
    RETURNING size_bytes, status, storage_key
  `;
  return settle(tx, orgId, purged);
}

/** Deletes every attachment under a project's issues, releasing their storage quota. Returns the orphaned storage keys. */
export async function purgeAttachmentsOfProject(
  tx: Prisma.TransactionClient,
  orgId: string,
  projectId: string,
): Promise<string[]> {
  const purged = await tx.$queryRaw<PurgedAttachment[]>`
    DELETE FROM "Attachment"
    WHERE organisation_id = ${orgId}::uuid
      AND issue_id IN (
        SELECT id FROM "Issue"
        WHERE organisation_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
      )
    RETURNING size_bytes, status, storage_key
  `;
  return settle(tx, orgId, purged);
}
