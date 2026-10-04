-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "assignee_id" UUID;

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMember_organisation_id_user_id_idx" ON "ProjectMember"("organisation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_project_id_user_id_key" ON "ProjectMember"("project_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_organisation_id_id_key" ON "ProjectMember"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "Issue_organisation_id_assignee_id_idx" ON "Issue"("organisation_id", "assignee_id");

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_organisation_id_project_id_fkey" FOREIGN KEY ("organisation_id", "project_id") REFERENCES "Project"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_organisation_id_user_id_fkey" FOREIGN KEY ("organisation_id", "user_id") REFERENCES "User"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_organisation_id_assignee_id_fkey" FOREIGN KEY ("organisation_id", "assignee_id") REFERENCES "User"("organisation_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row-Level Security, identical shape to every other tenant table (see
-- enable_rls / harden_org_id_policy): zero rows unless app.org_id matches.
ALTER TABLE "ProjectMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMember" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "ProjectMember"
USING ("organisation_id" = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectMember" TO app_user;

-- Deliberately NOT granted to `platform_reader`: who works on which project
-- is tenant content, not org-level metadata.

-- No backfill. Existing projects start with no members, so after this
-- migration an ORG_MEMBER sees none of them until an ORG_ADMIN adds them via
-- POST /api/projects/:projectId/members. ORG_ADMINs are unaffected — they
-- see every project in their organisation regardless of membership.
