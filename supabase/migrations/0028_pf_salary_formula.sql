-- ============================================================
-- 0028: statutory PF payroll.
--
-- PF staff are paid on a 26-working-day month with per-component
-- proration and three statutory deductions. Implements exactly the
-- client's validated formula:
--
--   f   = present_days / 26                    (attendance fraction)
--   Bp  = Basic  × f                           (payable basic)
--   G   = (Basic+HRA+Conv+Wash) × f  +  O      (gross payable)
--   PF  = Bp × 12%                             (on basic only)
--   ESI = G  × 0.75%
--   PT  = professional-tax slab on G
--   Net = G − PF − ESI − PT − advance
--
-- Overtime O = days worked beyond 26 (plus any owner-approved
-- rostered-leave-day work), each valued at the per-day rate S/26.
--
-- Only PF staff use this. NORMAL / CONTRACT keep salary÷30 with the
-- 4-day leave allowance; NO_PAY_NO_WORK stays a daily wage.
-- ============================================================

-- the four components; base_salary is kept = their sum for display
alter table profiles
  add column if not exists salary_basic       numeric(12,2) not null default 0,
  add column if not exists salary_hra         numeric(12,2) not null default 0,
  add column if not exists salary_conveyance  numeric(12,2) not null default 0,
  add column if not exists salary_washing     numeric(12,2) not null default 0;

-- ---------- West Bengal professional-tax slab ----------
-- The client observed: ≤10k → 0, 10k–15k → 110, >20k → 150. The
-- 15k–25k band (₹130) is the WB statutory value filling that gap;
-- confirm the exact figures with the client's accountant.
create or replace function fn_professional_tax(p_gross numeric)
returns numeric
language sql immutable set search_path = public, pg_temp as
$$
  select case
    when p_gross <= 10000 then 0
    when p_gross <= 15000 then 110
    when p_gross <= 25000 then 130
    else 150
  end::numeric
$$;

insert into app_settings (key, value)
values ('esi_percent', '0.75'), ('pf_percent', '12')
on conflict (key) do nothing;
