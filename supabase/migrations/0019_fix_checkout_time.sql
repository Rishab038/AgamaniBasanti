-- ============================================================
-- 0019: fix check-out time mirroring check-in.
--
-- BUG: last_out was
--     greatest(coalesce(app_last, dev_last), coalesce(dev_last, app_last))
-- i.e. the latest punch of the day REGARDLESS OF DIRECTION. For a
-- worker who has only checked in, the latest punch *is* the check-in,
-- so the dashboard showed identical IN and OUT times all day and
-- worked_minutes was always 0.
--
-- FIX: a check-out must be evidenced, not inferred from "last punch".
--   * app        — an explicit direction = 'OUT' punch
--   * machine    — the fingerprint reader reports no direction, so the
--                  only honest signal is a SECOND punch strictly later
--                  than the first; a lone punch is an arrival
--   * neither    — last_out stays NULL and the dashboard shows "—",
--                  which is the truth: they are still in the shop
--
-- worked_minutes likewise stays NULL until there is a real check-out,
-- instead of reporting 0.
-- ============================================================

create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_app_first  timestamptz;
  v_app_out    timestamptz;   -- last explicit OUT punch from the app
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_dev_out    timestamptz;   -- machine punch that plausibly is a departure
  v_status     day_status;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_late       integer := 0;
  v_worked     integer;
  v_enroll     integer;
  v_branch     uuid;
  v_lunch      integer;
  v_shift_start time;
  v_shift_end  time;
  v_grace      integer;
  v_reasons    text[] := '{}';
  v_decision   text;
  v_is_leaveday boolean;
  v_diff       integer;
begin
  select device_enroll_no, branch_id, coalesce(lunch_minutes, 0)
    into v_enroll, v_branch, v_lunch
  from profiles where id = p_profile;

  select es.shift_start, es.shift_end, es.grace_minutes
    into v_shift_start, v_shift_end, v_grace
  from fn_effective_shift(p_profile, p_date) es;

  -- app punches for this IST day
  select min(server_ts) into v_app_first
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  select max(server_ts) into v_app_out
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date
    and direction = 'OUT';

  -- machine punches for this IST day
  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

  -- a single machine punch is an arrival, not a departure
  v_dev_out := case when v_dev_last > v_dev_first then v_dev_last end;

  if v_app_first is null and v_dev_first is null then
    return;  -- nothing punched; the nightly finaliser decides the day
  end if;

  -- both sources present anywhere in the day = verified (see 0009)
  if v_app_first is not null and v_dev_first is not null then
    v_status := 'VERIFIED';
  elsif v_app_first is not null then
    v_status := 'APP_ONLY';
  else
    v_status := 'DEVICE_ONLY';
  end if;

  v_first_in := least(coalesce(v_app_first, v_dev_first), coalesce(v_dev_first, v_app_first));

  -- NULL until a check-out is actually evidenced
  v_last_out := greatest(v_app_out, v_dev_out);

  -- ---------- window checks ----------
  if v_shift_start is not null then
    v_diff := (extract(epoch from (
                (v_first_in at time zone 'Asia/Kolkata')::time - v_shift_start
              )) / 60)::integer;
    if v_diff > v_grace then
      v_reasons := array_append(v_reasons, 'LATE_IN');
      v_late := v_diff - v_grace;
    elsif v_diff < -v_grace then
      v_reasons := array_append(v_reasons, 'EARLY_IN');
    end if;
  end if;

  -- Early-out is judged on an explicit app OUT punch: the fingerprint
  -- machine reports a time but not a direction, so a machine punch
  -- cannot prove someone left.
  if v_shift_end is not null and v_app_out is not null then
    v_diff := (extract(epoch from (
                (v_app_out at time zone 'Asia/Kolkata')::time - v_shift_end
              )) / 60)::integer;
    if v_diff < -v_grace then
      v_reasons := array_append(v_reasons, 'EARLY_OUT');
    elsif v_diff > v_grace then
      v_reasons := array_append(v_reasons, 'LATE_OUT');
    end if;
  end if;

  -- worked a day rostered as their leave -> needs approval to be paid
  select exists (
    select 1 from staff_leave_days
    where profile_id = p_profile and on_date = p_date
  ) into v_is_leaveday;
  if v_is_leaveday then
    v_reasons := array_append(v_reasons, 'OFF_DAY_WORK');
  end if;

  -- hours are only known once they have actually left
  v_worked := case
    when v_last_out is null then null
    else greatest(0, (extract(epoch from (v_last_out - v_first_in)) / 60)::integer - v_lunch)
  end;

  -- keep any decision the owner already made, and let it drive status
  select decision into v_decision
  from attendance_days where profile_id = p_profile and work_date = p_date;

  if v_decision = 'HALF_DAY' then v_status := 'HALF_DAY';
  elsif v_decision = 'NO_PAY' then v_status := 'ABSENT';
  elsif v_decision = 'OVERTIME' then v_status := 'OVERTIME';
  end if;

  insert into attendance_days (
    profile_id, work_date, status, first_in, last_out,
    late_minutes, worked_minutes, review_reasons, updated_at
  )
  values (
    p_profile, p_date, v_status, v_first_in, v_last_out,
    v_late, v_worked, v_reasons, now()
  )
  on conflict (profile_id, work_date) do update
    set status         = excluded.status,
        first_in       = excluded.first_in,
        last_out       = excluded.last_out,
        late_minutes   = excluded.late_minutes,
        worked_minutes = excluded.worked_minutes,
        review_reasons = excluded.review_reasons,
        updated_at     = now();
end;
$$;

revoke all on function fn_rebuild_attendance_day(uuid, date) from public, anon, authenticated;

-- ---------- repair the days already recorded with a false check-out ----------
do $$
declare r record;
begin
  for r in select distinct profile_id, work_date from attendance_days loop
    perform fn_rebuild_attendance_day(r.profile_id, r.work_date);
  end loop;
end
$$;
