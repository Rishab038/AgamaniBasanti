-- ============================================================
-- 0005: the salary engine.
--
-- Model (standard for monthly-salaried shop staff in India):
--   per_day    = base_salary / days_in_calendar_month
--   gross      = base_salary, prorated if the worker joined mid-month
--   unpaid     = ABSENT + LEAVE_UNPAID + paid leave beyond the monthly
--                quota + days with no record at all
--   deduction  = per_day * unpaid_days
--   advance    = min(outstanding balance, X% of what remains) — X is
--                app_settings.advance_recovery_percent (default 25)
--   net        = gross - deduction - advance
--
-- Paid by default: VERIFIED, APP_ONLY, DEVICE_ONLY (single-verified
-- days count for pay but stay visible in the payslip snapshot),
-- HOLIDAY, OFF_DAY, and LEAVE_PAID within quota.
--
-- Two-step flow: fn_generate_payroll makes a DRAFT the owner can
-- regenerate freely; fn_confirm_payroll freezes it, applies advance
-- repayments oldest-first, and notifies each worker. Confirmed runs
-- are immutable (and audited).
-- ============================================================

insert into app_settings (key, value) values
  ('advance_recovery_percent', '25'),
  ('default_paid_leaves_per_month', '1')
on conflict (key) do nothing;

create or replace function fn_generate_payroll(p_branch uuid, p_month date)
returns uuid
language plpgsql security definer set search_path = public as
$$
declare
  v_run          uuid;
  v_status       payroll_status;
  v_month        date := date_trunc('month', p_month)::date;
  v_month_end    date;
  v_days         integer;
  v_quota        numeric;
  v_pct          integer;
  r              record;
  c              record;
  v_start        date;
  v_eligible     integer;
  v_recorded     integer;
  v_missing      integer;
  v_excess_leave numeric;
  v_unpaid       numeric;
  v_per_day      numeric;
  v_gross        numeric;
  v_deduction    numeric;
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
  v_quota := coalesce(
    (select paid_leaves_per_month from leave_policies where branch_id = p_branch limit 1),
    fn_setting_int('default_paid_leaves_per_month', 1)
  );

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
      count(*) filter (where status in ('VERIFIED','APP_ONLY','DEVICE_ONLY'))        as worked,
      count(*) filter (where status in ('APP_ONLY','DEVICE_ONLY'))                   as single_verified,
      count(*) filter (where status in ('HOLIDAY','OFF_DAY'))                        as rest_days,
      count(*) filter (where status = 'LEAVE_PAID')                                  as leave_paid,
      count(*) filter (where status = 'LEAVE_UNPAID')                                as leave_unpaid,
      count(*) filter (where status = 'ABSENT')                                      as absent
    into c
    from attendance_days
    where profile_id = r.id and work_date between v_start and v_month_end;

    v_recorded := c.worked + c.rest_days + c.leave_paid + c.leave_unpaid + c.absent;
    -- days the system knows nothing about count as unpaid, and are
    -- shown on the payslip so nobody is docked silently
    v_missing := greatest(0, v_eligible - v_recorded);
    v_excess_leave := greatest(0, c.leave_paid - v_quota);
    v_unpaid := c.absent + c.leave_unpaid + v_excess_leave + v_missing;

    v_per_day := r.base_salary / v_days;
    v_gross := round(r.base_salary * v_eligible / v_days, 2);
    v_deduction := round(v_per_day * v_unpaid, 2);
    v_avail := greatest(0, v_gross - v_deduction);

    select coalesce(sum(balance), 0) into v_outstanding
    from advance_balances where profile_id = r.id;
    v_cut := least(v_outstanding, round(v_avail * v_pct / 100.0, 2));
    v_net := v_avail - v_cut;

    insert into payslips (payroll_run_id, profile_id, gross, deductions, advance_cut, net, data)
    values (
      v_run, r.id, v_gross, v_deduction, v_cut, v_net,
      jsonb_build_object(
        'month', v_month,
        'base_salary', r.base_salary,
        'days_in_month', v_days,
        'eligible_days', v_eligible,
        'per_day_rate', round(v_per_day, 2),
        'worked_days', c.worked,
        'single_verified_days', c.single_verified,
        'rest_days', c.rest_days,
        'paid_leave_days', c.leave_paid,
        'paid_leave_quota', v_quota,
        'excess_leave_days', v_excess_leave,
        'unpaid_leave_days', c.leave_unpaid,
        'absent_days', c.absent,
        'missing_days', v_missing,
        'unpaid_days_total', v_unpaid,
        'advance_outstanding_before', v_outstanding,
        'advance_recovery_percent', v_pct
      )
    );
  end loop;

  return v_run;
end;
$$;

create or replace function fn_confirm_payroll(p_run uuid)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  v_status  payroll_status;
  v_month   date;
  ps        record;
  adv       record;
  v_remaining numeric;
  v_take    numeric;
  v_applied numeric;
begin
  if not fn_is_owner() then
    raise exception 'only the owner can confirm payroll';
  end if;

  select status, month into v_status, v_month from payroll_runs where id = p_run;
  if v_status is null then raise exception 'payroll run not found'; end if;
  if v_status = 'CONFIRMED' then raise exception 'already confirmed'; end if;

  for ps in select * from payslips where payroll_run_id = p_run loop
    -- apply the advance cut oldest-first against real balances,
    -- which may have changed since the draft was generated
    v_remaining := ps.advance_cut;
    v_applied := 0;
    for adv in
      select b.advance_id, b.balance
      from advance_balances b
      join advances a on a.id = b.advance_id
      where b.profile_id = ps.profile_id and b.balance > 0
      order by a.created_at
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, adv.balance);
      insert into advance_repayments (advance_id, payroll_run_id, amount)
      values (adv.advance_id, p_run, v_take);
      v_remaining := v_remaining - v_take;
      v_applied := v_applied + v_take;
    end loop;

    -- if balances shrank since the draft, the payslip reflects what
    -- was actually recovered
    if v_applied <> ps.advance_cut then
      update payslips
      set advance_cut = v_applied,
          net = greatest(0, gross - deductions) - v_applied,
          data = data || jsonb_build_object('advance_cut_adjusted_at_confirm', true)
      where id = ps.id;
    end if;

    insert into notifications (profile_id, title, body, type)
    values (
      ps.profile_id,
      'Your payslip is ready',
      'Salary for ' || to_char(v_month, 'FMMonth YYYY') || ' has been finalised. Open the Money tab to see it.',
      'payslip'
    );
  end loop;

  update payroll_runs
  set status = 'CONFIRMED', confirmed_at = now()
  where id = p_run;
end;
$$;
