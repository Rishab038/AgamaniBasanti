-- ============================================================
-- 0029: teach the payroll engine the PF formula (0028).
--
-- Three pay bases now:
--   NO_PAY_NO_WORK -> daily wage
--   PF             -> component proration on 26 days + statutory
--                     deductions (this migration)
--   else           -> monthly salary÷30 with 4-day leave allowance
--
-- present_days counts a worked day as 1 and a half day as 0.5; days
-- past 26 become overtime paid at S/26.
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
  v_esi_pct      numeric;
  v_pf_pct       numeric;
  r              record;
  c              record;
  v_start        date;
  v_eligible     integer;
  v_present      numeric;
  v_per_day      numeric;
  v_f            numeric;
  v_extra_days   numeric;
  v_overtime_d   numeric;
  v_S            numeric;
  v_O            numeric;
  v_gross        numeric;
  v_pf           numeric;
  v_esi          numeric;
  v_pt           numeric;
  v_deduction    numeric;
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
  v_esi_pct := coalesce((select (value)::text::numeric from app_settings where key = 'esi_percent'), 0.75);
  v_pf_pct  := coalesce((select (value)::text::numeric from app_settings where key = 'pf_percent'), 12);

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

    -- days on the floor (paid leave counts as present), half = 0.5
    v_present := c.worked + c.leave_paid + (c.half * 0.5);
    v_overtime_d := c.overtime;   -- owner-approved rostered-leave-day work

    -- ---------------- PF: statutory component formula ----------------
    if r.employment_type = 'PF' then
      v_S := coalesce(r.salary_basic, 0) + coalesce(r.salary_hra, 0)
           + coalesce(r.salary_conveyance, 0) + coalesce(r.salary_washing, 0);
      -- fall back to base_salary if the components were never split out
      if v_S = 0 then v_S := r.base_salary; end if;

      v_per_day := v_S / v_standard;
      v_extra_days := greatest(0, v_present - v_standard);
      v_f := least(v_present, v_standard) / v_standard;
      v_O := round(v_per_day * (v_extra_days + v_overtime_d), 2);

      v_gross := round(v_S * v_f + v_O, 2);
      v_pf  := round(coalesce(r.salary_basic, r.base_salary) * v_f * v_pf_pct / 100.0, 2);
      v_esi := round(v_gross * v_esi_pct / 100.0, 2);
      v_pt  := fn_professional_tax(v_gross);
      v_deduction := v_pf + v_esi + v_pt;
      v_avail := greatest(0, v_gross - v_deduction);

      select coalesce(sum(balance), 0) into v_outstanding
      from advance_balances where profile_id = r.id;
      v_cut := least(v_outstanding, v_avail);   -- PF: advance recovered in full up to net
      v_net := v_avail - v_cut;

      insert into payslips (payroll_run_id, profile_id, gross, deductions, advance_cut, net, data)
      values (
        v_run, r.id, v_gross, v_deduction, v_cut, v_net,
        jsonb_build_object(
          'month', v_month, 'employment_type', 'PF', 'pay_basis', 'PF_STATUTORY',
          'standard_working_days', v_standard,
          'salary_total', v_S,
          'salary_basic', r.salary_basic, 'salary_hra', r.salary_hra,
          'salary_conveyance', r.salary_conveyance, 'salary_washing', r.salary_washing,
          'per_day_rate', round(v_per_day, 2),
          'present_days', v_present, 'attendance_fraction', round(v_f, 6),
          'extra_days', v_extra_days, 'overtime_days', v_overtime_d, 'overtime_pay', v_O,
          'payable_basic', round(coalesce(r.salary_basic, r.base_salary) * v_f, 2),
          'pf', v_pf, 'esi', v_esi, 'professional_tax', v_pt,
          'absent_days', c.absent, 'half_days', c.half,
          'single_verified_days', c.single_verified,
          'advance_outstanding_before', v_outstanding
        )
      );
      continue;
    end if;

    -- ---------------- NO_PAY_NO_WORK: daily wage ----------------
    if r.employment_type = 'NO_PAY_NO_WORK' then
      v_per_day := r.base_salary;
      v_gross := round(v_per_day * (c.worked + c.overtime + (c.half * 0.5)), 2);
      v_avail := v_gross;
      select coalesce(sum(balance), 0) into v_outstanding
      from advance_balances where profile_id = r.id;
      v_cut := least(v_outstanding, round(v_avail * v_pct / 100.0, 2));
      v_net := v_avail - v_cut;
      insert into payslips (payroll_run_id, profile_id, gross, deductions, advance_cut, net, data)
      values (
        v_run, r.id, v_gross, 0, v_cut, v_net,
        jsonb_build_object(
          'month', v_month, 'employment_type', 'NO_PAY_NO_WORK', 'pay_basis', 'DAILY_WAGE',
          'per_day_rate', round(v_per_day, 2), 'worked_days', c.worked, 'half_days', c.half,
          'advance_outstanding_before', v_outstanding
        )
      );
      continue;
    end if;

    -- ---------------- NORMAL / CONTRACT / unset: salary ÷ 30 ----------------
    v_per_day := r.base_salary / 30;
    v_gross := round(r.base_salary * v_eligible / v_days, 2);
    v_absence := c.absent + c.leave_unpaid + c.leave_paid;
    v_unpaid := greatest(0, v_absence - coalesce(r.monthly_leave_days, 4))
                + c.no_pay + (c.half * 0.5);
    v_deduction := round(v_per_day * v_unpaid, 2);
    v_extra_days := greatest(0, (c.worked + c.overtime + (c.half * 0.5)) - v_standard);
    v_O := round(v_per_day * (v_extra_days + c.overtime), 2);
    v_avail := greatest(0, v_gross - v_deduction + v_O);
    select coalesce(sum(balance), 0) into v_outstanding
    from advance_balances where profile_id = r.id;
    v_cut := least(v_outstanding, round(v_avail * v_pct / 100.0, 2));
    v_net := v_avail - v_cut;
    insert into payslips (payroll_run_id, profile_id, gross, deductions, advance_cut, net, data)
    values (
      v_run, r.id, v_gross, v_deduction, v_cut, v_net,
      jsonb_build_object(
        'month', v_month, 'employment_type', coalesce(r.employment_type::text, 'NORMAL'),
        'pay_basis', 'MONTHLY', 'base_salary', r.base_salary, 'days_in_month', v_days,
        'eligible_days', v_eligible, 'per_day_rate', round(v_per_day, 2),
        'standard_working_days', v_standard, 'worked_days', c.worked, 'half_days', c.half,
        'overtime_days', c.overtime, 'extra_days_beyond_standard', v_extra_days,
        'overtime_pay', v_O, 'leave_allowance', coalesce(r.monthly_leave_days, 4),
        'unpaid_days_total', v_unpaid, 'absent_days', c.absent,
        'single_verified_days', c.single_verified,
        'advance_outstanding_before', v_outstanding
      )
    );
  end loop;

  return v_run;
end;
$$;

revoke all on function fn_generate_payroll(uuid, date) from public, anon;
grant execute on function fn_generate_payroll(uuid, date) to authenticated;
revoke all on function fn_professional_tax(numeric) from public, anon;
grant execute on function fn_professional_tax(numeric) to authenticated;
