-- ============================================================
-- 0032: stop making the owner rubber-stamp ordinary days, and
--       close the day off at noon.
--
-- Until now EVERY app-only day landed in "needs your decision" — including
-- someone who checked in exactly on time. With 35 staff that is 35
-- approvals a day for nothing, and real problems get lost in the noise.
--
-- Three rules, all owner-overridable:
--
--   1. An app check-in within the shift's grace window (15 min) is
--      approved automatically. On time is not a question worth asking.
--   2. After the cutoff (12:00 by default) nothing is auto-approved —
--      turning up at 2pm is a judgement call, so it goes to the owner.
--   3. At the cutoff, anyone who has not punched at all is marked ABSENT,
--      respecting holidays, weekly offs and approved leave.
--
-- Both thresholds are settings, not constants, so the client can move
-- them without a code change.
-- ============================================================

insert into app_settings (key, value) values
  ('absent_cutoff_minutes', '720')   -- 12:00, minutes from midnight IST
on conflict (key) do nothing;

comment on column attendance_days.decision is
  'Owner ruling on the day. Set automatically to NORMAL for an on-time '
  'app check-in (see 0032); every automatic value can be overridden by '
  'the owner, and a manual decision is never overwritten.';


create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
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
  v_auto       text := null;
  v_is_leaveday boolean;
  v_diff       integer;
  v_cutoff     time;
  v_in_time    time;
  v_on_time    boolean := false;
begin
  select device_enroll_no, branch_id, coalesce(lunch_minutes, 0)
    into v_enroll, v_branch, v_lunch_cfg
  from profiles where id = p_profile;

  v_min_shift := fn_setting_int('min_shift_minutes', 60);
  v_cutoff := make_time(fn_setting_int('absent_cutoff_minutes', 720) / 60,
                        fn_setting_int('absent_cutoff_minutes', 720) % 60, 0);

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

  v_app_out := case when v_app_last_dir = 'OUT' then v_app_last end;

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
    else
      v_on_time := true;               -- arrived inside the grace window
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

  -- Arriving after the cutoff is always the owner's call, and is called
  -- out separately so it does not read as ordinary lateness.
  v_in_time := (v_first_in at time zone 'Asia/Kolkata')::time;
  if v_in_time > v_cutoff then
    v_reasons := array_append(v_reasons, 'AFTER_CUTOFF');
  end if;

  select exists (
    select 1 from staff_leave_days
    where profile_id = p_profile and on_date = p_date
  ) into v_is_leaveday;
  if v_is_leaveday then
    v_reasons := array_append(v_reasons, 'OFF_DAY_WORK');
  end if;

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

  -- Auto-approval. Deliberately narrow: an app-only day, on time against
  -- a shift we actually know, punched before the cutoff, with no other
  -- reason to look at it. A shift-less worker is never auto-approved —
  -- with no expected start there is nothing to be "on time" for.
  if v_decision is null
     and v_status = 'APP_ONLY'
     and v_shift_start is not null
     and v_on_time
     and v_in_time <= v_cutoff
     and not ('OFF_DAY_WORK' = any (v_reasons))
  then
    v_auto := 'NORMAL';
    v_decision := 'NORMAL';
  end if;

  if v_decision = 'HALF_DAY' then v_status := 'HALF_DAY';
  elsif v_decision = 'NO_PAY' then v_status := 'ABSENT';
  elsif v_decision = 'OVERTIME' then v_status := 'OVERTIME';
  end if;

  insert into attendance_days (
    profile_id, work_date, status, first_in, last_out,
    late_minutes, worked_minutes, review_reasons, decision, updated_at
  )
  values (
    p_profile, p_date, v_status, v_first_in, v_last_out,
    v_late, v_worked, v_reasons, v_auto, now()
  )
  on conflict (profile_id, work_date) do update
    set status         = excluded.status,
        first_in       = excluded.first_in,
        last_out       = excluded.last_out,
        late_minutes   = excluded.late_minutes,
        worked_minutes = excluded.worked_minutes,
        review_reasons = excluded.review_reasons,
        -- an owner's ruling always wins; the automatic one only fills a gap
        decision       = coalesce(attendance_days.decision, excluded.decision),
        updated_at     = now();
end;
$$;

revoke all on function fn_rebuild_attendance_day(uuid, date) from public, anon, authenticated;


-- Close the register at the cutoff: everyone with no punch by now is
-- absent for the day. fn_finalize_day already sorts holidays, weekly
-- offs and approved leave, and inserts nothing over an existing row, so
-- it is safe to run mid-day and again nightly.
create or replace function fn_close_attendance_cutoff()
returns integer
language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_before integer;
  v_after  integer;
begin
  select count(*) into v_before from attendance_days where work_date = v_today;
  perform fn_finalize_day(v_today);
  select count(*) into v_after from attendance_days where work_date = v_today;
  return v_after - v_before;
end;
$$;

revoke all on function fn_close_attendance_cutoff() from public, anon, authenticated;

-- 06:30 UTC = 12:00 IST. Kept in step with absent_cutoff_minutes by hand;
-- moving one without the other only shifts when the register closes, it
-- cannot corrupt a day.
select cron.unschedule('close-attendance-cutoff')
where exists (select 1 from cron.job where jobname = 'close-attendance-cutoff');

select cron.schedule(
  'close-attendance-cutoff',
  '30 6 * * *',
  $job$ select fn_close_attendance_cutoff() $job$
);
