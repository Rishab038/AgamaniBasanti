-- ============================================================
-- 0012: recorded worker consent (India DPDP Act).
--
-- The app captures a selfie, GPS fix and device ID at each punch.
-- That is personal data, so before a worker's first check-in they
-- must be told plainly what is collected, why, and for how long —
-- and that acknowledgement has to be evidenced, not assumed.
--
-- consent_at is set through a SECURITY DEFINER function rather than a
-- direct UPDATE policy, because RLS policies cannot restrict which
-- COLUMNS a user may write: a policy permissive enough to let a worker
-- set consent_at would also let them edit their own base_salary.
-- ============================================================

alter table profiles add column if not exists consent_at timestamptz;

-- existing accounts (the developer's own test logins) are not
-- back-filled: everyone sees the notice once, which is the point

create or replace function fn_record_consent()
returns void
language sql security definer
set search_path = public, pg_temp as
$$
  update profiles set consent_at = now()
  where id = auth.uid() and consent_at is null;
$$;

revoke all on function fn_record_consent() from public;
grant execute on function fn_record_consent() to authenticated;
