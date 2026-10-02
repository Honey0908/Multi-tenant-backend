-- auth_reader was originally designed around BYPASSRLS (see
-- create_auth_reader_role) so the login lookup could read "User" by email
-- before any org context is known. Postgres 16+ requires the *granting*
-- role to itself have BYPASSRLS before it can hand that attribute to
-- another role — and managed Postgres providers (Render included)
-- deliberately don't give their admin connection that attribute, so
-- `CREATE ROLE auth_reader ... BYPASSRLS` fails there with "permission
-- denied to create role" no matter how it's retried.
--
-- Fix: grant the same practical access — unconditional SELECT on "User" —
-- through an explicit RLS policy scoped to auth_reader, instead of a
-- blanket bypass flag. This mirrors how platform_reader already gets its
-- cross-org read access (see create_platform_reader_role's
-- platform_read_policy on "Organisation"), so auth_reader stops being the
-- one role using a different mechanism for the same kind of access.
--
-- Safe alongside auth_reader's existing BYPASSRLS locally (redundant, not
-- conflicting) — it's the only mechanism actually in effect anywhere
-- auth_reader doesn't have BYPASSRLS, e.g. Render.
DROP POLICY IF EXISTS auth_reader_read_policy ON "User";

CREATE POLICY auth_reader_read_policy ON "User"
FOR SELECT
TO auth_reader
USING (true);
