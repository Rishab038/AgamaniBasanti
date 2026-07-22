-- ============================================================
-- 0022: an explicit lunch break, and a hard cap of four punches.
--
-- A working day is now exactly four events:
--     1 ARRIVAL    (IN)
--     2 LUNCH_OUT  (OUT)  -- leaving for the one-hour break
--     3 LUNCH_IN   (IN)   -- back from the break
--     4 DEPARTURE  (OUT)  -- going home
--
-- Recording the KIND, not just the direction, is what makes this
-- work: without it a second OUT punch is indistinguishable from
-- someone going home, and worked hours would count the lunch hour as
-- time on the floor.
--
-- The cap is enforced in the database, not just hidden in the app: a
-- fifth punch is rejected outright. The app is the polite gate; this
-- is the one that cannot be bypassed by a stale build or a replayed
-- request.
-- ============================================================

alter table attendance_app
  add column if not exists punch_kind text;

comment on column attendance_app.punch_kind is
  'ARRIVAL | LUNCH_OUT | LUNCH_IN | DEPARTURE. Null on rows created before 0022.';

-- backfill: the first punch of a day is the arrival, a later OUT is a
-- departure. Older rows have no lunch concept, so nothing is invented.
update attendance_app a
set punch_kind = case
  when a.server_ts = (
    select min(b.server_ts) from attendance_app b
    where b.profile_id = a.profile_id
      and fn_ist_date(b.server_ts) = fn_ist_date(a.server_ts)
  ) then 'ARRIVAL'
  when a.direction = 'OUT' then 'DEPARTURE'
  else 'LUNCH_IN'
end
where a.punch_kind is null;

-- ---------- four punches a day, in order ----------
create or replace function fn_guard_punch_limit()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_count integer;
begin
  select count(*) into v_count
  from attendance_app
  where profile_id = new.profile_id
    and fn_ist_date(server_ts) = fn_ist_date(coalesce(new.server_ts, now()));

  if v_count >= 4 then
    raise exception 'You have already recorded your full day (in, lunch, back, out).'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_punch_limit on attendance_app;
create trigger guard_punch_limit
  before insert on attendance_app
  for each row execute function fn_guard_punch_limit();

-- ---------- worked time excludes the real lunch break ----------
create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_app_first  timestamptz;
  v_app_last   timestamptz;
  v_app_last_dir punch_direction;
  v_app_out    timestamptz;
  v_lunch_out  timestamptz;
  v_lunch_in   timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_dev_out    timestamptz;
  v_status     day_status;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_late       integer := 0;
  v_worked     integer;
  v_break      integer := 0;
  v_enroll     integer;
  v_branch     uuid;
  v_lunch_cfg  integer;
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
    into v_enroll, v_branch, v_lunch_cfg
  from profiles where id = p_profile;

  v_min_shift := fn_setting_int('min_shift_minutes', 60);

  select es.shift_start, es.shift_end, es.grace_minutes
    into v_shift_start, v_shift_end, v_grace
  from fn_effective_shift(p_profile, p_date) es;

  select min(server_ts) into v_app_first
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  select server_ts, direction into v_app_last, v_app_last_dir
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date
  order by server_ts desc
  limit 1;

  -- only a trailing OUT means they have left for the day
  v_app_out := case when v_app_last_dir = 'OUT' then v_app_last end;

  -- the actual break they took, if they used the lunch buttons
  select max(server_ts) filter (where punch_kind = 'LUNCH_OUT'),
         max(server_ts) filter (where punch_kind = 'LUNCH_IN')
    into v_lunch_out, v_lunch_in
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

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

  -- Prefer the break they actually took; fall back to the configured
  -- lunch only when they never used the lunch buttons.
  if v_lunch_out is not null and v_lunch_in is not null and v_lunch_in > v_lunch_out then
    v_break := (extract(epoch from (v_lunch_in - v_lunch_out)) / 60)::integer;
  else
    v_break := v_lunch_cfg;
  end if;

  v_worked := case
    when v_last_out is null then null
    else greatest(0, (extract(epoch from (v_last_out - v_first_in)) / 60)::integer - v_break)
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
revoke all on function fn_guard_punch_limit() from public, anon, authenticated;
