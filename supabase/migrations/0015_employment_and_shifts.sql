-- ============================================================
-- 0015: employment type + per-staff shift timing.
--
-- EMPLOYMENT TYPE
-- Three kinds of staff, which in Indian shop practice imply different
-- pay treatment:
--   NO_PAY_NO_WORK — paid only for days actually worked; by definition
--                    there is no paid-leave entitlement
--   CONTRACT       — engaged on contract terms
--   PF             — formal employee with provident-fund deductions
--
-- The column is deliberately NULLABLE. Nothing is assumed about a
-- person's employment terms: unset shows as "Not set" in the dashboard
-- and is chosen explicitly by the owner, the same way salary is.
--
-- The payroll engine reads the type but does NOT yet vary its maths by
-- it — the client has not decided the rules (leave entitlement per
-- type, PF percentage, contract handling). See fn_generate_payroll's
-- TODO. Storing it now means the data is being captured from day one,
-- so the rules can be applied retroactively once agreed.
--
-- SHIFT TIMING
-- Times live on the staff member rather than in the branch-level
-- `shifts` table, because the client wants them per person. Both are
-- nullable: a worker with no shift_start is simply never marked late,
-- which is how every existing worker behaves today.
-- ============================================================

do $$ begin
  create type employment_type as enum ('NO_PAY_NO_WORK', 'CONTRACT', 'PF');
exception when duplicate_object then null;
end $$;

alter table profiles add column if not exists employment_type employment_type;
alter table profiles add column if not exists shift_start   time;
alter table profiles add column if not exists shift_end     time;
alter table profiles add column if not exists lunch_minutes integer not null default 60;

comment on column profiles.employment_type is
  'NULL = not yet categorised. Pay rules per type are not implemented yet.';
comment on column profiles.lunch_minutes is
  'Unpaid break within the shift. Default 60. Not yet used in any calculation.';

-- ---------- late arrival now uses the staff member''s own shift ----------
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
  select device_enroll_no, branch_id, shift_start
    into v_enroll, v_branch, v_shift_start
  from profiles where id = p_profile;

  select min(server_ts), max(server_ts) into v_app_first, v_app_last
  from attendance_app
  where profile_id = p_profile and fn_ist_date(server_ts) = p_date;

  select min(dp.punched_at), max(dp.punched_at) into v_dev_first, v_dev_last
  from device_punches dp
  join devices d on d.serial = dp.device_serial
  where dp.enroll_no = v_enroll
    and d.branch_id = v_branch
    and fn_ist_date(dp.punched_at) = p_date;

  if v_app_first is null and v_dev_first is null then
    return;  -- nightly finalizer decides ABSENT/HOLIDAY/etc.
  end if;

  -- both sources present anywhere in the day -> verified automatically
  if v_app_first is not null and v_dev_first is not null then
    v_status := 'VERIFIED';
  elsif v_app_first is not null then
    v_status := 'APP_ONLY';
  else
    v_status := 'DEVICE_ONLY';
  end if;

  v_first_in := least(coalesce(v_app_first, v_dev_first), coalesce(v_dev_first, v_app_first));
  v_last_out := greatest(coalesce(v_app_last, v_dev_last), coalesce(v_dev_last, v_app_last));

  -- no shift set for this person -> never flagged late
  if v_shift_start is not null then
    v_grace := fn_setting_int('default_grace_minutes', 15);
    v_late := greatest(0,
      (extract(epoch from (
        (v_first_in at time zone 'Asia/Kolkata')::time - v_shift_start
      )) / 60)::integer - v_grace
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
    where attendance_days.approved_by is null;
end;
$$;

revoke all on function fn_rebuild_attendance_day(uuid, date) from public, anon, authenticated;

-- ---------- record employment type on the frozen payslip ----------
-- The figure maths is unchanged; the type is captured in the snapshot
-- so past payslips remain explainable once per-type rules land.
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
    v_missing := greatest(0, v_eligible - v_recorded);

    -- TODO (needs client decision) vary by r.employment_type:
    --   NO_PAY_NO_WORK -> v_quota should be 0 (no paid leave at all),
    --                     and rest_days arguably unpaid too
    --   PF             -> statutory PF deduction on the payslip
    --   CONTRACT       -> per-contract handling
    -- Until those rules are agreed every type is treated identically,
    -- which matches how the shop is being paid today.
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
        'employment_type', r.employment_type,
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

revoke all on function fn_generate_payroll(uuid, date) from public, anon;
grant execute on function fn_generate_payroll(uuid, date) to authenticated;
