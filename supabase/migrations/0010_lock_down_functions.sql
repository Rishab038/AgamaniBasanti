-- ============================================================
-- 0010: production hardening of SECURITY DEFINER functions.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- PostgREST exposes every public-schema function at /rest/v1/rpc/<name>.
-- Combined with SECURITY DEFINER that meant several internal routines
-- were callable by anyone holding the (public, embedded-in-the-app)
-- anon key.
--
-- The one that actually mattered: fn_finalize_day(date). An anonymous
-- caller could invoke it for any date and have ABSENT rows written for
-- every active worker — which the payroll engine then turns into salary
-- deductions. fn_rebuild_attendance_day and fn_record_device_attempt
-- were lesser versions of the same problem (recomputation on demand,
-- and flooding the Settings page with fake "machine trying to connect"
-- rows).
--
-- Rules applied below:
--   * internal machinery (triggers, cron jobs, edge-function helpers)
--     -> callable by nobody except the service role / postgres
--   * owner actions invoked from the dashboard (payroll, approvals)
--     -> stay callable by authenticated; they already re-check
--        fn_is_owner() internally, so the guard is defence in depth
--   * RLS helpers (fn_role, fn_branch, fn_is_owner, fn_is_staff_admin)
--     -> must stay executable by authenticated or every policy breaks;
--        only anon loses access
-- ============================================================

-- ---------- 1. pin search_path on the two functions missing it ----------
create or replace function fn_ist_date(ts timestamptz)
returns date language sql immutable
set search_path = public, pg_temp as
$$ select (ts at time zone 'Asia/Kolkata')::date $$;

create or replace function fn_setting_int(p_key text, p_default integer)
returns integer language sql stable
set search_path = public, pg_temp as
$$ select coalesce((select (value)::text::integer from app_settings where key = p_key), p_default) $$;

-- ---------- 2. internal machinery: not callable from the API ----------
revoke execute on function fn_finalize_day(date)                     from anon, authenticated;
revoke execute on function fn_rebuild_attendance_day(uuid, date)     from anon, authenticated;
revoke execute on function fn_record_device_attempt(text)            from anon, authenticated;
revoke execute on function fn_audit()                                from anon, authenticated;
revoke execute on function trg_after_app_punch()                     from anon, authenticated;
revoke execute on function trg_after_device_punch()                  from anon, authenticated;

-- the ADMS edge function records unknown serials with the service role
grant execute on function fn_record_device_attempt(text) to service_role;

-- ---------- 3. owner actions: authenticated only (never anon) ----------
revoke execute on function fn_approve_day(uuid, date, day_status, text) from anon;
revoke execute on function fn_generate_payroll(uuid, date)              from anon;
revoke execute on function fn_confirm_payroll(uuid)                     from anon;

-- ---------- 4. RLS helpers: authenticated keeps them, anon does not ----------
revoke execute on function fn_role()            from anon;
revoke execute on function fn_branch()          from anon;
revoke execute on function fn_is_owner()        from anon;
revoke execute on function fn_is_staff_admin()  from anon;
revoke execute on function fn_ist_date(timestamptz) from anon;
revoke execute on function fn_setting_int(text, integer) from anon;
