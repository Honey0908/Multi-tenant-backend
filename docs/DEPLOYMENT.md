# Deploying TaskFlow (Render + Backblaze B2)

This replaces local `docker-compose.yml` (Postgres + SeaweedFS containers) with
managed equivalents. You write a `Dockerfile` for the app only — Render builds
and runs it; Postgres and object storage become managed services instead of
containers you operate yourself.

```
Local dev                      Production
───────────────────────────────────────────────────
postgres container     ──▶     Render Postgres (managed)
seaweedfs container     ──▶     Backblaze B2 (S3-compatible)
npm run dev             ──▶     Render Web Service, built from Dockerfile
```

Backblaze B2 over Cloudflare R2 here specifically because B2's free tier
(10 GB storage) needs no card on file — R2 requires one even to stay within
its free tier.

## 1. Push to GitHub

Render deploys by connecting to a git repo. If this repo isn't on GitHub yet,
create one and push this branch.

## 2. Create the Backblaze B2 bucket

1. Backblaze dashboard → **B2 Cloud Storage** → **Buckets** → **Create a Bucket**,
   e.g. `taskflow-attachments`, type **Private**. Creating it here (rather than
   letting the app's `ensureBucketExists()` try to create it at boot) sidesteps
   any quirks around the S3 `CreateBucket` call.
2. On that bucket's details page, note the **Endpoint**, e.g.
   `s3.us-east-005.backblazeb2.com` — the part after `s3.` and before
   `.backblazeb2.com` (here, `us-east-005`) is your region.
3. **App Keys** → **Add a New Application Key** → restrict it to this bucket →
   note the **keyID** and **applicationKey** (the applicationKey is shown only
   once — save it now).

These map directly to the app's existing env vars:

| Env var | Value |
|---|---|
| `S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` (e.g. `https://s3.us-east-005.backblazeb2.com`) |
| `S3_ACCESS_KEY_ID` | the application key's **keyID** |
| `S3_SECRET_ACCESS_KEY` | the **applicationKey** |
| `S3_BUCKET` | `task-flow-attachments` |
| `S3_REGION` | the region from the endpoint, e.g. `us-east-005` |

## 3. Create the Render Postgres instance

Render dashboard → **New → PostgreSQL**. Once created, Render gives you one
superuser connection string — this is your `DATABASE_URL` (migrations only,
same role as local `postgres` superuser in `docker-compose.yml`).

## 4. Run migrations, then rotate the generated role passwords

Try this from your machine first, with Node 24 and `DATABASE_URL` pointed at
the Render Postgres superuser string:

```bash
DATABASE_URL="<render-superuser-url>" npx prisma migrate deploy
```

**If that times out:** some ISPs/networks block outbound port 5432 entirely
(this is what happened during setup — confirmed by a raw TCP test timing out
over two different networks). If so, don't fight it locally — use the
`.github/workflows/db-admin.yml` workflow instead, which runs the same
commands from a GitHub Actions runner (not behind your network):

1. Push this repo to GitHub (see step 1) if you haven't already.
2. Repo → **Settings → Secrets and variables → Actions** → add a secret
   `RENDER_DATABASE_URL` = the Render Postgres **superuser** external URL.
3. Repo → **Actions** tab → **DB Admin (manual)** → **Run workflow** →
   input `migrate` → **Run workflow**. Check the run's logs for
   `All migrations have been successfully applied.`

Either way, this creates the schema **and** the three restricted roles the
app connects as (`app_user`, `auth_reader`, `platform_reader`) — but the
migration files hardcode dev passwords (matching the role names) since
they're meant to be harmless in local dev. Those passwords are sitting in
plaintext in this repo's git history, so for production, rotate them
immediately:

```bash
openssl rand -base64 24   # run three times, save each output
```

Then, same workflow, different secrets and input:

1. Add three more repo secrets: `APP_USER_PASSWORD`, `AUTH_READER_PASSWORD`,
   `PLATFORM_READER_PASSWORD` — one generated password each, from above.
2. **Actions → DB Admin (manual) → Run workflow** → input
   `rotate-passwords` → **Run workflow**. Logs should end with
   `Rotated app_user / auth_reader / platform_reader passwords.`

(If your network *can* reach port 5432, you can instead do this rotation
locally with any Postgres client, e.g. `psql "<render-superuser-url>"`,
running `ALTER ROLE app_user PASSWORD '...';` for each of the three roles.)

## 5. Build the four `*_DATABASE_URL` values

Same host/port/database from Render, different user + the password you just
set per role:

| Env var | User |
|---|---|
| `DATABASE_URL` | Render's superuser (used only for `prisma migrate`) |
| `APP_DATABASE_URL` | `app_user` |
| `AUTH_DATABASE_URL` | `auth_reader` |
| `PLATFORM_DATABASE_URL` | `platform_reader` |

## 6. Create the Render Web Service

Render dashboard → **New → Web Service** → connect the repo → runtime:
**Docker** (it will find the `Dockerfile` at the repo root automatically) →
health check path: `/health`.

Set these environment variables in the Render dashboard (values from the
steps above, plus the remaining ones from `.env.example`):

| Env var | Notes |
|---|---|
| `PORT` | Render sets this itself — you can leave your own unset |
| `FRONTEND_URL` | your frontend's real origin, for CORS |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` / `APP_DATABASE_URL` / `AUTH_DATABASE_URL` / `PLATFORM_DATABASE_URL` | from step 5 |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` / `S3_REGION` | from step 2 |
| `ATTACHMENT_RESERVATION_TTL_MINUTES` | `15` (or your preference) |
| `ATTACHMENT_MAX_FILE_SIZE_MB` | `200` (or your preference) |
| `JWT_SECRET` | generate with `openssl rand -base64 48` — **not** the dev default |
| `JWT_EXPIRES_IN` | `1h` |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | used once by `prisma/seed.ts`, pick real values |

## 7. Deploy

Render builds the `Dockerfile` and starts the container. Check the deploy
logs for `TaskFlow API listening on port ...`, then hit `https://<your-service>.onrender.com/health`.

## 8. Seed the platform admin (once)

Render dashboard → your service → **Shell**, then:

```bash
npm run db:seed
```

This creates the bootstrapped `PLATFORM_ADMIN` user using the
`PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` you set in step 6.

## After this

- When your frontend gets its own deployment, update `FRONTEND_URL` to match
  — until then, browser requests from it will be blocked by CORS.
- Treat every secret here (`JWT_SECRET`, the rotated role passwords, B2 keys)
  as production credentials: only in Render's env var store, never committed.
