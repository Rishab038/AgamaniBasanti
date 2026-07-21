-- ============================================================
-- 0015: shift-window rules, special days, assigned leave days.
--       (schema only — the logic that USES these lands in 0016,
--        because Postgres forbids using a new enum value in the
--        same transaction that adds it.)
--
-- Rules being modelled:
--   * A worker may check in within ±N minutes of their shift start
--     and check out within ±N minutes of shift end. N defaults to 15
--     and can be overridden for festivals/special days.
--   * Punches outside that window are RECORDED but flagged for the
--     owner. They are never blocked — a blocked punch means no
--     evidence at all, which is worse for everyone than a flagged one.
--   * Leaving early is a decision for the owner: normal / half day /
--     no pay.
--   * Working on a day assigned as the worker's leave is overtime and
--     needs approval before it is paid.
-- ============================================================

-- new day outcomes the owner can choose
alter type day_status add value if not exists 'HALF_DAY';
alter type day_status add value if not exists 'OVERTIME';

-- ---------- per-worker leave allowance ----------
-- PF/contract staff are paid for 30 days of which 4 are leave.
alter table profiles
  add column if not exists monthly_leave_days numeric(4,1) not null default 4;

-- ---------- why a day needs attention, and what was decided ----------
alter table attendance_days
  add column if not exists review_reasons text[] not null default '{}',
  add column if not exists decision text,          -- NORMAL | HALF_DAY | NO_PAY | OVERTIME
  add column if not exists worked_minutes integer;

comment on column attendance_days.review_reasons is
  'LATE_IN | EARLY_IN | EARLY_OUT | LATE_OUT | OFF_DAY_WORK — set by fn_rebuild_attendance_day';

-- ---------- festival / special days ----------
-- Overrides shift timings or the grace window for one date.
create table if not exists special_days (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id) on delete cascade,
  on_date       date not null,
  name          text not null,
  shift_start   time,            -- null = keep each worker's normal start
  shift_end     time,
  grace_minutes integer,         -- null = branch default
  created_at    timestamptz not null default now(),
  unique (branch_id, on_date)
);

alter table special_days enable row level security;

create policy special_read on special_days for select to authenticated using (true);
create policy special_write on special_days for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- assigned leave days ----------
-- The specific dates a given worker is rostered off. Working on one of
-- these is what triggers the overtime-approval flow.
create table if not exists staff_leave_days (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  on_date    date not null,
  note       text,
  created_at timestamptz not null default now(),
  unique (profile_id, on_date)
);

alter table staff_leave_days enable row level security;

create policy leaveday_read on staff_leave_days for select to authenticated
  using (profile_id = auth.uid() or fn_is_staff_admin());
create policy leaveday_write on staff_leave_days for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create index if not exists idx_leaveday_date on staff_leave_days(on_date);

-- ---------- default grace window ----------
insert into app_settings (key, value)
values ('shift_grace_minutes', '15')
on conflict (key) do nothing;
