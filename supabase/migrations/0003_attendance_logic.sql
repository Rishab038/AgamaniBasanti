-- ============================================================
-- 0003: attendance cross-verification, finalization, audit.
--
-- Flow:
--   raw punch lands (attendance_app OR device_punches)
--     -> trigger calls fn_rebuild_attendance_day(profile, ist_date)
--     -> row in attendance_days gets VERIFIED / APP_ONLY / DEVICE_ONLY
--   nightly job fn_finalize_day(date) fills in ABSENT / HOLIDAY /
--   OFF_DAY / LEAVE_* for everyone who never punched.
-- ============================================================

-- ---------- Setting reader ----------
create or replace function fn_setting_int(p_key text, p_default integer)
returns integer language sql stable as
$$ select coalesce((select (value)::text::integer from app_settings where key = p_key), p_default) $$;

-- ---------- Core: rebuild one worker-day ----------
create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  v_window     interval;
  v_app_first  timestamptz;
  v_app_last   timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
  v_matched    boolean;
  v_status     day_status;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_late       integer := 0;
  v_shift_start time;
  v_grace      integer;
  v_enroll     integer;
  v_branch     uuid;
begin
  v_window := make_interval(mins => fn_setting_int('verify_window_minutes', 15));

  select device_enroll_no, branch_id into v_enroll, v_branch
  from profiles where id = p_profile;

  -- App punches for this IST day
  select min(server_ts), max(server_ts) into v_app_first, v_app_last
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  -- Device punches for this IST day (matched via enroll no on this branch's machines)
  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

  if v_app_first is null and v_dev_first is null then
    return;  -- nothing punched; nightly finalizer decides ABSENT/HOLIDAY/etc.
  end if;

  -- Verified when any app punch and any device punch fall within the window
  v_matched := exists (
    select 1
    from attendance_app aa
    join device_punches dp
      on dp.enroll_no = v_enroll
     and abs(extract(epoch from (aa.server_ts - dp.punched_at))) <= extract(epoch from v_window)
    join devices d on d.serial = dp.device_serial and d.branch_id = v_branch
    where aa.profile_id = p_profile
      and fn_ist_date(aa.server_ts) = p_date
      and fn_ist_date(dp.punched_at) = p_date
  );

  if v_matched then
    v_status := 'VERIFIED';
  elsif v_app_first is not null then
    v_status := 'APP_ONLY';
  else
    v_status := 'DEVICE_ONLY';
  end if;

  v_first_in := least(coalesce(v_app_first, v_dev_first), coalesce(v_dev_first, v_app_first));
  v_last_out := greatest(coalesce(v_app_last, v_dev_last), coalesce(v_dev_last, v_app_last));

  -- Late arrival vs shift start + grace
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

-- ---------- Triggers: rebuild on every raw punch ----------
create or replace function trg_after_app_punch()
returns trigger language plpgsql security definer set search_path = public as
$$
begin
  perform fn_rebuild_attendance_day(new.profile_id, fn_ist_date(new.server_ts));
  return new;
end;
$$;

create trigger after_app_punch
  after insert on attendance_app
  for each row execute function trg_after_app_punch();

create or replace function trg_after_device_punch()
returns trigger language plpgsql security definer set search_path = public as
$$
declare
  v_profile uuid;
begin
  select p.id into v_profile
  from profiles p
  join devices d on d.branch_id = p.branch_id
  where d.serial = new.device_serial
    and p.device_enroll_no = new.enroll_no
    and p.active;

  if v_profile is not null then
    perform fn_rebuild_attendance_day(v_profile, fn_ist_date(new.punched_at));
  end if;
  return new;
end;
$$;

create trigger after_device_punch
  after insert on device_punches
  for each row execute function trg_after_device_punch();

-- ---------- Nightly finalizer: ABSENT / HOLIDAY / OFF_DAY / LEAVE ----------
create or replace function fn_finalize_day(p_date date)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  r record;
  v_status day_status;
begin
  for r in
    select p.id, p.branch_id, s.week_off
    from profiles p
    left join shifts s on s.id = p.shift_id
    where p.active and p.role = 'worker'
      and not exists (select 1 from attendance_days ad
                      where ad.profile_id = p.id and ad.work_date = p_date)
  loop
    if exists (select 1 from holidays h
               where h.branch_id = r.branch_id and h.on_date = p_date) then
      v_status := 'HOLIDAY';
    elsif r.week_off is not null
          and extract(dow from p_date)::smallint = any (r.week_off) then
      v_status := 'OFF_DAY';
    elsif exists (select 1 from leave_requests lr
                  where lr.profile_id = r.id and lr.status = 'APPROVED'
                    and p_date between lr.from_date and lr.to_date
                    and lr.paid) then
      v_status := 'LEAVE_PAID';
    elsif exists (select 1 from leave_requests lr
                  where lr.profile_id = r.id and lr.status = 'APPROVED'
                    and p_date between lr.from_date and lr.to_date) then
      v_status := 'LEAVE_UNPAID';
    else
      v_status := 'ABSENT';
    end if;

    insert into attendance_days (profile_id, work_date, status)
    values (r.id, p_date, v_status)
    on conflict (profile_id, work_date) do nothing;
  end loop;
end;
$$;

-- ---------- Owner correction helper (audited, keeps approved_by) ----------
create or replace function fn_approve_day(p_profile uuid, p_date date, p_status day_status, p_note text)
returns void
language plpgsql security definer set search_path = public as
$$
begin
  if not fn_is_owner() then
    raise exception 'only the owner can approve attendance corrections';
  end if;
  insert into attendance_days (profile_id, work_date, status, approved_by, note)
  values (p_profile, p_date, p_status, auth.uid(), p_note)
  on conflict (profile_id, work_date) do update
    set status = excluded.status,
        approved_by = excluded.approved_by,
        note = excluded.note,
        updated_at = now();
end;
$$;

-- ---------- Audit triggers on sensitive tables ----------
create or replace function fn_audit()
returns trigger language plpgsql security definer set search_path = public as
$$
begin
  insert into audit_log (actor, table_name, row_id, action, old_data, new_data)
  values (
    auth.uid(),
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then old.id::text else new.id::text end), ''),
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_attendance_days
  after insert or update or delete on attendance_days
  for each row execute function fn_audit();

create trigger audit_advances
  after insert or update or delete on advances
  for each row execute function fn_audit();

create trigger audit_payslips
  after insert or update or delete on payslips
  for each row execute function fn_audit();

create trigger audit_profiles
  after update or delete on profiles
  for each row execute function fn_audit();

-- ---------- Realtime: dashboard "Today" board subscribes to this ----------
do $$
begin
  alter publication supabase_realtime add table attendance_days;
exception when others then
  raise notice 'could not add attendance_days to supabase_realtime — enable it in Dashboard > Database > Replication';
end
$$;

-- ---------- Schedule the finalizer (00:30 IST = 19:00 UTC) ----------
-- pg_cron ships with Supabase but may need enabling once in the
-- dashboard (Database -> Extensions -> pg_cron). Guarded so this
-- migration never fails.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'finalize-yesterday',
    '0 19 * * *',
    $job$ select fn_finalize_day(((now() at time zone 'Asia/Kolkata')::date - 1)) $job$
  );
exception when others then
  raise notice 'pg_cron unavailable — enable it in the dashboard, then re-run the cron.schedule call from 0003_attendance_logic.sql manually.';
end
$$;
