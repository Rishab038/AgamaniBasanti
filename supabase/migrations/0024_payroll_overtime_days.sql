-- ============================================================
-- 0024: pay extra days worked beyond the monthly standard.
--
--   per-day rate      = monthly salary ÷ 30
--   expected days     = 26  (30 paid − 4 leave)
--   extra days worked = max(0, days worked − 26)
--   extra pay         = per-day rate × extra days
--
-- NORMAL now also drives the fallback: an employee whose type has not
-- been set is treated as NORMAL rather than silently getting the
-- monthly treatment by accident.
-- ============================================================

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
  v_standard     integer;
  r              record;
  c              record;
  v_start        date;
  v_eligible     integer;
  v_daily        boolean;
  v_per_day      numeric;
  v_gross        numeric;
  v_deduction    numeric;
  v_ot_leaveday  numeric;   -- worked a rostered leave day (owner decision)
  v_extra_days   numeric;   -- days worked beyond the monthly standard
  v_ot_extra     numeric;
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
  v_standard := fn_setting_int('standard_working_days', 26);

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
      v_overtime := 0;      -- every worked day is already paid
      v_ot_leaveday := 0;
      v_ot_extra := 0;
      v_extra_days := 0;
      v_unpaid := 0;
    else
      -- NORMAL / PF / CONTRACT (and unset, treated as NORMAL):
      -- 30-day divisor regardless of calendar length
      v_per_day := r.base_salary / 30;
      v_gross := round(r.base_salary * v_eligible / v_days, 2);

      v_absence := c.absent + c.leave_unpaid + c.leave_paid;
      v_unpaid := greatest(0, v_absence - coalesce(r.monthly_leave_days, 4))
                  + c.no_pay
                  + (c.half * 0.5);
      v_deduction := round(v_per_day * v_unpaid, 2);

      -- a rostered leave day the owner approved as overtime
      v_ot_leaveday := round(v_per_day * c.overtime, 2);

      -- days worked beyond the monthly standard (26 by default).
      -- Half days count as half a day towards the total.
      v_extra_days := greatest(
        0,
        (c.worked + c.overtime + (c.half * 0.5)) - v_standard
      );
      v_ot_extra := round(v_per_day * v_extra_days, 2);

      v_overtime := v_ot_leaveday + v_ot_extra;
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
        'employment_type', coalesce(r.employment_type::text, 'NORMAL'),
        'pay_basis', case when v_daily then 'DAILY_WAGE' else 'MONTHLY' end,
        'base_salary', r.base_salary,
        'days_in_month', v_days,
        'eligible_days', v_eligible,
        'per_day_rate', round(v_per_day, 2),
        'standard_working_days', v_standard,
        'worked_days', c.worked,
        'half_days', c.half,
        'overtime_days', c.overtime,
        'overtime_leaveday_pay', v_ot_leaveday,
        'extra_days_beyond_standard', v_extra_days,
        'extra_days_pay', v_ot_extra,
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

revoke all on function fn_generate_payroll(uuid, date) from public, anon;
grant execute on function fn_generate_payroll(uuid, date) to authenticated;
