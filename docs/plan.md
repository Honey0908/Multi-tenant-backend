# Multi-Tenant Backend — Implementation Plan

## Project Core Domain: "TaskFlow"
A Jira/Zoho-style project and task management system built to satisfy multi-tenant subscription tracking requirements.

### Entity Hierarchy
```
Organisation (Tenant Workspace)
  └─ SubscriptionPlan (Hard Limits Configurator)
  └─ User (Role-Scoped: ORG_ADMIN, MEMBER, PLATFORM_ADMIN)
  └─ Project (Core Restricted Resource Count)
       └─ Issue / Task (Task Tracking Nodes)
            └─ Attachment (Metadata rows synced to SeaweedFS S3 storage bucket)
```

---

## Stack
- **Runtime:** Node.js 24 + TypeScript
- **API:** Express.js v5
- **ORM:** Prisma
- **Database:** PostgreSQL 17
- **Object Storage:** SeaweedFS (local S3 emulation)
- **Docs:** Swagger UI Express + OpenAPI 3.0 YAML
- **Validation:** Zod
- **Testing:** Vitest + Testcontainers

---

## Milestone 1 — Foundation

**Docker → PostgreSQL → Prisma → Organisation → User**

### Docker
- [x] `npm init -y`, set up `tsconfig.json`, install runtime deps (`express`, `@prisma/client`, `zod`, `pino`, `swagger-ui-express`, `yamljs`)
- [x] Write `docker-compose.yml` with a PostgreSQL 17 node (named DB, credentials, health check)
- [x] Verify `docker compose up` boots with a green health check — confirmed indirectly: `prisma migrate dev`/`status` and app queries connect successfully to `localhost:5432`

### PostgreSQL
- [x] Confirm DB is reachable from the host and accepts connections — 3 migrations applied, seed run, and smoke-tested creates/reads all succeeded against the live container
- [x] Plan RLS policy structure per tenant-scoped table

### Prisma
- [x] `npx prisma init`, configure `DATABASE_URL` in `.env`
- [x] Define schema models: `Organisation`, `SubscriptionPlan`, `User`, `Project`, `Issue`
- [x] Add composite unique constraints on all content models:
  ```prisma
  @@unique([organisation_id, id])
  ```
- [x] Add composite foreign keys so child rows link back through tenant ID:
  ```prisma
  model Issue {
    id              String  @id @default(uuid())
    organisation_id String
    project_id      String
    project         Project @relation(fields: [organisation_id, project_id], references: [organisation_id, id])
    @@unique([organisation_id, id])
  }
  ```
- [x] Generate migration: `npx prisma migrate dev --create-only --name enable_rls`
- [x] Write RLS SQL in the generated migration file, extended to all three tenant-scoped tables (`User`, `Project`, `Issue`)
- [x] Apply: `npx prisma migrate dev` — applied and verified against a live Postgres container

Two corrections found while verifying RLS actually blocks cross-tenant reads (not just that the policy exists):
- **The app must not connect as the migration role.** `POSTGRES_USER` from `docker-compose.yml` is a Postgres superuser, and superusers bypass RLS unconditionally — `FORCE ROW LEVEL SECURITY` only binds the table *owner*, never a superuser. Added migration `create_app_role`, which creates a plain `app_user` role with table grants but no `BYPASSRLS`/`SUPERUSER`; the running app connects via a new `APP_DATABASE_URL`, while `DATABASE_URL` (superuser) stays reserved for `prisma migrate`.
- **The original policy expression can raise instead of filtering.** `NULLIF(current_setting(...), '') IS NOT NULL AND col = current_setting(...)::uuid` is a top-level `AND`, which Postgres's planner may split into independently-reorderable quals — so the `::uuid` cast can run before the `NULLIF` guard, raising `invalid input syntax for type uuid: ''` instead of returning zero rows when no `app.org_id` is set. Added migration `harden_org_id_policy`: a `current_org_id()` SQL function makes the guard atomic (NULLIF always runs first inside it), so an unset session variable now just yields no matching rows.

Verified end-to-end against the live DB (org A cannot see org B's users; a query with no `app.org_id` set at all returns zero rows, not an error).

### Organisation
- [x] `POST /api/organisations` — create an organisation (wraps in a transaction: dedup, create org, attach default plan)
- [x] `GET /api/organisations/:id` — fetch org details

### User
- [x] `POST /api/users` — register a user under an organisation
- [x] `GET /api/organisations/:orgId/users` — list org members

---

## Milestone 2 — Core Features

**Authentication → Tenant Context → Projects → Tasks**

### Authentication
- [x] `POST /api/auth/signup` — atomic onboarding (validate with Zod, create Org + Plan + User in one transaction)
- [x] `POST /api/auth/login` — issue JWT containing `{ userId, orgId, role }`
- [x] Rollback test: inject bad data mid-transaction, assert zero orphaned rows — `src/__tests__/auth.test.ts`

One design decision made while implementing login: RLS on `User` returns zero rows with no `app.org_id` set, but login only has an email — it doesn't know the org yet. Rather than have the app fall back to the migration superuser role for that lookup (full read/write on every table), added a narrow `auth_reader` Postgres role (`create_auth_reader_role` migration) that can only `SELECT` on `User` and bypasses RLS to do it — used exclusively by `src/lib/authPrisma.ts`. Every other query still goes through `app_user`, fully RLS-scoped.

### Tenant Context
- [x] `src/lib/db.ts` — Prisma Client Extension (`getTenantClient`) that wraps every query in a transaction setting `app.org_id`, plus `tenantDb()` which reads the org id from request-scoped `AsyncLocalStorage`
- [x] `src/middleware/tenantContext.ts` — unpack JWT (`requireAuth`), inject `{ userId, orgId, role }` into `AsyncLocalStorage`
- [x] Isolation test: Org A and Org B both create a project with the *same name*; assert Org B's token returns `404` for Org A's project (and can't list/patch/delete it either) — `src/__tests__/tenantIsolation.test.ts`

Bug caught while writing the isolation test: the plan's `getTenantClient` snippet calls `prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(...); return query(args); })` — but `query(args)` there is a deferred PrismaPromise that runs on the *base* client's own connection, not `tx`'s, so the `SET LOCAL` had no effect and even the owning org couldn't see its own rows. Fixed by using the array/batch form of `$transaction` (`prisma.$transaction([prisma.$executeRawUnsafe(...), query(args)])`), which sends both statements down the same connection in one transaction. Verified via the isolation test and manual curl checks both ways (owner sees it, other org gets 404 on read/patch/delete).

### Projects
- [x] `POST /api/projects` — create project (enforces plan limit: count existing vs `plan.max_projects`, `409` with a `"N of M projects used on the X plan"` message)
- [x] `GET /api/projects` — list projects for the authenticated org
- [x] `GET /api/projects/:id` — fetch single project
- [x] `PATCH /api/projects/:id` — update
- [x] `DELETE /api/projects/:id` — delete

Note: this count-then-create check is not concurrency-safe (two simultaneous requests at the limit could both pass the count check) — that's intentionally left for Milestone 3's atomic `usage_counters` + concurrency test.

### Tasks (Issues)
- [x] `POST /api/projects/:projectId/issues` — create task
- [x] `GET /api/projects/:projectId/issues` — list tasks
- [x] `GET /api/projects/:projectId/issues/:id` — fetch task
- [x] `PATCH /api/projects/:projectId/issues/:id` — update
- [x] `DELETE /api/projects/:projectId/issues/:id` — delete

Verified end-to-end via `npm test` (15 tests: signup/login/rollback, tenant isolation for both projects and nested issues, full projects CRUD + plan-limit enforcement, full issues CRUD) and manually via curl against the live dev containers, including cross-tenant read/write/delete attempts on both resources.

---

## Milestone 3 — Plan Limits, Concurrency & Security

**Plan limits → Concurrency → Security tests**

### Plan Limits
- [x] Create `usage_counters` table (`organisation_id`, `resource_type`, `value`, `max_limit`) — `UsageCounter` model, one row per org per `ResourceType` (`PROJECTS`/`TASKS`/`USERS`), RLS-protected like the other tenant tables (`add_usage_counters` migration)
- [x] Atomic counter increment at the DB layer — `claimUsage()` in `src/lib/usageCounters.ts` runs the exact conditional `UPDATE ... WHERE value + 1 <= max_limit RETURNING ...` from this plan, inside the caller's transaction
- [x] Return `409 Conflict` with structured message (e.g., `"Seats limit reached: 5 of 5 seats used on the Starter plan"`) when 0 rows updated

Replaced the Milestone 2 count-then-create checks in `projectService.createProject` and added matching enforcement to `issueService.createIssue` (tasks) and the new authenticated `userService.createUser` (seats) — all three resource types from `SubscriptionPlan` are now actually enforced, not just modeled. Added `releaseUsage()` as the symmetric decrement, called from `deleteProject`/`deleteIssue` in the same transaction as the delete, so a freed slot is immediately available again.

### Concurrency
- [x] Concurrency test: place a tenant at limit − 1, fire two simultaneous creation requests — `src/__tests__/concurrency.test.ts`
- [x] Assert exactly one `201 Created` and one `409 Conflict` (also covers a 10-way race at the limit, asserting exactly 1 winner)

### Security Tests
- [x] Cross-tenant isolation test suite — expanded in `src/__tests__/planLimits.test.ts` (a client-supplied `organisationId` in the user-creation body is ignored; the org always comes from the JWT) and `src/__tests__/platformAdmin.test.ts`. Still runs against the live dev Postgres container, not Testcontainers, consistent with Milestone 1/2's tests — `testcontainers` was never actually added as a dependency despite being named in the stack.
- [x] Platform admin route: separate DB connection with `platform_reader` role, restricted to org-level metadata only — `create_platform_reader_role` migration (`SELECT` on `Organisation`/`SubscriptionPlan`/`User` only, no grants on `Project`/`Issue`/`UsageCounter`), used via `src/lib/platformPrisma.ts` and `withPlatformOrgContext`
- [x] Leak audit script — `scripts/leakAudit.ts` (`npm run audit:leak`), plus a standing regression test (`src/__tests__/leakAudit.test.ts`)
- [x] Structured logging (pino): onboarding events, quota failures, cross-tenant rejections — `pino-http` request logging (`src/middleware/requestLogger.ts`) plus centralized logging of every `AppError` in `errorHandler.ts` (401/403/404/409 all logged at `warn` with org/user/role context; secrets redacted via `pino`'s `redact` option)
- [x] Swagger UI at `GET /docs` wired up with OpenAPI 3.0 YAML — `docs/openapi.yaml`, mounted in `src/app.ts`

A real, pre-existing security gap was found and fixed while wiring up the platform-admin route: `POST /api/users` (add a user to an org) and `GET /api/organisations/:orgId/users` (list an org's members) had **no authentication at all** since Milestone 1 — anyone could create an `ORG_ADMIN` account in any organisation by guessing/enumerating its id, or list another org's user directory. Fixed by requiring auth on both: `POST /api/users` now derives the organisation from the caller's own JWT (never from the request body) and requires `ORG_ADMIN`/`PLATFORM_ADMIN`; the org-listing routes now require `PLATFORM_ADMIN` and run over the read-only `platform_reader` connection.

---

## Milestone 4 — File Storage (last)

**SeaweedFS → Attachments → Storage limits**

### SeaweedFS
- [x] Add SeaweedFS container to `docker-compose.yml` in single-server S3 emulation mode
- [x] Verify S3-compatible endpoint is reachable — `ensureBucketExists()` (`src/lib/s3.ts`) runs at app startup (`src/index.ts`), idempotently creating the `taskflow-attachments` bucket; confirmed against the live container via a direct presigned PUT + HeadObject round-trip

### Attachments
- [x] `POST /api/projects/:projectId/issues/:issueId/attachments/reserve` — validates size against storage limit, generates a presigned SeaweedFS upload URL, reserves bytes in `usage_counters` (`src/services/attachmentService.ts`)
- [x] `POST /api/projects/:projectId/issues/:issueId/attachments/:id/commit` — after the client uploads directly to SeaweedFS, runs a server-side `HeadObject` to verify actual size, then locks the `Attachment` row (`SELECT ... FOR UPDATE`) before finalizing

Deviated from the plan's flat `/api/attachments/reserve` + `/api/attachments/commit` paths: nested them under `/api/projects/:projectId/issues/:issueId/attachments` instead, so `issueId` comes from the URL (and is checked against `projectId` via the existing `issueService.getIssue`) rather than a client-supplied body field — consistent with how every other resource in this app derives its scope from the URL/JWT, never from trusted request body fields (see Milestone 3's `POST /api/users` fix).

Attachments belong to `Issue` (per the entity hierarchy at the top of this doc), with the same composite-FK-to-parent + RLS pattern as `Issue`→`Project`: `Attachment.organisation_id` is part of a composite FK to `Issue(organisation_id, id)`, so a cross-tenant or cross-issue attachment row is structurally impossible, not just app-checked. `scripts/leakAudit.ts` / `src/__tests__/leakAudit.test.ts` were extended to cover it.

`UsageCounter.value`/`max_limit` were widened from `Int` to `BigInt`: `STORAGE_BYTES` counts raw bytes, and the Professional tier's 10GB limit (10,737,418,240 bytes) already overflows Postgres's/Prisma's 32-bit `Int`. `claimUsage`/`releaseUsage` now take an optional `amount` (default 1, so every existing PROJECTS/TASKS/USERS call site is unchanged) and accept bigint amounts for byte-level claims.

A reservation that's never committed (client got a presigned URL and abandoned it) would otherwise permanently eat into the org's storage quota — there's no background job runner in this app, so instead every `reserve` call first sweeps the org's own expired (`expires_at` in the past) `RESERVED` rows, releases their claimed bytes, and marks them `EXPIRED`. Lazy, not scheduled, but the only code path that can create new pressure on the quota is exactly the one guaranteed to run the sweep first.

`commit` reconciles the storage claim against the real uploaded size (from `HeadObject`), not just the client's declared size: a smaller real upload releases the difference, a larger one claims the difference — and if that claim would exceed the plan's quota, the commit is rejected and the orphaned object is deleted from SeaweedFS (`src/lib/s3.ts#deleteObject`, best-effort/logged, not thrown — the DB is the source of truth, an unreachable storage backend at cleanup time just leaves an orphaned object rather than corrupting the attachment's state).

One real integration bug found while wiring up the presigned upload: `@aws-sdk/client-s3`'s newer default of always attaching a flexible checksum (`x-amz-checksum-crc32`) to `PutObject` requests breaks presigned URLs specifically — the checksum gets computed over an empty body at signing time (the real bytes don't exist yet) and baked into the signed query string, so the actual upload's real checksum then mismatches it and SeaweedFS rejects the PUT with `BadDigest`. Fixed by setting `requestChecksumCalculation: 'WHEN_REQUIRED'` on the `S3Client` (`src/lib/s3.ts`). Caught by testing the real upload path end-to-end (PUT-ing real bytes to a real presigned URL against the live SeaweedFS container), not by inspection.

### Storage Limits
- [x] Enforce `storage_bytes` cap in `usage_counters` during reserve step — same atomic `claimUsage` conditional-UPDATE pattern as PROJECTS/TASKS/USERS, so concurrent reservations racing for the last bytes are serialized by Postgres's row lock, not a count-then-reserve race (test: `src/__tests__/attachments.test.ts`, "lets exactly one of two simultaneous reservations through")
- [x] Return `409` with remaining bytes info if limit exceeded — message format mirrors the other resource types (e.g. `"Storage bytes limit reached: 95.0MB of 100.0MB storage bytes used on the Starter plan"`), converted from raw bytes to MB for readability
- [x] Hard per-file size cap (`ATTACHMENT_MAX_FILE_SIZE_MB`, default 200MB) independent of remaining plan quota, rejected with `413 Payload Too Large` — bounds a single upload regardless of how much headroom an org's plan otherwise has
- [x] Content-type allow-list and file-name path-traversal rejection at the validator layer (`src/validators/attachment.ts`), before any quota or storage work runs

Verified end-to-end via `npm test` (Milestone 4 adds 8 tests in `src/__tests__/attachments.test.ts`: full reserve→upload→commit→list/get flow against the live SeaweedFS container, rejection of unuploaded commits/oversized files/disallowed content-types/path-traversal names, storage-limit enforcement + release-on-delete, concurrent-reservation quota safety, expired-reservation sweep, and cross-tenant isolation on get/commit/delete) plus `npm run audit:leak`.

Known limitation: a `deleteObject` failure after a successful DB delete (e.g. SeaweedFS briefly unreachable) leaves an orphaned object in storage — logged, not retried. No background job/reconciliation sweep exists for that case; out of scope for this milestone.

---

---

## Post-Milestone Audit — Fixes

Two defects found auditing Milestones 1–4 against `docs/multi-tenant-subscription.md`, both fixed and covered by regression tests.

### 1. Cascading deletes stranded plan quota

`deleteProject` released one `PROJECTS` unit and `deleteIssue` released one `TASKS` unit — but both leaned on `ON DELETE CASCADE` for everything below them. A cascade deletes rows without reporting a count, so the quota those children held was never released: deleting a project with 3 issues left `TASKS` stuck at 3 with no API path to reclaim it, and deleting an issue with a 5000-byte attachment stranded those bytes *and* orphaned the object in SeaweedFS. Over time an org silently loses headroom it paid for.

Fixed in `src/lib/cascade.ts`: the delete paths now remove children explicitly, deepest first, and settle the counters from what the `DELETE` actually returned. `DELETE ... RETURNING` is a single statement, so there is no count-then-delete gap for a concurrent write to slip through — the accounting matches exactly the rows removed, never a stale count. Orphaned storage keys come back from the transaction and are dropped from SeaweedFS after it commits, on the same best-effort contract `deleteAttachment` already used. The FK cascades stay in place as a backstop for deletes outside these paths.

Tests: `src/__tests__/cascadeQuota.test.ts` (5) — task slots freed by a project delete, storage freed by an issue delete, storage freed two levels down, slots genuinely reusable afterwards rather than merely correct on paper, and a bystander org's counters left untouched.

### 2. `Organisation` had no RLS; `app_user` could rewrite the plan catalog

`Organisation` was the one tenant-scoped table never given Row-Level Security, and `SubscriptionPlan` left the application role with full write access. Verified against the live database: a tenant's own connection could read **every** organisation's name and slug (311 rows at the time), and could `UPDATE "SubscriptionPlan"` to raise `max_projects`/`max_users`/`max_storage_mb` for every tenant on that tier — voiding plan enforcement platform-wide.

No route exposed either, because every service hand-filters by the caller's org id. But that is precisely the property this codebase exists not to depend on (§9's careless-query requirement): `organisation.findMany()` with no `where` returned the whole platform.

Fixed in the `add_organisation_rls` migration:
- `Organisation` gets `ENABLE`/`FORCE ROW LEVEL SECURITY` with the same `current_org_id()` guard as every other tenant table, matching on `id` since the tenant row *is* the tenant.
- A second policy, `platform_read_policy`, is scoped `FOR SELECT TO platform_reader USING (true)`. Postgres ORs permissive policies, so platform admins keep cross-tenant visibility of org metadata while `app_user` stays confined to its own row. `platform_reader` still holds no grants on `Project`/`Issue`/`Attachment`, so this widens metadata visibility only, never tenant content.
- `REVOKE INSERT, UPDATE, DELETE ON "SubscriptionPlan" FROM app_user`. The catalog is global and deliberately keeps no RLS — every org must read the plan it is on — but the app role no longer writes it.

Three call sites had to change to suit:
- The slug pre-check in `signup`/`createOrganisation` could no longer see other tenants' rows, so slug collisions are now detected from the unique index via `P2002`. This is also race-free where the old check-then-create was not: two simultaneous signups claiming one slug could both pass the check. `slug` is the only unique constraint on `Organisation`, so the error is unambiguous.
- `getOrganisationById` keeps running with no org context, now reading through `platform_read_policy`.
- `prisma/seed.ts` moved to the migration role (`DATABASE_URL`), like `scripts/leakAudit.ts`: `app_user` no longer writes the plan catalog, and RLS would hide the rows its idempotency checks look for. Superusers bypass RLS, so it sets no org context.

Tests: `src/__tests__/organisationIsolation.test.ts` (7) — including the walkthrough's careless-query demonstration (an unfiltered `organisation.findMany()` returning only the caller's org), a rejected plan-catalog write, and regression cover for platform-admin visibility and duplicate-slug `409`s.

Verified end-to-end: full suite **48 passing**, migrations replay cleanly onto an empty database, `npm run db:seed` idempotent across re-runs, and `npm run audit:leak` clean. Final RLS posture — every tenant table `ENABLE`+`FORCE`, `SubscriptionPlan` intentionally open for reads and `SELECT`-only for `app_user`.

Still outstanding from the audit (not addressed here): `User.email` is globally rather than per-org unique; `requireAuth` does not revalidate user state against the database; and the spec's Comment/Invitation/AuditLog entities, task assignment, user-management endpoints and pagination remain unbuilt.

---

## Post-Milestone Audit — Platform Admin Organisation List

Flagged as blocking: the platform-admin surface exposed `POST /organisations` and `GET /organisations/:id` (fetch one by id) and `GET /organisations/:orgId/users`, but no way to list organisations at all — the planned "organisation list: name, plan, aggregate usage, status" screen had nothing to page through.

- [x] `GET /api/organisations` — every organisation on the platform, paginated (`page`/`limit`, same envelope as every other list endpoint), each row carrying its plan and aggregate usage (`src/services/organisationService.ts#listOrganisations`, `src/routes/organisations.ts`)

Usage required reopening a deliberate decision from the Milestone 3/4 audit: `platform_reader` was explicitly denied any grant on `UsageCounter` ("operational/billing data, not org-level metadata" — see `add_usage_counters` migration). That boundary held for the org-detail and user-listing routes, which never needed usage figures; the list screen does. Fixed narrowly rather than widening `platform_reader` generally: the `allow_platform_usage_read` migration grants it `SELECT` only on `UsageCounter`, via the same `FOR SELECT TO platform_reader USING (true)` shape as `Organisation`'s existing `platform_read_policy` — still no grants on `Project`, `Issue`, or `Attachment`.

`listOrganisations` fetches usage for the whole page in one extra query (`organisation_id IN (...)`), not one query per org, so a page of 20 costs 2 queries total rather than 21. The per-resource `{used, limit, remaining}` shape is unchanged from `getOwnUsage` — both now share a `buildUsage()` helper rather than duplicating the mapping.

`docs/openapi.yaml` gained the `listOrganisations` operation and an `OrganisationSummary` schema; `scripts/specDrift.ts`'s operation count and the hardcoded op-count assertion in `src/__tests__/sessionAndUsage.test.ts` were updated to match (29 → 30). Tests: `src/__tests__/platformAdmin.test.ts` — unauthenticated/wrong-role rejection, and a `PLATFORM_ADMIN` paging through to find a known org with its plan and usage populated.

## Evaluation Matrix

| Deliverable | Validation | Success Metric |
|---|---|---|
| `prisma/schema.prisma` | Composite key structure | Cascading deletes propagate cleanly through schema |
| `prisma/migrations/*_rls.sql` | RLS policy | Raw queries without session context return 0 rows |
| `src/lib/db.ts` | Prisma extension | Developers write standard queries without manual filters |
| `src/__tests__/concurrency.test.ts` | Parallel requests | Serialized updates block quota bypass under load |
| `docs/openapi.yaml` | Swagger UI | Reviewers can test endpoints live in browser |
