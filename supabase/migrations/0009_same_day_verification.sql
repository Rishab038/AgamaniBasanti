-- ============================================================
-- 0009: both sources present on the day = VERIFIED, no approval.
--
-- Previously a day only counted as VERIFIED when an app check-in and
-- a machine punch fell within ±15 minutes of each other. Anything
-- wider fell through to APP_ONLY — which both mis-stated the facts
-- ("no fingerprint" when a fingerprint punch existed) and pushed a
-- fully-evidenced day into the owner's approval queue.
--
-- The tight window was never what made the evidence trustworthy:
--   * an app check-in is only possible inside the shop geofence, and
--     carries a selfie, GPS fix, device ID and anti-spoof flags;
--   * a machine punch requires a finger physically at the machine.
-- Both on the same day therefore already prove presence, whether they
-- happen two minutes or two hours apart. A worker who punches the
-- machine on arrival and opens the app after serving a customer is
-- the normal case, not a suspicious one.
--
-- Owner intervention is now reserved for genuinely one-sided days:
--   APP_ONLY    — app check-in, machine never saw them
--   DEVICE_ONLY — machine punch, app never used (phone dead/forgotten)
--
-- app_settings.verify_window_minutes is left in place but is no longer
-- consulted; keeping the row avoids breaking anything that reads it.
-- ============================================================

create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  v_app_first  timestamptz;
  v_app_last   timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_status     day_status;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_late       integer := 0;
  v_shift_start time;
  v_grace      integer;
  v_enroll     integer;
  v_branch     uuid;
begin
  select device_enroll_no, branch_id into v_enroll, v_branch
  from profiles where id = p_profile;

  -- App punches for this IST day
  select min(server_ts), max(server_ts) into v_app_first, v_app_last
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  -- Machine punches for this IST day (matched via enroll no on this branch)
  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

  if v_app_first is null and v_dev_first is null then
    return;  -- nothing punched; nightly finalizer decides ABSENT/HOLIDAY/etc.
  end if;

  -- Both sources present anywhere in the day -> verified automatically
  if v_app_first is not null and v_dev_first is not null then
    v_status := 'VERIFIED';
  elsif v_app_first is not null then
    v_status := 'APP_ONLY';
  else
    v_status := 'DEVICE_ONLY';
  end if;

  -- Earliest of either source is the arrival; latest is the departure
  v_first_in := least(coalesce(v_app_first, v_dev_first), coalesce(v_dev_first, v_app_first));
  v_last_out := greatest(coalesce(v_app_last, v_dev_last), coalesce(v_dev_last, v_app_last));

  -- Late arrival vs shift start + grace (only when a shift is assigned)
  select s.start_time, s.grace_minutes into v_shift_start, v_grace
  from profiles p join shifts s on s.id = p.shift_id
  where p.id = p_profile;

  if v_shift_start is not null then
    v_late := greatest(0,
      (extract(epoch from (
        (v_first_in at time zone 'Asia/Kolkata')::time - v_shift_start
      )) / 60)::integer - coalesce(v_grace, fn_setting_int('default_grace_minutes', 15))
    );
  end if;

  insert into attendance_days (profile_id, work_date, status, first_in, last_out, late_minutes, updated_at)
  values (p_profile, p_date, v_status, v_first_in, v_last_out, v_late, now())
  on conflict (profile_id, work_date) do update
    set status       = excluded.status,
        first_in     = excluded.first_in,
        last_out     = excluded.last_out,
        late_minutes = excluded.late_minutes,
        updated_at   = now()
    -- never clobber an owner's manual decision
    where attendance_days.approved_by is null;
end;
$$;

-- Re-evaluate existing days so any previously mislabelled APP_ONLY /
-- DEVICE_ONLY day that actually has both sources becomes VERIFIED.
-- Owner-decided days are skipped by the guard inside the function.
do $$
declare r record;
begin
  for r in select distinct profile_id, work_date from attendance_days loop
    perform fn_rebuild_attendance_day(r.profile_id, r.work_date);
  end loop;
end
$$;
