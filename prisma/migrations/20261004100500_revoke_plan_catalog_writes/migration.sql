-- make_role_grants_portable ran `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL
-- TABLES IN SCHEMA public TO app_user`, which silently undid the
-- `REVOKE INSERT, UPDATE, DELETE ON "SubscriptionPlan" FROM app_user` that
-- add_organisation_rls had applied. With the grant back, any tenant
-- connection could rewrite the plan catalog and raise limits for every org
-- on a tier. Re-apply the revoke so the migration chain ends in the intended
-- state; the catalog is global (no RLS), so this grant is its only guard.
REVOKE INSERT, UPDATE, DELETE ON "SubscriptionPlan" FROM app_user;
