-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLATFORM_ADMIN', 'ORG_ADMIN', 'ORG_MEMBER');

-- CreateEnum
CREATE TYPE "OrganisationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "IssuePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "max_users" INTEGER NOT NULL,
    "max_projects" INTEGER NOT NULL,
    "max_tasks" INTEGER NOT NULL,
    "max_storage_mb" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organisation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganisationStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ORG_MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'TODO',
    "priority" "IssuePriority" NOT NULL DEFAULT 'MEDIUM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_name_key" ON "SubscriptionPlan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_slug_key" ON "Organisation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organisation_id_idx" ON "User"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_organisation_id_id_key" ON "User"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "Project_organisation_id_idx" ON "Project"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organisation_id_id_key" ON "Project"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "Issue_organisation_id_project_id_idx" ON "Issue"("organisation_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_organisation_id_id_key" ON "Issue"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_organisation_id_project_id_fkey" FOREIGN KEY ("organisation_id", "project_id") REFERENCES "Project"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for tenant-scoped tables.
-- "app.org_id" is set per-request via SET LOCAL inside a transaction
-- (see src/lib/db.ts). With no org_id set, current_setting(..., true)
-- returns NULL/'' and every row is filtered out — fail closed, not open.

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "User"
USING (
  NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
  AND "organisation_id" = current_setting('app.org_id', true)::uuid
);

ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "Project"
USING (
  NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
  AND "organisation_id" = current_setting('app.org_id', true)::uuid
);

ALTER TABLE "Issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Issue" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "Issue"
USING (
  NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
  AND "organisation_id" = current_setting('app.org_id', true)::uuid
);
