-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('RESERVED', 'COMMITTED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "ResourceType" ADD VALUE 'STORAGE_BYTES';

-- AlterTable
ALTER TABLE "UsageCounter" ALTER COLUMN "value" SET DATA TYPE BIGINT,
ALTER COLUMN "max_limit" SET DATA TYPE BIGINT;

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storage_key_key" ON "Attachment"("storage_key");

-- CreateIndex
CREATE INDEX "Attachment_organisation_id_issue_id_idx" ON "Attachment"("organisation_id", "issue_id");

-- CreateIndex
CREATE INDEX "Attachment_status_expires_at_idx" ON "Attachment"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organisation_id_id_key" ON "Attachment"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organisation_id_issue_id_fkey" FOREIGN KEY ("organisation_id", "issue_id") REFERENCES "Issue"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security, identical shape to User/Project/Issue/UsageCounter:
-- fails closed to zero rows when app.org_id isn't set, via current_org_id()
-- (see harden_org_id_policy).
ALTER TABLE "Attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Attachment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "Attachment"
USING ("organisation_id" = current_org_id());

-- The running app connects as `app_user` — see create_app_role. Granted
-- explicitly per add_usage_counters' own note: ALTER DEFAULT PRIVILEGES only
-- covers tables created by the same role/session that ran it, so we don't
-- depend on that continuing to hold.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Attachment" TO app_user;

-- Deliberately NOT granted to `platform_reader`: attachments are tenant
-- content (like Project/Issue), not org-level metadata.
