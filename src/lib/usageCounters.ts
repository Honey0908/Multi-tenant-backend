import type { Prisma } from '../generated/prisma/client.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { ConflictError } from './errors.js';

const RESOURCE_LABELS: Record<ResourceType, string> = {
  PROJECTS: 'projects',
  TASKS: 'tasks',
  USERS: 'seats',
  STORAGE_BYTES: 'storage bytes',
};

const BYTES_PER_MB = 1024 * 1024;

/**
 * Atomically claims `amount` units of `resourceType` for `orgId`, inside the
 * caller's already-open transaction (`tx` — see withOrgContext). This is a
 * single conditional UPDATE, not a count-then-create: Postgres takes a row
 * lock on the matching UsageCounter row for the duration of the UPDATE, so
 * two concurrent transactions racing for the last slot are serialized —
 * the second one only runs its WHERE check after the first has committed
 * or rolled back, and by then `value` already reflects the first's outcome.
 * Exactly one caller can ever push `value` past `max_limit`... zero can.
 *
 * `amount` defaults to 1 (one project/task/seat); attachments claim storage
 * in bytes, so they pass the file size instead. Accepts number or bigint —
 * UsageCounter.value/max_limit are BigInt columns (storage counts in bytes
 * can exceed Postgres's/JS's 32-bit int range).
 *
 * Throws ConflictError (409) if the org doesn't have `amount` left on its
 * plan limit. Caller must run this before creating the resource, in the
 * same transaction, so a failed create still leaves the counter un-incremented.
 */
export async function claimUsage(
  tx: Prisma.TransactionClient,
  orgId: string,
  resourceType: ResourceType,
  planName: string,
  amount: number | bigint = 1,
): Promise<void> {
  const claimed = await tx.$queryRaw<Array<{ value: bigint; max_limit: bigint }>>`
    UPDATE "UsageCounter"
    SET value = value + ${amount}::bigint
    WHERE organisation_id = ${orgId}::uuid
      AND resource_type = ${resourceType}::"ResourceType"
      AND value + ${amount}::bigint <= max_limit
    RETURNING value, max_limit
  `;

  if (claimed.length > 0) {
    return;
  }

  const counter = await tx.usageCounter.findUniqueOrThrow({
    where: { organisation_id_resource_type: { organisation_id: orgId, resource_type: resourceType } },
  });

  const label = RESOURCE_LABELS[resourceType];
  const [used, limit] =
    resourceType === ResourceType.STORAGE_BYTES
      ? [formatMb(counter.value), formatMb(counter.max_limit)]
      : [counter.value, counter.max_limit];
  throw new ConflictError(
    `${label[0]!.toUpperCase()}${label.slice(1)} limit reached: ${used} of ${limit} ${label} used on the ${planName} plan`,
  );
}

function formatMb(bytes: bigint): string {
  return `${(Number(bytes) / BYTES_PER_MB).toFixed(1)}MB`;
}

/**
 * Releases `amount` units of `resourceType` for `orgId` — the mirror of
 * claimUsage, run when the underlying resource is actually deleted (in the
 * same transaction as that delete). Floors at 0 so an out-of-band row
 * removed by something other than the API (e.g. a manual DB fix) can't
 * drive the counter negative.
 */
export async function releaseUsage(
  tx: Prisma.TransactionClient,
  orgId: string,
  resourceType: ResourceType,
  amount: number | bigint = 1,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "UsageCounter"
    SET value = GREATEST(value - ${amount}::bigint, 0)
    WHERE organisation_id = ${orgId}::uuid
      AND resource_type = ${resourceType}::"ResourceType"
  `;
}

/** Seeds one UsageCounter row per resource type for a newly created org, snapshotting the plan's limits. */
export async function initUsageCounters(
  tx: Prisma.TransactionClient,
  orgId: string,
  plan: { max_projects: number; max_tasks: number; max_users: number; max_storage_mb: number },
  initialUsers = 0,
): Promise<void> {
  await tx.usageCounter.createMany({
    data: [
      { organisation_id: orgId, resource_type: ResourceType.PROJECTS, value: 0, max_limit: plan.max_projects },
      { organisation_id: orgId, resource_type: ResourceType.TASKS, value: 0, max_limit: plan.max_tasks },
      { organisation_id: orgId, resource_type: ResourceType.USERS, value: initialUsers, max_limit: plan.max_users },
      {
        organisation_id: orgId,
        resource_type: ResourceType.STORAGE_BYTES,
        value: 0,
        max_limit: BigInt(plan.max_storage_mb) * BigInt(BYTES_PER_MB),
      },
    ],
  });
}
