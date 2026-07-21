-- ============================================================
-- 0021: a check-out only counts if it is the LAST thing they did.
--
-- Real data from W09 today:
--     10:11:51  IN
--     10:12:13  OUT   (22 seconds later — an accidental second tap:
--                      the app's big button flips to CHECK OUT the
--                      instant you check in)
--     10:24:22  IN    (back in)
--
-- 0019/0020 took last_out = max(OUT punch), which reported 10:12 as
-- the departure even though the person checked in again afterwards and
-- is still in the shop.
--
-- The state of the day is simply the direction of the LATEST punch:
--   last punch is OUT -> that is the check-out
--   last punch is IN  -> they are still in, last_out is NULL
--
-- This also self-heals the accidental-tap case: the later IN cancels
-- the stray OUT, which is what actually happened in the shop.
-- ============================================================

create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_app_first  timestamptz;
  v_app_last   timestamptz;
  v_app_last_dir punch_direction;
  v_app_out    timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_dev_out    timestamptz;
  v_status     day_status;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_late       integer := 0;
  v_worked     integer;
  v_enroll     integer;
  v_branch     uuid;
  v_lunch      integer;
  v_min_shift  integer;
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

  v_min_shift := fn_setting_int('min_shift_minutes', 60);

  select es.shift_start, es.shift_end, es.grace_minutes
    into v_shift_start, v_shift_end, v_grace
  from fn_effective_shift(p_profile, p_date) es;

  select min(server_ts) into v_app_first
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  -- the latest app punch and which way it went
  select server_ts, direction into v_app_last, v_app_last_dir
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date
  order by server_ts desc
  limit 1;

  -- only a trailing OUT means they have left
  v_app_out := case when v_app_last_dir = 'OUT' then v_app_last end;

  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

  -- machine punches carry no direction: only count one as a departure
  -- if it is far enough from arrival to be a real shift (0020)
  v_dev_out := case
    when v_dev_last is not null
     and v_dev_first is not null
     and v_dev_last >= v_dev_first + make_interval(mins => v_min_shift)
    then v_dev_last
  end;

  if v_app_first is null and v_dev_first is null then
    return;
  end if;

  if v_app_first is not null and v_dev_first is not null then
    v_status := 'VERIFIED';
  elsif v_app_first is not null then
    v_status := 'APP_ONLY';
  else
    v_status := 'DEVICE_ONLY';
  end if;

  v_first_in := least(coalesce(v_app_first, v_dev_first), coalesce(v_dev_first, v_app_first));

  -- if the app says they came back in, believe it over the machine
  v_last_out := case
    when v_app_last_dir = 'IN' then null
    else greatest(v_app_out, v_dev_out)
  end;

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

  select exists (
    select 1 from staff_leave_days
    where profile_id = p_profile and on_date = p_date
  ) into v_is_leaveday;
  if v_is_leaveday then
    v_reasons := array_append(v_reasons, 'OFF_DAY_WORK');
  end if;

  v_worked := case
    when v_last_out is null then null
    else greatest(0, (extract(epoch from (v_last_out - v_first_in)) / 60)::integer - v_lunch)
  end;

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

do $$
declare r record;
begin
  for r in select distinct profile_id, work_date from attendance_days loop
    perform fn_rebuild_attendance_day(r.profile_id, r.work_date);
  end loop;
end
$$;
