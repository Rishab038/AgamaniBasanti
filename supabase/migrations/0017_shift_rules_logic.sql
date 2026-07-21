-- ============================================================
-- 0017: shift-window enforcement, owner decisions, and pay rules
--       that differ by employment type.
--
-- WINDOW RULES
--   check-in  allowed within ±grace of shift_start
--   check-out allowed within ±grace of shift_end
--   grace defaults to 15 min (app_settings.shift_grace_minutes) and
--   can be overridden per date in special_days for festivals.
--
--   Punches outside the window are recorded and flagged, never
--   blocked. A blocked punch leaves no evidence that the person was
--   present at all, which is worse for the worker and the owner than
--   a flagged one the owner can rule on.
--
-- OWNER DECISIONS on a flagged day: NORMAL | HALF_DAY | NO_PAY, plus
-- OVERTIME for someone who worked a day rostered as their leave.
--
-- PAY (per employment type)
--   PF / CONTRACT / unset : monthly salary ÷ 30 = per-day rate.
--       The month's pay covers 30 days of which `monthly_leave_days`
--       (default 4) may be missed with no deduction. Absences beyond
--       that allowance are deducted at the per-day rate. A day worked
--       on assigned leave, once approved, ADDS one per-day rate.
--   NO_PAY_NO_WORK : base_salary is read as a DAILY wage. Paid strictly
--       for days worked; no leave allowance, no absence deduction.
--
-- Half day = half the per-day rate, both as a deduction (monthly staff)
-- and as earnings (daily-wage staff).
-- ============================================================

-- ---------- effective shift for one worker on one date ----------
create or replace function fn_effective_shift(p_profile uuid, p_date date)
returns table (shift_start time, shift_end time, grace_minutes integer)
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_branch uuid;
  p_start time; p_end time;
  s_start time; s_end time; s_grace integer;
begin
  select branch_id, profiles.shift_start, profiles.shift_end
    into v_branch, p_start, p_end
  from profiles where id = p_profile;

  select special_days.shift_start, special_days.shift_end, special_days.grace_minutes
    into s_start, s_end, s_grace
  from special_days
  where branch_id = v_branch and on_date = p_date;

  return query select
    coalesce(s_start, p_start),
    coalesce(s_end, p_end),
    coalesce(s_grace, fn_setting_int('shift_grace_minutes', 15));
end;
$$;

-- ---------- rebuild one worker-day ----------
create or replace function fn_rebuild_attendance_day(p_profile uuid, p_date date)
returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_app_first  timestamptz;
  v_app_out    timestamptz;   -- last explicit OUT punch from the app
  v_app_last   timestamptz;
  v_dev_first  timestamptz;
  v_dev_last   timestamptz;
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
  select min(server_ts), max(server_ts) into v_app_first, v_app_last
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
  v_last_out := greatest(coalesce(v_app_last, v_dev_last), coalesce(v_dev_last, v_app_last));

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

  -- time actually on the floor, minus the unpaid lunch break
  v_worked := greatest(
    0,
    (extract(epoch from (v_last_out - v_first_in)) / 60)::integer - v_lunch
  );

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

-- ---------- owner decides a flagged day ----------
create or replace function fn_decide_day(
  p_profile  uuid,
  p_date     date,
  p_decision text,             -- NORMAL | HALF_DAY | NO_PAY | OVERTIME
  p_note     text default null
)
returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_status day_status;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can decide attendance';
  end if;
  if p_decision not in ('NORMAL', 'HALF_DAY', 'NO_PAY', 'OVERTIME') then
    raise exception 'unknown decision: %', p_decision;
  end if;

  select status into v_status
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
                      else status
                    end,
      updated_at  = now()
  where profile_id = p_profile and work_date = p_date;
end;
$$;

-- ---------- payroll ----------
create or replace function fn_generate_payroll(p_branch uuid, p_month date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_run          uuid;
  v_status       payroll_status;
  v_month        date := date_trunc('month', p_month)::date;
  v_month_end    date;
  v_days         integer;
  v_pct          integer;
  r              record;
  c              record;
  v_start        date;
  v_eligible     integer;
  v_daily        boolean;
  v_per_day      numeric;
  v_gross        numeric;
  v_deduction    numeric;
  v_overtime     numeric;
  v_absence      numeric;
  v_unpaid       numeric;
  v_avail        numeric;
  v_outstanding  numeric;
  v_cut          numeric;
  v_net          numeric;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can run payroll';
  end if;

  v_month_end := (v_month + interval '1 month - 1 day')::date;
  v_days := extract(day from v_month_end)::integer;
  v_pct := fn_setting_int('advance_recovery_percent', 25);

  insert into payroll_runs (branch_id, month, status, created_by)
  values (p_branch, v_month, 'DRAFT', auth.uid())
  on conflict (branch_id, month) do update set created_by = excluded.created_by
  returning id, status into v_run, v_status;

  if v_status = 'CONFIRMED' then
    raise exception 'payroll for this month is already confirmed';
  end if;

  delete from payslips where payroll_run_id = v_run;

  for r in
    select * from profiles
    where branch_id = p_branch and role = 'worker' and active
  loop
    v_start := greatest(v_month, coalesce(r.joined_on, v_month));
    v_eligible := (v_month_end - v_start) + 1;
    if v_eligible <= 0 then continue; end if;

    select
      count(*) filter (where status in ('VERIFIED','APP_ONLY','DEVICE_ONLY')) as worked,
      count(*) filter (where status = 'HALF_DAY')                             as half,
      count(*) filter (where status = 'OVERTIME')                             as overtime,
      count(*) filter (where status in ('HOLIDAY','OFF_DAY'))                 as rest_days,
      count(*) filter (where status = 'LEAVE_PAID')                           as leave_paid,
      count(*) filter (where status = 'LEAVE_UNPAID')                         as leave_unpaid,
      count(*) filter (where status = 'ABSENT' and coalesce(decision,'') <> 'NO_PAY') as absent,
      count(*) filter (where decision = 'NO_PAY')                             as no_pay,
      count(*) filter (where status in ('APP_ONLY','DEVICE_ONLY'))            as single_verified
    into c
    from attendance_days
    where profile_id = r.id and work_date between v_start and v_month_end;

    v_daily := (r.employment_type = 'NO_PAY_NO_WORK');

    if v_daily then
      -- base_salary is a DAILY wage for this type
      v_per_day := r.base_salary;
      v_gross := round(v_per_day * (c.worked + c.overtime + (c.half * 0.5)), 2);
      v_deduction := 0;
      v_overtime := 0;   -- every worked day is already paid at the daily rate
      v_unpaid := 0;
    else
      -- monthly staff: 30-day divisor regardless of calendar length,
      -- which is what "salary ÷ 30" means in practice
      v_per_day := r.base_salary / 30;
      v_gross := round(r.base_salary * v_eligible / v_days, 2);

      -- any day neither worked nor a shop holiday counts against the
      -- monthly leave allowance; beyond it, each day is deducted
      v_absence := c.absent + c.leave_unpaid + c.leave_paid;
      v_unpaid := greatest(0, v_absence - coalesce(r.monthly_leave_days, 4))
                  + c.no_pay
                  + (c.half * 0.5);
      v_deduction := round(v_per_day * v_unpaid, 2);
      v_overtime := round(v_per_day * c.overtime, 2);
    end if;

    v_avail := greatest(0, v_gross - v_deduction + v_overtime);

    select coalesce(sum(balance), 0) into v_outstanding
    from advance_balances where profile_id = r.id;
    v_cut := least(v_outstanding, round(v_avail * v_pct / 100.0, 2));
    v_net := v_avail - v_cut;

    insert into payslips (payroll_run_id, profile_id, gross, deductions, advance_cut, net, data)
    values (
      v_run, r.id, v_gross, v_deduction, v_cut, v_net,
      jsonb_build_object(
        'month', v_month,
        'employment_type', coalesce(r.employment_type::text, 'NOT_SET'),
        'pay_basis', case when v_daily then 'DAILY_WAGE' else 'MONTHLY' end,
        'base_salary', r.base_salary,
        'days_in_month', v_days,
        'eligible_days', v_eligible,
        'per_day_rate', round(v_per_day, 2),
        'worked_days', c.worked,
        'half_days', c.half,
        'overtime_days', c.overtime,
        'overtime_pay', v_overtime,
        'single_verified_days', c.single_verified,
        'rest_days', c.rest_days,
        'paid_leave_days', c.leave_paid,
        'leave_allowance', coalesce(r.monthly_leave_days, 4),
        'unpaid_leave_days', c.leave_unpaid,
        'absent_days', c.absent,
        'no_pay_days', c.no_pay,
        'unpaid_days_total', v_unpaid,
        'advance_outstanding_before', v_outstanding,
        'advance_recovery_percent', v_pct
      )
    );
  end loop;

  return v_run;
end;
$$;

-- ---------- grants (0011 rules: revoke public+anon, grant deliberately) ----------
revoke all on function fn_effective_shift(uuid, date)        from public, anon;
revoke all on function fn_rebuild_attendance_day(uuid, date) from public, anon, authenticated;
revoke all on function fn_decide_day(uuid, date, text, text) from public, anon;
revoke all on function fn_generate_payroll(uuid, date)       from public, anon;

grant execute on function fn_effective_shift(uuid, date)        to authenticated;
grant execute on function fn_decide_day(uuid, date, text, text) to authenticated;
grant execute on function fn_generate_payroll(uuid, date)       to authenticated;
