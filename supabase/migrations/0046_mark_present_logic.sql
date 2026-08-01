-- ============================================================
-- 0046: marking present — the logic, the bug fix, and the payroll.
--
-- Separate from 0045 because Postgres will not let a newly added enum
-- value be used in the same transaction that adds it.
-- ============================================================

-- ---------- 1. the owner's action ----------
create or replace function fn_mark_present(
  p_profile uuid,
  p_date    date,
  p_note    text default null
)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_existing day_status;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can mark someone present';
  end if;

  -- Not the future. A day that has not happened cannot be attended, and
  -- the mistake is easy to make with a date picker.
  if p_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'that day has not happened yet';
  end if;

  if not exists (select 1 from profiles where id = p_profile and role = 'worker') then
    raise exception 'no such worker';
  end if;

  select status into v_existing
  from attendance_days where profile_id = p_profile and work_date = p_date;

  -- Someone who actually punched already has a real status backed by
  -- evidence; overwriting it with MANUAL would throw that away. For
  -- them this is just an owner ruling, which is what decision is for.
  if v_existing is not null
     and v_existing in ('VERIFIED', 'APP_ONLY', 'DEVICE_ONLY', 'HALF_DAY', 'OVERTIME')
  then
    update attendance_days
       set decision = 'NORMAL', approved_by = auth.uid(),
           note = coalesce(p_note, note), updated_at = now()
     where profile_id = p_profile and work_date = p_date;
    return;
  end if;

  insert into attendance_days (
    profile_id, work_date, status, decision, approved_by, note, updated_at
  )
  values (
    p_profile, p_date, 'MANUAL', 'NORMAL', auth.uid(),
    coalesce(p_note, 'Marked present by the owner'), now()
  )
  on conflict (profile_id, work_date) do update
    set status      = 'MANUAL',
        decision    = 'NORMAL',
        approved_by = auth.uid(),
        note        = coalesce(p_note, attendance_days.note, 'Marked present by the owner'),
        updated_at  = now();
end;
$$;

revoke all on function fn_mark_present(uuid, date, text) from public, anon;
grant execute on function fn_mark_present(uuid, date, text) to authenticated;

-- Undo, for the inevitable wrong row. Only removes a day that exists
-- purely on the owner's word — a real punch is never deleted this way.
create or replace function fn_unmark_present(p_profile uuid, p_date date)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
$$
begin
  if not fn_is_owner() then
    raise exception 'only the owner can undo this';
  end if;

  delete from attendance_days
   where profile_id = p_profile and work_date = p_date and status = 'MANUAL';

  -- put the day back the way the nightly job would have left it
  perform fn_finalize_day(p_date);
end;
$$;

revoke all on function fn_unmark_present(uuid, date) from public, anon;
grant execute on function fn_unmark_present(uuid, date) to authenticated;


-- ---------- 2. bug fix: ruling NORMAL must restore a payable status ----------
create or replace function fn_decide_day(
  p_profile uuid, p_date date, p_decision text, p_note text default null
)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_status day_status;
  v_has_punch boolean;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can decide attendance';
  end if;
  if p_decision not in ('NORMAL', 'HALF_DAY', 'NO_PAY', 'OVERTIME') then
    raise exception 'unknown decision: %', p_decision;
  end if;

  select status, first_in is not null into v_status, v_has_punch
  from attendance_days where profile_id = p_profile and work_date = p_date;
  if v_status is null then
    raise exception 'no attendance record for that day';
  end if;

  update attendance_days
  set decision    = p_decision,
      approved_by = auth.uid(),
      note        = coalesce(p_note, note),
      status      = case p_decision
                      when 'HALF_DAY' then 'HALF_DAY'::day_status
                      when 'NO_PAY'   then 'ABSENT'::day_status
                      when 'OVERTIME' then 'OVERTIME'::day_status
                      -- NORMAL used to leave status alone, so a day the
                      -- owner had ruled ABSENT stayed ABSENT even after
                      -- being changed to Present — the screen said one
                      -- thing and payroll paid another. Now it becomes
                      -- payable again: MANUAL when nothing was punched,
                      -- otherwise rebuilt from the punches below.
                      else case
                             when v_status = 'ABSENT' then 'MANUAL'::day_status
                             else v_status
                           end
                    end,
      updated_at  = now()
  where profile_id = p_profile and work_date = p_date;

  -- With punches on the day, the honest status is whatever the evidence
  -- says; rebuilding recovers APP_ONLY / DEVICE_ONLY / VERIFIED and
  -- keeps the decision we just wrote.
  if p_decision = 'NORMAL' and v_has_punch then
    perform fn_rebuild_attendance_day(p_profile, p_date);
  end if;
end;
$$;

revoke all on function fn_decide_day(uuid, date, text, text) from public, anon;
grant execute on function fn_decide_day(uuid, date, text, text) to authenticated;


-- ---------- 3. repair the day already affected ----------
-- Soumen Dutta, 24 July: ruled Present, counted absent. He has punches,
-- so rebuilding gives him the status his evidence supports.
do $$
declare r record;
begin
  for r in
    select profile_id, work_date
    from attendance_days
    where decision = 'NORMAL' and status = 'ABSENT'
  loop
    if exists (
      select 1 from attendance_days
      where profile_id = r.profile_id and work_date = r.work_date and first_in is not null
    ) then
      perform fn_rebuild_attendance_day(r.profile_id, r.work_date);
    else
      update attendance_days set status = 'MANUAL', updated_at = now()
      where profile_id = r.profile_id and work_date = r.work_date;
    end if;
  end loop;
end$$;
