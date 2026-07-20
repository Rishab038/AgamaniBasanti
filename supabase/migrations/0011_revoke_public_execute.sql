-- ============================================================
-- 0011: actually close the RPC hole opened in 0010.
--
-- 0010 revoked EXECUTE from `anon` and `authenticated`, but Postgres
-- grants EXECUTE on every new function to the pseudo-role PUBLIC, and
-- both of those roles inherit through it. Verified by exploit: an
-- anonymous caller with only the embedded anon key could still run
-- fn_finalize_day and write ABSENT rows for every worker.
--
-- The correct move is to revoke from PUBLIC first, then grant back
-- explicitly to the roles that genuinely need each function.
-- Function owners (postgres) always retain EXECUTE, so triggers and
-- pg_cron jobs keep working regardless of these grants.
-- ============================================================

-- ---------- internal machinery: owner/definer only ----------
revoke all on function fn_finalize_day(date)                 from public;
revoke all on function fn_rebuild_attendance_day(uuid, date) from public;
revoke all on function fn_audit()                            from public;
revoke all on function trg_after_app_punch()                 from public;
revoke all on function trg_after_device_punch()              from public;

-- ---------- edge-function helper: service role only ----------
revoke all on function fn_record_device_attempt(text) from public;
grant execute on function fn_record_device_attempt(text) to service_role;

-- ---------- owner dashboard actions: signed-in only ----------
-- (each also re-checks fn_is_owner() internally)
revoke all on function fn_approve_day(uuid, date, day_status, text) from public;
grant execute on function fn_approve_day(uuid, date, day_status, text) to authenticated;

revoke all on function fn_generate_payroll(uuid, date) from public;
grant execute on function fn_generate_payroll(uuid, date) to authenticated;

revoke all on function fn_confirm_payroll(uuid) from public;
grant execute on function fn_confirm_payroll(uuid) to authenticated;

-- ---------- RLS helpers: authenticated must keep these ----------
-- policies call them as the querying role; without EXECUTE every
-- policy evaluation errors out
revoke all on function fn_role()           from public;
revoke all on function fn_branch()         from public;
revoke all on function fn_is_owner()       from public;
revoke all on function fn_is_staff_admin() from public;
grant execute on function fn_role()           to authenticated;
grant execute on function fn_branch()         to authenticated;
grant execute on function fn_is_owner()       to authenticated;
grant execute on function fn_is_staff_admin() to authenticated;

-- ---------- pure helpers used inside queries ----------
revoke all on function fn_ist_date(timestamptz)       from public;
revoke all on function fn_setting_int(text, integer)  from public;
grant execute on function fn_ist_date(timestamptz)      to authenticated, service_role;
grant execute on function fn_setting_int(text, integer) to authenticated, service_role;
