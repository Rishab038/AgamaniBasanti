-- ============================================================
-- 0013: close the last anon-executable function.
--
-- Supabase ships with ALTER DEFAULT PRIVILEGES granting EXECUTE on new
-- public-schema functions directly to anon, authenticated and
-- service_role. So a newly created function needs BOTH:
--     revoke ... from public;   -- the Postgres default grant
--     revoke ... from anon;     -- the Supabase default privilege
--
-- 0011 happened to cover both for the older functions (0010 had already
-- revoked from anon), but fn_record_consent was created afterwards in
-- 0012 and only lost the PUBLIC grant.
--
-- Impact was limited — for an anonymous caller auth.uid() is null, so
-- the UPDATE matched no rows — but an unauthenticated caller should not
-- reach a consent-recording routine at all.
--
-- NOTE for future migrations: every new function in this schema needs
-- an explicit `revoke all ... from public, anon;` unless it is genuinely
-- meant to be callable by signed-out visitors.
-- ============================================================

revoke all on function fn_record_consent() from public, anon;
grant execute on function fn_record_consent() to authenticated;
