# TaskFlow API — Frontend Integration Guide

Everything you need to build the TaskFlow SPA against this backend. Written for a frontend developer joining with no prior context on the server.

The live, browsable version of this contract is **Swagger UI at http://localhost:3000/docs**. This document covers what the spec cannot tell you: conventions, gotchas, and the reasoning behind the parts that look unusual.

---

## 1. The one rule

**Never send an organisation id to this API.** Not in a body, not in a query string.

The bearer token already carries the caller's organisation, and the server derives every scope from it. This is the backbone of the whole system: tenant isolation is enforced in PostgreSQL through Row-Level Security, so a request simply cannot reach another tenant's rows, whatever the client asks for.

```http
GET /api/projects?organisationId=org-123   ❌ never
GET /api/projects                          ✅ scope comes from the token
```

You will notice there is no `organisationId` field in any request type. That is deliberate — if you find yourself wanting one, the endpoint you need probably doesn't exist yet (see §10).

A practical consequence: **a resource belonging to another tenant returns `404`, not `403`.** That is intentional — `403` would confirm the id exists. Render it as an ordinary "not found".

---

## 2. Run the backend

Requires Docker and Node.js 24+.

```bash
docker compose up -d          # PostgreSQL :5432, SeaweedFS S3 :8333
npm install
npx prisma migrate deploy     # create schema, roles, RLS policies
npm run db:seed               # plan tiers + the bootstrap platform admin
npm run dev                   # API on :3000
```

Check it: `curl http://localhost:3000/health` → `{"status":"ok"}`

| Service | URL |
|---|---|
| API | `http://localhost:3000/api` |
| Swagger UI | `http://localhost:3000/docs` |
| SeaweedFS S3 | `http://localhost:8333` |

**Seeded platform admin:** `platform-admin@taskflow.local` / `change-me-in-production` (override with `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` before seeding). There is deliberately no API route that can create a `PLATFORM_ADMIN` — the seed is the only source.

### CORS

The API allows origins listed in `FRONTEND_URL` (comma-separated), defaulting to `http://localhost:5173`. If your dev server runs anywhere else, set it in the backend's `.env` and restart — otherwise **every request fails in the browser before reaching your code**, while the same call works fine in curl or Postman. That mismatch is the single most common source of lost time here.

---

## 3. Generate the API client — don't hand-write it

The API spec is verified against the running server: `npm run audit:spec` on the backend fails if any documented operation isn't actually served, and every operation has a stable `operationId`. Generate your client from it rather than writing fetch calls by hand, so a backend change surfaces as a TypeScript error instead of a runtime bug.

### Sync the spec, don't copy it

The backend serves the contract at **`GET http://localhost:3000/openapi.json`** (`no-store`, so you always get the current one). Pull it into the frontend repo with a script rather than pasting a copy in — a pasted copy still generates a client that compiles perfectly while describing an API that no longer exists.

```jsonc
// package.json
"scripts": {
  "api:sync":     "curl -fsSL http://localhost:3000/openapi.json -o src/api/openapi.json",
  "api:generate": "orval",
  "api:update":   "npm run api:sync && npm run api:generate"
}
```

**Commit both `src/api/openapi.json` and the generated client.** That keeps builds and CI working without a running backend, and makes every API change show up as a reviewable diff in your PR instead of an invisible behaviour change.

### Orval config

[Orval](https://orval.dev) fits the required stack best — it emits typed Axios functions, TanStack Query hooks, and Zod schemas from one config:

```ts
// orval.config.ts
export default {
  taskflow: {
    input: './src/api/openapi.json',   // the synced snapshot, not a URL
    output: {
      target: './src/api/generated.ts',
      client: 'react-query',
      mode: 'tags-split',          // one module per tag: Auth, Projects, Issues…
      override: { mutator: { path: './src/api/axios.ts', name: 'apiClient' } },
    },
  },
};
```

Generating from the committed snapshot rather than the URL keeps `npm run api:generate` reproducible offline; `api:sync` is the only step that needs the backend up. Lighter alternative if you'd rather own the fetch layer: `openapi-typescript` + `openapi-fetch`.

The `operationId`s become your function names — `listProjects`, `getCurrentUser`, `reserveAttachment`, `commitAttachment`, and so on.

### Catching drift

Because the snapshot is committed, staleness is detectable. Add this to CI (with the backend running) to fail a build whose client no longer matches the API:

```bash
npm run api:update && git diff --exit-code src/api/
```

Note `GET /docs/openapi.json` returns the same JSON, but prefer `/openapi.json` — anything *else* under `/docs/` is answered by the Swagger UI page as `200 text/html`, which fails confusingly in a generator.

---

## 4. Authentication

```
POST /api/auth/signup   → { token, organisation, user }   creates org + first admin
POST /api/auth/login    → { token, user }
GET  /api/auth/me       → { user, organisation }          call on app boot
POST /api/auth/logout   → 204
```

Send the token as `Authorization: Bearer <token>` on every other request. It expires after **1 hour** by default (`JWT_EXPIRES_IN`).

**Restore sessions with `GET /api/auth/me`, never by decoding the JWT.** The token is a snapshot — it keeps asserting the role it was minted with until it expires. If an admin deactivates or demotes someone mid-session, only the server knows. `/auth/me` re-reads the database and returns `401` if the account is gone or no longer `ACTIVE`; a decoded token would happily keep showing admin UI. Treat the token as opaque.

Logout is client-side (tokens are stateless and not revocable server-side); the endpoint exists so the event is logged.

### Token storage

`localStorage` is simplest and is fine for this POC — but be aware it is readable by any script on the page, so an XSS becomes a full account takeover. Production would move to an httpOnly cookie, which is why CORS is already configured with `credentials: true`. Whichever you choose, keep reads behind one module so it's a single change later.

### Axios interceptor

```ts
apiClient.interceptors.response.use(undefined, (error) => {
  const status = error.response?.status;
  if (status === 401) { clearToken(); redirectToLogin(); }   // expired or revoked
  if (status === 403) toast('You do not have permission to do that.');
  if (status === 409) toast(error.response.data.message);    // plan limits — already human-readable
  return Promise.reject(error);
});
```

---

## 5. Response conventions

### ⚠️ Requests are camelCase, responses are snake_case

This is the one wart worth knowing up front. Request bodies use `firstName`; responses return the database row, so you get `first_name`:

```jsonc
// POST /api/users  →  request
{ "email": "…", "firstName": "Ada", "lastName": "Lovelace", "role": "ORG_MEMBER" }

// …response
{ "id": "…", "organisation_id": "…", "first_name": "Ada", "role": "ORG_MEMBER", "created_at": "…" }
```

`GET /api/organisation/usage` is the exception — it is hand-built and camelCase throughout. Generated types will reflect all of this correctly; just don't assume symmetry. Timestamps are ISO 8601 strings.

### Pagination

Every list endpoint takes `?page=&limit=` and returns the same envelope. `limit` defaults to 20 and is capped at 100 (an unbounded page size would let one request pull a whole table into memory).

```jsonc
{
  "items": [ /* … */ ],
  "pagination": { "page": 1, "limit": 20, "total": 120, "totalPages": 6 }
}
```

**Exception:** `GET …/attachments` returns a bare array — an issue's file list is inherently small.

### Errors

Every error is `{ code, message }`, except validation, which carries `fields` instead:

```jsonc
{ "code": "CONFLICT", "message": "Projects limit reached: 3 of 3 projects used on the Starter plan" }

{ "code": "VALIDATION_ERROR",
  "fields": { "email": ["Invalid email address"], "password": ["Too small: expected string to have >=8 characters"] } }
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Bad input. Has `fields`, not `message`. |
| `UNAUTHORIZED` | 401 | Missing, invalid, or expired token; deactivated account. |
| `FORBIDDEN` | 403 | Authenticated but wrong role. |
| `NOT_FOUND` | 404 | Missing **or** belongs to another tenant. |
| `CONFLICT` | 409 | Plan limit reached, duplicate slug/email, last-admin protection. |
| `PAYLOAD_TOO_LARGE` | 413 | File over the per-file cap. |
| `INTERNAL_ERROR` | 500 | Unexpected. |

Note `fields` values are **arrays** of messages. Mapping them into React Hook Form:

```ts
if (error.response?.data?.code === 'VALIDATION_ERROR') {
  for (const [field, messages] of Object.entries(error.response.data.fields)) {
    setError(field, { message: messages[0] });
  }
}
```

Plan-limit `409` messages are written for humans — surface `message` directly rather than inventing your own copy. (Heads up: plan limits currently use the generic `CONFLICT` code rather than a specific `PLAN_LIMIT_REACHED`, so branch on the message or the endpoint if you need to distinguish them from a duplicate-slug conflict.)

---

## 6. File uploads — a three-step flow

Files never pass through the API. The browser uploads **directly to SeaweedFS** via a presigned URL, so the server stays out of the byte path.

```
1. POST   /api/projects/{projectId}/issues/{issueId}/attachments/reserve
          { fileName, contentType, sizeBytes }
          → { attachment, uploadUrl }          claims quota, returns a presigned PUT

2. PUT    <uploadUrl>                          the raw File, straight to SeaweedFS
          Content-Type: <same contentType>

3. POST   /api/projects/{projectId}/issues/{issueId}/attachments/{id}/commit
          → attachment                          server verifies the bytes landed
```

```ts
const { attachment, uploadUrl } = await reserveAttachment(projectId, issueId, {
  fileName: file.name, contentType: file.type, sizeBytes: file.size,
});
await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
await commitAttachment(projectId, issueId, attachment.id);
```

Rules that will bite you if missed:

- **Use plain `fetch`/`axios` for step 2, not your API client** — sending an `Authorization` header to S3 invalidates the signature.
- **`Content-Type` on the PUT must exactly match what you sent to `reserve`.** It is part of the signature; a mismatch fails with `SignatureDoesNotMatch`.
- **SeaweedFS needs its own CORS configuration.** Step 2 goes to `:8333`, a different origin from the API, so Express's CORS settings do not apply.
- **An upload isn't real until you commit.** `reserve` verifies nothing; `commit` runs a server-side `HeadObject` and reconciles the quota against the actual size. Uncommitted reservations expire after 15 minutes and their quota is released.
- Only `COMMITTED` attachments appear in `GET …/attachments`.
- Allowed types: PNG, JPEG, GIF, WebP, PDF, plain text, CSV, JSON, ZIP, Word, Excel. HTML and SVG are deliberately excluded (stored-XSS risk).
- Per-file cap is 200 MB (`ATTACHMENT_MAX_FILE_SIZE_MB`), independent of remaining plan quota. Validate `file.size` client-side to fail fast.

---

## 7. Endpoint reference

All paths are relative to `http://localhost:3000/api`. All require a bearer token except signup and login.

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | Creates org + first `ORG_ADMIN` + plan, in one transaction. |
| POST | `/auth/login` | |
| GET | `/auth/me` | Session restore. Revalidates against the database. |
| POST | `/auth/logout` | |

### Own organisation
| Method | Path | Notes |
|---|---|---|
| GET | `/organisation` | The caller's own org. No id in the path, by design. |
| GET | `/organisation/usage` | Live plan limits + usage. Drives the dashboard. |

### Users — the caller's own organisation
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/users` | any member | Paginated. Members need it for assignee pickers. |
| GET | `/users/{id}` | any member | |
| POST | `/users` | `ORG_ADMIN` | Claims a seat; `409` when the plan is full. |
| PATCH | `/users/{id}` | `ORG_ADMIN` | Name, role, status. |
| DELETE | `/users/{id}` | `ORG_ADMIN` | Frees the seat. |

`PATCH`/`DELETE` return `409` if the change would leave the org with no active admin, or if you target yourself with `DELETE`. `PLATFORM_ADMIN` is never assignable.

### Projects
| Method | Path |
|---|---|
| GET | `/projects` (paginated) |
| POST | `/projects` |
| GET / PATCH / DELETE | `/projects/{id}` |

Deleting a project also deletes its issues and attachments, and releases all the quota they held.

### Issues (tasks)
| Method | Path |
|---|---|
| GET | `/projects/{projectId}/issues` (paginated) |
| POST | `/projects/{projectId}/issues` |
| GET / PATCH / DELETE | `/projects/{projectId}/issues/{id}` |

`status`: `TODO` · `IN_PROGRESS` · `DONE` — enough for a Kanban board, moved with `PATCH`.
`priority`: `LOW` · `MEDIUM` · `HIGH`.

### Attachments
| Method | Path |
|---|---|
| POST | `…/attachments/reserve` |
| POST | `…/attachments/{id}/commit` |
| GET | `…/attachments` (bare array) |
| GET / DELETE | `…/attachments/{id}` |

### Platform admin (`PLATFORM_ADMIN` only)
| Method | Path |
|---|---|
| GET | `/organisations` (paginated — name, plan, aggregate usage, status) |
| POST | `/organisations` |
| GET | `/organisations/{id}` |
| GET | `/organisations/{orgId}/users` (paginated) |

These run over a separate, read-only database connection with no access to any tenant's projects, issues, or attachments — enforced by PostgreSQL privileges, not just application checks. **The platform-admin UI must not contain any tenant content screens.**

---

## 8. Roles

| Role | Can |
|---|---|
| `ORG_MEMBER` | Read the org directory; full CRUD on projects and tasks. |
| `ORG_ADMIN` | Everything above, plus managing members. |
| `PLATFORM_ADMIN` | Org metadata across tenants. **No** tenant content. |

Gate UI on `user.role` from `/auth/me`, and let the server be the real authority — a hidden button is convenience, not security.

---

## 9. Screens → endpoints

| Screen | Endpoints |
|---|---|
| Login / Signup | `POST /auth/login`, `POST /auth/signup` |
| App shell / session | `GET /auth/me` |
| Dashboard | `GET /organisation`, `GET /organisation/usage` |
| Usage | `GET /organisation/usage` — render `used`/`limit` as progress bars |
| Users | `GET /users`, `POST /users`, `PATCH|DELETE /users/{id}` |
| Project list | `GET /projects` (+ `POST`) |
| Project detail | `GET /projects/{id}`, `GET /projects/{id}/issues` |
| Task board | `GET …/issues`, `PATCH …/issues/{id}` to move columns |
| Task detail | `GET …/issues/{id}`, attachments endpoints |
| Platform admin | `GET /organisations` (list), `GET /organisations/{id}`, `GET /organisations/{orgId}/users` |

Plan limits are worth surfacing well — they are the most interesting behaviour in this backend. Read `/organisation/usage` to disable a "New project" button at the limit, and still handle the `409`, since another admin may take the last slot first.

---

## 10. Not available yet

Plan around these — they are specified but not built. Don't design screens that depend on them:

- **Comments on tasks** — no entity, no endpoints.
- **Invitations** — `POST /users` creates an account with a password directly; there is no invite/accept flow, so an "Accept invitation" screen has nothing to call.
- **Task assignment** — issues have no `assigneeId`, `reporterId`, or `dueDate`. No assignee picker is possible yet.
- **Project `key`** (the `WEB-123` style identifier) and `createdBy`.
- **Audit log** — events are written to structured server logs only; nothing is queryable.
- **Changing an org's plan** — limits are fixed at signup.

---

## 11. Checklist before you start

- [ ] Backend reachable: `curl http://localhost:3000/health`
- [ ] `FRONTEND_URL` in the backend `.env` matches your dev server origin
- [ ] `npm run audit:spec` passes on the backend (spec matches the server)
- [ ] Spec synced from `GET /openapi.json` and committed, client generated from it
- [ ] Axios interceptor handles 401 / 403 / 409
- [ ] `VALIDATION_ERROR.fields` wired into React Hook Form
- [ ] Session restored via `/auth/me`, not by decoding the token
- [ ] No `organisationId` sent anywhere
- [ ] SeaweedFS CORS configured before attempting uploads
