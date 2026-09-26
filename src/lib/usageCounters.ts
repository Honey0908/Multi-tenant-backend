import type { Prisma } from '../generated/prisma/client.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { ConflictError } from './errors.js';

const RESOURCE_LABELS: Record<ResourceType, string> = {
  PROJECTS: 'projects',
  TASKS: 'tasks',
  USERS: 'seats',
};

/**
 * Atomically claims one unit of `resourceType` for `orgId`, inside the
 * caller's already-open transaction (`tx` — see withOrgContext). This is a
 * single conditional UPDATE, not a count-then-create: Postgres takes a row
 * lock on the matching UsageCounter row for the duration of the UPDATE, so
 * two concurrent transactions racing for the last slot are serialized —
 * the second one only runs its WHERE check after the first has committed
 * or rolled back, and by then `value` already reflects the first's outcome.
 * Exactly one caller can ever push `value` past `max_limit`... zero can.
 *
 * Throws ConflictError (409) if the org is already at its plan limit.
 * Caller must run this before creating the resource, in the same
 * transaction, so a failed create still leaves the counter un-incremented.
 */
export async function claimUsage(
  tx: Prisma.TransactionClient,
  orgId: string,
  resourceType: ResourceType,
  planName: string,
): Promise<void> {
  const claimed = await tx.$queryRaw<Array<{ value: number; max_limit: number }>>`
    UPDATE "UsageCounter"
    SET value = value + 1
    WHERE organisation_id = ${orgId}::uuid
      AND resource_type = ${resourceType}::"ResourceType"
      AND value + 1 <= max_limit
    RETURNING value, max_limit
  `;

  if (claimed.length > 0) {
    return;
  }

  const counter = await tx.usageCounter.findUniqueOrThrow({
    where: { organisation_id_resource_type: { organisation_id: orgId, resource_type: resourceType } },
  });

  const label = RESOURCE_LABELS[resourceType];
  throw new ConflictError(
    `${label[0]!.toUpperCase()}${label.slice(1)} limit reached: ${counter.value} of ${counter.max_limit} ${label} used on the ${planName} plan`,
  );
}

/**
 * Releases one unit of `resourceType` for `orgId` — the mirror of
 * claimUsage, run when the underlying resource is actually deleted (in the
 * same transaction as that delete). Floors at 0 so an out-of-band row
 * removed by something other than the API (e.g. a manual DB fix) can't
 * drive the counter negative.
 */
export async function releaseUsage(
  tx: Prisma.TransactionClient,
  orgId: string,
  resourceType: ResourceType,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "UsageCounter"
    SET value = GREATEST(value - 1, 0)
    WHERE organisation_id = ${orgId}::uuid
      AND resource_type = ${resourceType}::"ResourceType"
  `;
}

/** Seeds one UsageCounter row per resource type for a newly created org, snapshotting the plan's limits. */
export async function initUsageCounters(
  tx: Prisma.TransactionClient,
  orgId: string,
  plan: { max_projects: number; max_tasks: number; max_users: number },
  initialUsers = 0,
): Promise<void> {
  await tx.usageCounter.createMany({
    data: [
      { organisation_id: orgId, resource_type: ResourceType.PROJECTS, value: 0, max_limit: plan.max_projects },
      { organisation_id: orgId, resource_type: ResourceType.TASKS, value: 0, max_limit: plan.max_tasks },
      { organisation_id: orgId, resource_type: ResourceType.USERS, value: initialUsers, max_limit: plan.max_users },
    ],
  });
}
