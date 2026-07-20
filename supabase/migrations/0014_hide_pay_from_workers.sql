-- ============================================================
-- 0014: pay figures are owner-only.
--
-- The worker app no longer displays salary or payslips, but hiding a
-- screen is not the same as removing access — a worker's token could
-- still read /rest/v1/payslips directly. Payslips carry gross, unpaid-day
-- deductions and net pay, so the policy is narrowed to the owner.
--
-- Also fixes the payday notification, which told workers to "open the
-- Money tab to see it" — that section no longer exists, so the message
-- now points them at the owner instead.
--
-- NOTE (deliberately not changed): profiles.base_salary is still
-- readable by the worker who owns the row. RLS cannot restrict columns,
-- so hiding it means moving salary to its own owner-only table — a
-- refactor across the payroll engine and staff admin. Left as-is
-- because a worker reading their own agreed salary is not a leak; what
-- matters is that no worker can read anyone else's, which existing
-- policy already guarantees.
-- ============================================================

drop policy if exists payslip_read on payslips;
create policy payslip_read on payslips for select to authenticated
  using (fn_is_owner());

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
      'Salary finalised',
      'Your salary for ' || to_char(v_month, 'FMMonth YYYY') ||
        ' has been finalised. Please collect your payslip from the shop owner.',
      'payslip'
    );
  end loop;

  update payroll_runs
  set status = 'CONFIRMED', confirmed_at = now()
  where id = p_run;
end;
$$;

revoke all on function fn_confirm_payroll(uuid) from public, anon;
grant execute on function fn_confirm_payroll(uuid) to authenticated;
