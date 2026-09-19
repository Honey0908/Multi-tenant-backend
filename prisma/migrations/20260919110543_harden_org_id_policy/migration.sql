-- The original policy expression —
--   NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
--   AND "organisation_id" = current_setting('app.org_id', true)::uuid
-- is a top-level AND, which Postgres's planner is free to split into
-- independently-reorderable quals. It can evaluate the `::uuid` cast
-- before the NULLIF guard, so a request with no app.org_id set raises
-- "invalid input syntax for type uuid: ''" instead of just filtering out
-- all rows. It fails closed (no cross-tenant leak either way) but errors
-- unpredictably instead of cleanly returning zero rows.
--
-- Wrapping the guard in a function makes NULLIF run first as a single
-- opaque unit: current_org_id() returns NULL (not '') when unset, and
-- "organisation_id" = NULL is simply false/no-match — no cast error.
CREATE FUNCTION current_org_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

DROP POLICY tenant_isolation_policy ON "User";
CREATE POLICY tenant_isolation_policy ON "User"
USING ("organisation_id" = current_org_id());

DROP POLICY tenant_isolation_policy ON "Project";
CREATE POLICY tenant_isolation_policy ON "Project"
USING ("organisation_id" = current_org_id());

DROP POLICY tenant_isolation_policy ON "Issue";
CREATE POLICY tenant_isolation_policy ON "Issue"
USING ("organisation_id" = current_org_id());
