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
- [ ] Add SeaweedFS container to `docker-compose.yml` in single-server S3 emulation mode
- [ ] Verify S3-compatible endpoint is reachable

### Attachments
- [ ] `POST /api/attachments/reserve` — validate size against storage limit, generate presigned SeaweedFS upload URL, reserve bytes in `usage_counters`
- [ ] `POST /api/attachments/commit` — after client uploads directly to SeaweedFS, run server-side `HeadObject` to verify actual size, then lock the `Attachment` row

### Storage Limits
- [ ] Enforce `storage_bytes` cap in `usage_counters` during reserve step
- [ ] Return `409` with remaining bytes info if limit exceeded

---

## Evaluation Matrix

| Deliverable | Validation | Success Metric |
|---|---|---|
| `prisma/schema.prisma` | Composite key structure | Cascading deletes propagate cleanly through schema |
| `prisma/migrations/*_rls.sql` | RLS policy | Raw queries without session context return 0 rows |
| `src/lib/db.ts` | Prisma extension | Developers write standard queries without manual filters |
| `src/__tests__/concurrency.test.ts` | Parallel requests | Serialized updates block quota bypass under load |
| `docs/openapi.yaml` | Swagger UI | Reviewers can test endpoints live in browser |
