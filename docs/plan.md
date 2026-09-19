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
- [ ] Verify `docker compose up` boots with a green health check — **not run**: no `docker` binary in this environment; run locally to confirm

### PostgreSQL
- [ ] Confirm DB is reachable from the host and accepts connections — depends on the `docker compose up` step above
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
- [ ] `POST /api/auth/signup` — atomic onboarding (validate with Zod, create Org + Plan + User in one transaction)
- [ ] `POST /api/auth/login` — issue JWT containing `{ userId, orgId, role }`
- [ ] Rollback test: inject bad data mid-transaction, assert zero orphaned rows

### Tenant Context
- [ ] `src/lib/db.ts` — Prisma Client Extension that wraps every query in a transaction setting `app.org_id`:
  ```typescript
  export const getTenantClient = (orgId: string) => {
    return basePrisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            return basePrisma.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(`SET LOCAL app.org_id = '${orgId}';`);
              return query(args);
            });
          },
        },
      },
    });
  };
  ```
- [ ] `src/middleware/tenantContext.ts` — unpack JWT, inject `orgId` into `AsyncLocalStorage`
- [ ] Isolation test: seed Org A and Org B both with `prj-1111`; assert Org B's token returns `404` for Org A's project

### Projects
- [ ] `POST /api/projects` — create project (enforces plan limit)
- [ ] `GET /api/projects` — list projects for the authenticated org
- [ ] `GET /api/projects/:id` — fetch single project
- [ ] `PATCH /api/projects/:id` — update
- [ ] `DELETE /api/projects/:id` — delete

### Tasks (Issues)
- [ ] `POST /api/projects/:projectId/issues` — create task
- [ ] `GET /api/projects/:projectId/issues` — list tasks
- [ ] `GET /api/projects/:projectId/issues/:id` — fetch task
- [ ] `PATCH /api/projects/:projectId/issues/:id` — update
- [ ] `DELETE /api/projects/:projectId/issues/:id` — delete

---

## Milestone 3 — Plan Limits, Concurrency & Security

**Plan limits → Concurrency → Security tests**

### Plan Limits
- [ ] Create `usage_counters` table (`org_id`, `resource_type`, `value`, `max_limit`)
- [ ] Atomic counter increment at the DB layer:
  ```sql
  UPDATE usage_counters
  SET value = value + 1
  WHERE org_id = $1 AND resource_type = 'projects' AND value + 1 <= max_limit
  RETURNING *;
  ```
- [ ] Return `409 Conflict` with structured message (e.g., `"Seat limit reached: 3 of 3 seats used on the Free plan"`) when 0 rows updated

### Concurrency
- [ ] Concurrency test: place a tenant at limit − 1, fire two simultaneous creation requests
- [ ] Assert exactly one `201 Created` and one `409 Conflict`

### Security Tests
- [ ] Cross-tenant isolation test suite (Vitest + Testcontainers)
- [ ] Platform admin route: separate DB connection with `platform_reader` role, restricted to org-level metadata only
- [ ] Leak audit script:
  ```sql
  SELECT i.id FROM "Issue" i
  JOIN "Project" p ON i.project_id = p.id
  WHERE i.organisation_id != p.organisation_id;
  ```
- [ ] Structured logging (pino): onboarding events, quota failures, cross-tenant rejections
- [ ] Swagger UI at `GET /docs` wired up with OpenAPI 3.0 YAML

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
