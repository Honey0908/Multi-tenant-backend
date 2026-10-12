# TaskFlow — Multi-Tenant SaaS Backend

A multi-tenant project/issue-tracking SaaS backend where **tenant isolation is structural** — it's enforced by the database (PostgreSQL Row-Level Security + composite foreign keys), not just by `WHERE organisation_id = ...` filters sprinkled through the application code. The idea: even if a developer forgets a filter, the database still returns zero rows from another tenant.

- **Frontend (live):** https://task-flow-platform.netlify.app
- **API docs (Swagger UI):** `GET /docs` when the server is running (served from [`docs/openapi.yaml`](docs/openapi.yaml))

> "Multi-tenant" means one running backend + one database serves many independent customer organisations ("tenants"), and no tenant can ever see another tenant's data.

---

## Tech Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js **≥ 24** (see [`.nvmrc`](.nvmrc)) |
| Language | TypeScript (ESM) |
| Web framework | Express 5 |
| Database | PostgreSQL + [Prisma 7](https://www.prisma.io/) (via the `@prisma/adapter-pg` driver adapter) |
| Auth | JWT (`jsonwebtoken`) + Argon2 password hashing |
| Object storage | Any **S3-compatible** store — **SeaweedFS** locally, **Backblaze B2** in production (`@aws-sdk/client-s3`) |
| Validation | Zod |
| Logging | Pino / `pino-http` |
| Tests | Vitest + Supertest |

---

## Getting Started

### 1. Prerequisites
- Node.js ≥ 24 (`nvm use` picks it up from `.nvmrc`)
- Docker + Docker Compose (for Postgres and local S3)

### 2. Install
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```
Then edit `.env`. See the [Environment Variables](#environment-variables) section below — the different `*_DATABASE_URL` values each use a **different database role** on purpose (explained there).

### 4. Start infrastructure
```bash
docker compose up -d        # Postgres + local S3 (SeaweedFS)
```

### 5. Apply migrations & seed
```bash
npx prisma migrate deploy   # runs as the superuser (DATABASE_URL)
npm run db:seed             # seeds plans + the bootstrap PLATFORM_ADMIN
```

### 6. Run
```bash
npm run dev     # tsx watch, hot reload
# or
npm run build && npm start
```

The API listens on `PORT` (default `3000`).

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite (Vitest) |
| `npm run db:seed` | Seed subscription plans and the bootstrap platform admin |
| `npm run audit:leak` | Tenant data-leak audit (checks isolation holds) |
| `npm run audit:spec` | OpenAPI spec-drift audit (routes vs. documented spec) |

---

## Two Kinds of "Roles"

This project has **two completely separate notions of a "role"**, and keeping them straight is the key to understanding the security model. One is a *database* concept; the other is an *application* concept. They solve different problems at different layers.

### 1. Database (PostgreSQL) roles — *who the backend connects to Postgres as*

A PostgreSQL "role" is essentially a database login/user with its own set of permissions. Postgres enforces these at the database level — no application code can override them. The backend deliberately opens connections using **different roles for different jobs**, so that even a bug in the application code can't do more than the role it's connected as is allowed to.

This is "defense in depth": the app checks permissions *and* the database independently refuses anything the role isn't granted.

| DB role | Connection env var | Powers | Why it exists |
| --- | --- | --- | --- |
| **superuser** (migration role) | `DATABASE_URL` | Full DDL (create tables, policies, roles) | Used **only** by `prisma migrate`. Superusers *bypass Row-Level Security*, so it must never serve live traffic. |
| **`app_user`** | `APP_DATABASE_URL` | Normal CRUD on tenant tables, **subject to RLS** | The role the running app uses for almost every request. Because it's a non-superuser, RLS actually applies — queries see only the current tenant's rows. See the `create_app_role` migration. |
| **`auth_reader`** | `AUTH_DATABASE_URL` | `SELECT` on `User` only, `BYPASSRLS` | Login is a chicken-and-egg problem: at login we only have an email, but RLS needs to know the org *before* it will return rows. This tiny role can look a user up by email (and nothing else) to break that cycle. See `create_auth_reader_role`. |
| **`platform_reader`** | `PLATFORM_DATABASE_URL` | Read-only `SELECT` on `Organisation`, `SubscriptionPlan`, `User`, `UsageCounter` — **no access to `Project`/`Issue`/`Attachment`** | Backs the platform-admin screens (org list, usage). Even if admin code accidentally queried tenant content, the database refuses it. See `create_platform_reader_role` and `allow_platform_usage_read`. |

> **Why this matters:** tenant isolation isn't a single `if` statement that could be forgotten. `app_user` + RLS means the *database itself* filters every row by the tenant set on the connection. The specialized read-only roles shrink the blast radius of any mistake even further.

How a request gets scoped to a tenant: after `requireAuth` validates the JWT, middleware stores the caller's `organisationId` (via `AsyncLocalStorage`), and the tenant-scoped Prisma client wraps each query in a transaction that runs `SET LOCAL app.org_id = <org>`. RLS policies compare that session variable against each row's `organisation_id`. (See `src/lib/db.ts`, `src/lib/requestContext.ts`, `src/middleware/tenantContext.ts`.)

### 2. Application (Node) roles — *what a logged-in user is allowed to do*

These live in the app and are stored on each `User` as the `Role` enum (`prisma/schema.prisma`). They answer "what can *this human* do?", enforced in middleware (`src/middleware/requireRole.ts`) and service code — a separate question from "what can the *backend's DB connection* do?" above.

| App role | Scope | Typical abilities |
| --- | --- | --- |
| **`PLATFORM_ADMIN`** | The whole platform (us, the operators) | Manage organisations, view cross-tenant admin/usage screens. There is **no API to create one** — it's bootstrapped only by the seed script into an internal "platform-ops" org. |
| **`ORG_ADMIN`** | A single organisation (tenant) | Manage their org: invite/deactivate users, create/configure projects, manage project membership. |
| **`ORG_MEMBER`** | A single organisation (default role) | Work inside projects they're a member of: see assigned projects, manage issues/tasks. Project *writes* are admin-only; members get `404` on projects they're not in. |

> **Beyond roles — per-project membership:** inside one org, access is narrowed further by `ProjectMember` (who's on which project) and `Issue.assignee_id`. This finer-grained check is enforced in the **service layer** (`src/lib/projectAccess.ts`), not RLS, because "is this user on this project?" is an app-level rule.

---

## API Overview

Base path: `/api`. Full request/response detail is in Swagger UI at `/docs`.

| Area | Mount point |
| --- | --- |
| Auth (signup/login) | `/api/auth` |
| Current organisation | `/api/organisation` |
| Platform admin — organisations | `/api/organisations` |
| Users (org-scoped) | `/api/organisations/:orgId/users`, `/api/users` |
| Projects | `/api/projects` |
| Project membership | `/api/projects/:projectId/members` |
| Issues / tasks | `/api/projects/:projectId/issues` |
| Attachments | `/api/projects/:projectId/issues/:issueId/attachments` |

---

## Plan Limits & Quotas

Each organisation has a subscription plan with caps on projects, tasks, users, and storage. Enforcement is **atomic** to stay correct under concurrent requests: a single `UsageCounter` row per org/resource is updated with a conditional `UPDATE ... WHERE value + 1 <= max_limit` inside the request's transaction, so Postgres's row lock — not app-level locking — guarantees two simultaneous requests can't both slip past the limit. See `src/lib/usageCounters.ts`.

---

## Object Storage (Attachments)

Issue attachments go to an **S3-compatible** object store via the AWS SDK (`src/lib/s3.ts`):

- **Local development:** SeaweedFS (started by `docker compose`), reached at `S3_ENDPOINT`.
- **Production:** **Backblaze B2** (B2's S3-compatible API). Point the `S3_*` variables at your B2 bucket, endpoint, and application keys.

Uploads use a **reserve → upload → commit** flow: a reservation claims storage quota up front; if the client never finishes the upload within `ATTACHMENT_RESERVATION_TTL_MINUTES`, the reservation is treated as abandoned and its quota is released. `ATTACHMENT_MAX_FILE_SIZE_MB` caps any single file regardless of remaining plan headroom.

> Note: the AWS SDK requires a `S3_REGION` even for non-AWS endpoints; S3-compatible stores like SeaweedFS ignore its value, and for B2 it should match your bucket's region.

---

## Environment Variables

See [`.env.example`](.env.example) for the authoritative list with inline comments. Summary:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `FRONTEND_URL` | Comma-separated allowed CORS origins (the SPA runs on a different origin) |
| `LOG_LEVEL` | Pino level: `trace`…`fatal` |
| `DATABASE_URL` | Superuser connection — **migrations only** |
| `APP_DATABASE_URL` | `app_user` — runtime queries, RLS-enforced |
| `AUTH_DATABASE_URL` | `auth_reader` — login lookup only |
| `PLATFORM_DATABASE_URL` | `platform_reader` — platform-admin read-only |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | Object-store location (SeaweedFS locally, Backblaze B2 in prod) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Object-store credentials |
| `ATTACHMENT_RESERVATION_TTL_MINUTES` | How long a reserved-but-not-uploaded attachment holds its quota |
| `ATTACHMENT_MAX_FILE_SIZE_MB` | Hard per-file size cap |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | JWT signing secret and token lifetime |

---

## Testing

```bash
npm test
```

Tests run against a real PostgreSQL instance (the Docker Compose dev container) and cover tenant isolation, plan-limit concurrency, project membership, platform-admin access, and attachment flows. Two standalone audits — `npm run audit:leak` (data-leak check) and `npm run audit:spec` (OpenAPI drift) — guard the isolation and documentation invariants.

---

## Project Structure

```
src/
  app.ts            # Express app + route mounting
  index.ts          # Server entry point
  env.ts            # Validated environment config
  routes/           # HTTP routing per resource
  services/         # Business logic
  validators/       # Zod request schemas
  middleware/       # auth/tenant context, role checks, error handling, logging
  lib/              # DB clients (app/auth/platform), RLS context, S3, JWT, quotas
  generated/prisma/ # Generated Prisma client
prisma/
  schema.prisma     # Data model + enums (incl. the Role enum)
  migrations/       # SQL migrations (incl. the DB-role creation migrations)
  seed.ts           # Seeds plans + bootstrap PLATFORM_ADMIN
docs/openapi.yaml   # OpenAPI spec (served at /docs)
```
