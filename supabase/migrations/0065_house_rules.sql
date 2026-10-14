-- ============================================================
-- 0065: the three house rules the owner can actually switch.
--
-- These live in app_settings rather than on branches, because that is
-- where every other rule of this kind already lives — the cutoff, the
-- grace window, the recovery percentage. They are house rules for the
-- business, not properties of a building, and both shops have one
-- owner applying one set of them.
--
-- Only three, and each one has to change behaviour somewhere real:
--
--   require_selfie     the app stops asking for a photo at check-in
--   enforce_geofence   the app lets someone punch from outside the
--                      radius, and flags the punch instead of blocking
--   auto_half_day      a late arrival is ruled a half day by the
--                      system instead of waiting for the owner
--
-- The template also shows a WhatsApp-the-payslip switch. There is no
-- WhatsApp integration behind it — no account, no provider, no
-- template — so it is deliberately not seeded here. A switch that
-- looks live and sends nothing is worse than no switch.
--
-- All three default to the CURRENT behaviour, so applying this
-- migration changes nothing until somebody flips something.
-- ============================================================

create or replace function fn_setting_bool(p_key text, p_default boolean)
returns boolean language sql stable as
$$
  -- Accepts a jsonb boolean (true) or a jsonb string ("true"). The
  -- dashboard writes the former, but these keys are also editable by
  -- hand in the SQL editor, and a naive ::boolean cast throws on the
  -- quoted form rather than falling back — which would take the whole
  -- day rebuild down over a typo in a settings row.
  select coalesce(
    (select case jsonb_typeof(value)
              when 'boolean' then (value)::text::boolean
              when 'string'  then lower(value #>> '{}') in ('true', 't', '1', 'yes')
              when 'number'  then (value)::text <> '0'
            end
     from app_settings where key = p_key),
    p_default)
$$;

comment on function fn_setting_bool(text, boolean) is
  'Reads a true/false house rule out of app_settings, falling back to '
  'the default when the key has never been set.';

insert into app_settings (key, value) values
  ('require_selfie',   'true'),
  ('enforce_geofence', 'true'),
  ('auto_half_day',    'false')
on conflict (key) do nothing;


-- ---------- auto half-day ----------
--
-- One clause added to the day rebuild. Everything else in this function
-- is carried over from 0032 unchanged.
--
-- The rule is narrow on purpose. It fires only on AFTER_CUTOFF — the
-- existing "arrived after midday" mark — and never on ordinary
-- lateness, because a worker eleven minutes late is a conversation and
-- a worker arriving at 2pm is a half day by the shop's own rule. It
-- also never overrides a decision the owner has already made: the
-- insert below still coalesces to the existing decision, so a day the
-- owner ruled a full day stays a full day.
create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  v_enroll     integer;
  v_branch     uuid;
  v_lunch_cfg  integer;
  v_min_shift  integer;
  v_shift_start time;
  v_shift_end   time;
  v_grace      integer;
  v_app_first  timestamptz;
  v_app_last   timestamptz;
  v_app_last_dir text;
  v_app_out    timestamptz;
  v_lunch_out  timestamptz;
  v_lunch_in   timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_dev_out    timestamptz;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_status     text;
  v_late       integer := 0;
  v_worked     integer;
  v_break      integer;
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

  -- Auto half-day (0065). Off by default. Only ever applies the shop's
  -- own written rule — arrived after the cutoff — and only where the
  -- owner has not already ruled. Someone who worked an off day still
  -- goes to the owner: that is a favour being done, not a late arrival.
  if v_decision is null
     and fn_setting_bool('auto_half_day', false)
     and 'AFTER_CUTOFF' = any (v_reasons)
     and not ('OFF_DAY_WORK' = any (v_reasons))
  then
    v_auto := 'HALF_DAY';
    v_decision := 'HALF_DAY';
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
