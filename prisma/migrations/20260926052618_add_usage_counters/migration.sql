-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('PROJECTS', 'TASKS', 'USERS');

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "resource_type" "ResourceType" NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "max_limit" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageCounter_organisation_id_idx" ON "UsageCounter"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_organisation_id_resource_type_key" ON "UsageCounter"("organisation_id", "resource_type");

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security, identical policy shape to User/Project/Issue (see
-- enable_rls and harden_org_id_policy): fails closed to zero rows when
-- app.org_id isn't set, via the current_org_id() guard function.
ALTER TABLE "UsageCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageCounter" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "UsageCounter"
USING ("organisation_id" = current_org_id());

-- The running app connects as `app_user` (see create_app_role), which needs
-- explicit CRUD grants here even though ALTER DEFAULT PRIVILEGES was set up
-- for future tables — that default only applies to tables created by the
-- same session/role that ran the ALTER, so we grant explicitly for clarity
-- and to not depend on that assumption holding.
GRANT SELECT, INSERT, UPDATE, DELETE ON "UsageCounter" TO app_user;

-- Deliberately NOT granted to `platform_reader` (see create_platform_reader_role):
-- usage counters are operational/billing data, not "org-level metadata".
