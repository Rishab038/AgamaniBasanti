-- ============================================================
-- 0026: don't tell people who have gone home to check out.
--
-- 0025 decided "still on the floor" by looking for a punch with
-- punch_kind = 'DEPARTURE'. Real data broke it immediately: punches
-- made from an app build older than 0022 carry punch_kind = null, so
-- a worker who had checked out at 10:43 still matched, and would have
-- been sent "Remember to check out" after going home.
--
-- The reliable signal is the one fn_rebuild_attendance_day already
-- uses (see 0021): the DIRECTION of the last punch of the day. That
-- works whether or not punch_kind was recorded.
--
-- Being wrong here is expensive in a way a missed reminder is not —
-- a notification that contradicts what someone just did teaches them
-- to ignore all of them.
-- ============================================================

create or replace function fn_queue_shift_reminders()
returns integer
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_now     time := (now() at time zone 'Asia/Kolkata')::time;
  v_grace   integer := fn_setting_int('shift_grace_minutes', 15);
  r         record;
  v_start   time;
  v_end     time;
  v_made    integer := 0;
  v_punches integer;
  v_last_dir punch_direction;
  v_open    boolean;
begin
  for r in
    select p.id, p.full_name, p.shift_start, p.shift_end
    from profiles p
    where p.role = 'worker' and p.active and p.shift_start is not null
  loop
    select es.shift_start, es.shift_end into v_start, v_end
    from fn_effective_shift(r.id, v_today) es;
    if v_start is null then continue; end if;

    select count(*) into v_punches
    from attendance_app
    where profile_id = r.id and fn_ist_date(server_ts) = v_today;

    -- direction of the latest punch decides whether they are still in
    select direction into v_last_dir
    from attendance_app
    where profile_id = r.id and fn_ist_date(server_ts) = v_today
    order by server_ts desc
    limit 1;

    v_open := (v_punches > 0 and v_last_dir = 'IN');

    -- 1. shift about to start
    if v_punches = 0
       and v_now between (v_start - make_interval(mins => v_grace)) and v_start then
      insert into notifications (profile_id, title, body, type, for_date)
      values (
        r.id,
        'Your shift starts soon',
        'Your shift starts at ' || to_char(v_start, 'FMHH12:MI am') ||
          '. Open the app and check in when you reach the shop.',
        'shift_soon', v_today
      )
      on conflict do nothing;
      v_made := v_made + 1;
    end if;

    -- 2. started, still no check-in
    if v_punches = 0
       and v_now between (v_start + make_interval(mins => v_grace))
                     and (v_start + make_interval(mins => v_grace + 10)) then
      insert into notifications (profile_id, title, body, type, for_date)
      values (
        r.id,
        'You have not checked in yet',
        'Your shift began at ' || to_char(v_start, 'FMHH12:MI am') ||
          '. Please check in now — later check-ins are sent to the owner for approval.',
        'late', v_today
      )
      on conflict do nothing;
      v_made := v_made + 1;
    end if;

    -- 3. shift over, still checked in
    if v_end is not null and v_open
       and v_now between (v_end + make_interval(mins => v_grace))
                     and (v_end + make_interval(mins => v_grace + 10)) then
      insert into notifications (profile_id, title, body, type, for_date)
      values (
        r.id,
        'Remember to check out',
        'Your shift ended at ' || to_char(v_end, 'FMHH12:MI am') ||
          '. Please check out so your hours are recorded correctly.',
        'checkout_due', v_today
      )
      on conflict do nothing;
      v_made := v_made + 1;
    end if;
  end loop;

  return v_made;
end;
$$;

revoke all on function fn_queue_shift_reminders() from public, anon, authenticated;
