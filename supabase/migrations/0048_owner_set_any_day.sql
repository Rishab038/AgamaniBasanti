-- ============================================================
-- 0048: the owner can set any staff member's day, on any past date.
--
-- fn_decide_day already rules on a day, but only one that exists:
-- "no attendance record for that day" is exactly the case that needs
-- fixing when everyone was too busy to mark anything and the row was
-- never created. fn_mark_present creates a row but only ever says
-- present.
--
-- This is the one door for all of it: pick a person, pick a day, say
-- what it should be. The row is created if missing, and the existing
-- decision semantics apply on top so nothing here invents a second way
-- for a day to become paid.
--
-- Deliberately not allowed:
--   * future dates — a day that has not happened cannot be attended
--   * a frozen month — once payroll is confirmed the figures are the
--     record, and quietly moving a day under them would make the
--     payslip a lie. The owner must reopen that month first.
-- ============================================================

create or replace function fn_owner_set_day(
  p_profile  uuid,
  p_date     date,
  p_decision text,           -- NORMAL | HALF_DAY | NO_PAY | OVERTIME
  p_note     text default null
)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_exists boolean;
  v_branch uuid;
  v_frozen boolean;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can change attendance';
  end if;

  if p_decision not in ('NORMAL', 'HALF_DAY', 'NO_PAY', 'OVERTIME') then
    raise exception 'unknown decision: %', p_decision;
  end if;

  if p_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'that day has not happened yet';
  end if;

  select branch_id into v_branch
  from profiles where id = p_profile and role = 'worker' and active;
  if v_branch is null then
    raise exception 'no such active worker';
  end if;

  -- A confirmed payroll run is a paid record. Changing a day inside it
  -- would leave the payslip and the attendance disagreeing, with the
  -- money already out the door.
  select exists (
    select 1 from payroll_runs
    where branch_id = v_branch
      and status = 'CONFIRMED'
      and month = date_trunc('month', p_date)::date
  ) into v_frozen;
  if v_frozen then
    raise exception
      'salary for % is already confirmed — reopen that month before changing this day',
      to_char(p_date, 'Mon YYYY');
  end if;

  select true into v_exists
  from attendance_days where profile_id = p_profile and work_date = p_date;

  -- No record at all: create one that already says what the owner
  -- wants, so fn_decide_day below has something to rule on.
  if v_exists is null then
    insert into attendance_days (
      profile_id, work_date, status, note, updated_at
    )
    values (
      p_profile, p_date,
      case p_decision
        when 'NO_PAY'   then 'ABSENT'::day_status
        when 'HALF_DAY' then 'HALF_DAY'::day_status
        when 'OVERTIME' then 'OVERTIME'::day_status
        else 'MANUAL'::day_status      -- present on the owner's word
      end,
      coalesce(p_note, 'Set by the owner'),
      now()
    );
  end if;

  -- one path for the ruling itself, so the status/decision rules and
  -- the audit trail stay in a single place
  perform fn_decide_day(p_profile, p_date, p_decision, p_note);
end;
$$;

revoke all on function fn_owner_set_day(uuid, date, text, text) from public, anon;
grant execute on function fn_owner_set_day(uuid, date, text, text) to authenticated;

comment on function fn_owner_set_day(uuid, date, text, text) is
  'Owner-only. Set any active worker''s attendance for any past day, '
  'creating the record if it was never made. Refuses future dates and '
  'any month whose payroll is already confirmed.';
