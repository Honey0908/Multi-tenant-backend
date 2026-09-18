# 🗺️ 14-Day Solo Execution Plan: Multi-Tenant Subscription Management POC

## 1. Project Core Domain: "TaskFlow"
A Jira/Zoho-style project and task management system trimmed to explicitly satisfy and stress-test the tracking brief's functional parameters.

### Structural Entity Hierarchy
```text
Organisation (Tenant Workspace)
  └─ SubscriptionPlan (Hard Limits Configurator)
  └─ User (Role-Scoped: ORG_ADMIN, MEMBER, PLATFORM_ADMIN)
  └─ Project (Core Restricted Resource Count)
       └─ Issue (Task Tracking Nodes)
            └─ Attachment (Metadata rows synced to SeaweedFS S3 storage bucket)
```

---

## 🛠️ The Local Free Open-Source Stack

* **Language Runtime:** Node.js 24 + TypeScript (MIT)
* **API Routing Engine:** Express.js v5 (MIT)
* **Data Access Layer:** Prisma ORM (Apache-2.0)
* **Primary Database Engine:** PostgreSQL 17 (PostgreSQL License)
* **Local S3 Object Storage Provider:** SeaweedFS Container (Apache-2.0)
* **Interactive Contract Documentation:** Swagger UI Express + OpenAPI 3.0 YAML (MIT)
* **Input Validation Guard:** Zod (MIT)
* **Test Isolation Harness:** Vitest + Testcontainers Node (MIT)

---

## 🗓️ Day-by-Day Implementation Roadmap

### 📦 Phase 0 — Environment & Schema Initialization (Days 1–3)

#### Day 1: Single-Command Container Foundations
- [ ] Initialize your project folder: `npm init -y` and set up your TypeScript configuration variables (`tsconfig.json`).
- [ ] Install your runtime dependencies (`express`, `@prisma/client`, `zod`, `pino`, `swagger-ui-express`, `yamljs`).
- [ ] Construct your central infrastructure `docker-compose.yml` defining two core nodes:
  1. **PostgreSQL 17** with operational database names and default credentials.
  2. **SeaweedFS** running in local single-server S3 emulation mode.
- [ ] Verify that a single `docker compose up` command boots both engines with completely green health checks.

#### Day 2: The Multi-Tenant Prisma Blueprint
- [ ] Initialize Prisma (`npx prisma init`) and sketch your structural schema models inside `prisma/schema.prisma`.
- [ ] Configure multi-part **Composite Unique Constraints** `@@unique([organisation_id, id])` on all content models (`Project`, `Issue`).
- [ ] Define downstream **Composite Foreign Keys** so child entries link natively back to parent lines through the matching tenant ID:
  ```prisma
  model Issue {
    id              String       @id @default(uuid())
    organisation_id String
    project_id      String
    project         Project      @relation(fields: [organisation_id, project_id], references: [organisation_id, id])
    @@unique([organisation_id, id])
  }
  ```

#### Day 3: Designing the PostgreSQL Security Policies
- [ ] Generate an isolated migration draft using `npx prisma migrate dev --create-only --name enable_rls`.
- [ ] Open the raw SQL file generated inside `prisma/migrations/` and write the ironclad **Row-Level Security (RLS)** initialization commands.
- [ ] Append the missing context variable fallback (`NULLIF`) validation guard. This ensures any database lookup attempted without active tenant credentials returns 0 rows instead of failing silently or leaking global table arrays:
  ```sql
  ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;

  CREATE POLICY tenant_isolation_policy ON "Project"
  USING (
    NULLIF(current_setting('app.org_id', true), '') IS NOT NULL 
    AND "organisation_id" = current_setting('app.org_id', true)::uuid
  );
  ```
- [ ] Apply the completed configuration: `npx prisma migrate deploy`.

---

### 🛡️ Phase 1 — Interactive UI & Runtime Isolation (Days 4–7)

#### Day 4: Interactive API Contract Implementation
- [ ] Design and save your central API specification file as `docs/openapi.yaml` using clean OpenAPI 3.0 format rules.
- [ ] Map out paths, methods, validation payloads, and explicit response error structures (`404` vs `409`).
- [ ] Wire up your local documentation server endpoint using `swagger-ui-express` inside your web application server startup routes:
  ```typescript
  import swaggerUi from 'swagger-ui-express';
  import YAML from 'yamljs';
  const openApiDoc = YAML.load('./docs/openapi.yaml');
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));
  ```
- [ ] Boot your system, load `http://localhost:3000/docs` inside your local browser, and verify that your documentation maps cleanly.

#### Day 5: Constructing the Runtime Client Extension
- [ ] Code your central database entry point inside `src/lib/db.ts`.
- [ ] Leverage **Prisma Client Extensions** to intercept incoming system lookups dynamically.
- [ ] Force all operations down a strict transactional loop execution sequence, binding your runtime setting to the local database session memory block before running any developer commands:
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

#### Day 6: Request Interception Middleware Hooks
- [ ] Set up an execution tracking context pipeline via Node's internal `AsyncLocalStorage` engine.
- [ ] Write your global application route protection middleware (`src/middleware/tenantContext.ts`).
- [ ] Instruct the app middleware to capture incoming `Authorization: Bearer <JWT>` request parameters, unpack the user's secure metadata array payload, and inject the organizational data directly into active local processing memory.

#### Day 7: Automated Isolation Target Testing
- [ ] Configure your testing framework utilizing **Vitest** paired with automated **Testcontainers**.
- [ ] Seed your running container instances with overlapping database record rows (e.g., Company A and Company B both possessing a child project record containing the exact string ID `prj-1111`).
- [ ] **The Center of Gravity Proof Check:** Write an automated test case attempting to call a project detail route while authenticated as a foreign workspace member. Assert that your server returns an explicit `404 Not Found` response code.

---

### 🚀 Phase 2 — Transactions, Capacity Limits & Onboarding (Days 8–11)

#### Day 8: Atomic Self-Service Onboarding Logic
- [ ] Code your open registration business route handler (`POST /api/auth/signup`).
- [ ] Implement explicit **Zod Validation Handlers** to filter and sanitize incoming user payloads at the edge before they can interact with database business layers.
- [ ] Wrap your workspace creations inside a single multi-stage backend transaction sequence:
  1. Deduplicate email string listings.
  2. Provision the parent `Organisation` row profile.
  3. Map a standard default base tier `SubscriptionPlan`.
  4. Register the primary root administrator user account.
- [ ] **The Rollback Checklist Check:** Intentionally inject bad schema data midway through execution. Assert that the entire sequence fails as an all-or-nothing action block, leaving zero orphaned record rows behind in database memory.

#### Day 9: Atomic Counter Quota Enforcements
- [ ] Establish an explicit metrics calculation table (`usage_counters`) mapping active workspace allocations (such as `seats`, `projects`, `storage_bytes`).
- [ ] Implement asset allocation adjustments using single atomic updates directly at the database layer rather than counting records inside memory arrays:
  ```sql
  UPDATE usage_counters 
  SET value = value + 1 
  WHERE org_id = $1 AND resource_type = 'projects' AND value + 1 <= max_limit
  RETURNING *;
  ```
- [ ] Instruct your system to fail with an explicit `409 Conflict` status code containing structured feedback indicators (e.g., `"Seat limit reached: 3 of 3 seats used on the Free plan"`) if the returned database modification updates match 0 altered lines.

#### Day 10: Structural Race-Condition Verifications
- [ ] Design your automated concurrency isolation testing harness using your local testing setup.
- [ ] Configure a mock tenant workspace that sits exactly one item away from its subscription ceiling allocation limit (e.g., 2 out of 3 projects currently created).
- [ ] Use concurrent execution commands to dispatch **two simultaneous, parallel creation requests** into the API processing pipelines at the exact same millisecond.
- [ ] Assert that exactly one execution loop returns a `201 Created` status marker, while the lagging operation maps cleanly to a `409 Conflict` response code.

#### Day 11: Two-Step Secure Object Storage Workflows
- [ ] Implement an allocation tracking system to manage file attachments securely without slowing down your app server.
- [ ] **Step 1 (Reservation):** Create `POST /api/attachments/reserve`. The user submits their intended file payload sizes. Your server logs the requested bytes against their usage limits and generates a temporary, secure **SeaweedFS Presigned S3 Upload URL**.
- [ ] **Step 2 (Confirmation):** Create `POST /api/attachments/commit`. Once the user completes their direct file upload to SeaweedFS, your server runs a secure backend server-side S3 `HeadObject` lookup check to verify the actual file size on disk before locking down the asset entry row permanently.

---

### 🛡️ Phase 3 — Administrative Walls & Observability (Days 12–14)

#### Day 12: Separation of Platform Administration Contexts
- [ ] Create a completely separate database connection route interface mapped strictly to a low-level, non-privileged database user account role (`platform_reader`).
- [ ] Set database read rights using explicit GRANT rules, restricting the account so it can only access high-level organizational metadata rows (plans, subscriptions, aggregate usage numbers).
- [ ] Write an automated test case showing that if an admin account attempts to execute lookup queries targeting row details on inner client content tables (Issues, Comments), the database engine blocks the query with an explicit permission error.

#### Day 13: Leak Discovery Scanners & Structural Audit Trails
- [ ] Wire up your central structured logger platform (pino) to track actions dynamically. Ensure all onboarding pipelines, allocation limit failures, and unauthorized cross-tenant validation errors print out as clear JSON structures.
- [ ] Code a standalone administrative data scanner script. This utility sweeps across all tables using inner-join logic to verify that no child record rows have foreign keys pointing to data outside their parent organization's ID:
  ```sql
  -- The Leak Audit Scan Query
  SELECT i.id FROM "Issue" i
  JOIN "Project" p ON i.project_id = p.id
  WHERE i.organisation_id != p.organisation_id;
  ```

#### Day 14: Clean Project Compilation & Walkthrough Preparation
- [ ] Tear down all local system volumes, flush local storage containers, and run a fresh `docker compose up --build` check from a completely clean setup.
- [ ] Run your entire validation suite, ensuring every single testing loop finishes green with zero manual interventions.
- [ ] Finalize your documentation references, structure your workspace directories, and prepare your project walkthrough script.

---

## 📋 Evaluation Quality Matrix Tracker

Use this quick-reference matrix during development to ensure that your technical implementations line up with your evaluation standards:

| Code Deliverable | Engineering Validation Method | Evaluation Verification Metric |
|---|---|---|
| `prisma/schema.prisma` | Compound Key Structures | Database cascades down structural deletes clean through internal schemas. |
| `prisma/migrations/*_rls.sql` | Database Fail-Safe Boundaries | Raw queries attempted without an active session context return 0 rows. |
| `src/lib/db.ts` | Automatic Operational Wrappers | Developers can write standard queries without typing explicit manual filters. |
| `src/__tests__/concurrency.test.ts` | High-Volume Parallel Lookups | Serialized update paths block seat allocation bypasses under load. |
| `docs/openapi.yaml` | Interactive API Testing Docs | Reviewers can log in and test your endpoints directly from a live browser page. |