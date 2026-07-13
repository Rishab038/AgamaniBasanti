-- ============================================================
-- AgamaniBasanti Staff Management — 0001: core schema
-- All timestamps stored as timestamptz (UTC). Day boundaries are
-- always computed in Asia/Kolkata via fn_ist_date().
-- Money stored as numeric(12,2) INR.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Enums ----------
create type user_role as enum ('owner', 'supervisor', 'worker');

create type day_status as enum (
  'VERIFIED',     -- app check-in + device punch matched
  'APP_ONLY',     -- app check-in, no device punch (suspicious)
  'DEVICE_ONLY',  -- device punch, no app check-in (benign, flagged)
  'ABSENT',
  'LEAVE_PAID',
  'LEAVE_UNPAID',
  'HOLIDAY',
  'OFF_DAY'
);

create type punch_direction as enum ('IN', 'OUT');
create type request_status as enum ('PENDING', 'APPROVED', 'REJECTED');
create type checkin_flag as enum ('CLEAN', 'SUSPECT');
create type payroll_status as enum ('DRAFT', 'CONFIRMED');

-- ---------- Helper: IST date of a timestamp ----------
create or replace function fn_ist_date(ts timestamptz)
returns date language sql immutable as
$$ select (ts at time zone 'Asia/Kolkata')::date $$;

-- ---------- Global settings (key/value) ----------
create table app_settings (
  key   text primary key,
  value jsonb not null
);

insert into app_settings (key, value) values
  ('verify_window_minutes', '15'),      -- app punch <-> device punch pairing window
  ('selfie_retention_days', '90'),
  ('default_grace_minutes', '15');

-- ---------- Branches & shifts ----------
create table branches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  lat         double precision,
  lng         double precision,
  radius_m    integer not null default 100,
  wifi_ssid   text,
  wifi_bssid  text,
  created_at  timestamptz not null default now()
);

create table shifts (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  name           text not null,
  start_time     time not null,
  end_time       time not null,
  grace_minutes  integer not null default 15,
  -- days of week that are off (0=Sunday .. 6=Saturday)
  week_off       smallint[] not null default '{0}',
  created_at     timestamptz not null default now()
);

-- ---------- Staff profiles (1:1 with auth.users) ----------
create table profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  employee_code     text not null unique,
  full_name         text not null,
  role              user_role not null default 'worker',
  branch_id         uuid references branches(id),
  shift_id          uuid references shifts(id),
  phone             text,
  -- the one phone this worker may check in from; changes need owner action
  device_id         text,
  -- this worker's enrollment number on the fingerprint machine
  device_enroll_no  integer,
  base_salary       numeric(12,2) not null default 0,
  joined_on         date,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_profiles_branch on profiles(branch_id);
create unique index idx_profiles_enroll
  on profiles(branch_id, device_enroll_no)
  where device_enroll_no is not null;

-- ---------- Fingerprint machines ----------
create table devices (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  serial        text not null unique,   -- SN the machine reports over ADMS
  model         text,
  last_seen_at  timestamptz,            -- heartbeat: any ADMS/bridge contact
  created_at    timestamptz not null default now()
);

-- ---------- Raw punches: app side ----------
create table attendance_app (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id),
  branch_id     uuid not null references branches(id),
  direction     punch_direction not null,
  client_ts     timestamptz not null,          -- device clock at capture
  server_ts     timestamptz not null default now(),  -- authoritative
  lat           double precision,
  lng           double precision,
  accuracy_m    double precision,
  wifi_ssid     text,
  device_id     text,
  selfie_path   text,                          -- storage path in 'selfies' bucket
  selfie_sha256 text,                          -- tamper evidence, kept forever
  flag          checkin_flag not null default 'CLEAN',
  flag_reasons  text[] not null default '{}',
  synced_late   boolean not null default false, -- true when drained from offline queue
  created_at    timestamptz not null default now()
);

create index idx_attapp_profile_day on attendance_app(profile_id, fn_ist_date(server_ts));

-- ---------- Raw punches: fingerprint machine side ----------
create table device_punches (
  id            uuid primary key default gen_random_uuid(),
  device_serial text not null,
  enroll_no     integer not null,
  punched_at    timestamptz not null,
  status_code   smallint,          -- raw device status (in/out key)
  verify_code   smallint,          -- raw verify mode (1=fingerprint)
  raw           text,              -- original log line, for debugging
  received_at   timestamptz not null default now(),
  unique (device_serial, enroll_no, punched_at)   -- dedup on re-push
);

create index idx_devpunch_day on device_punches(enroll_no, fn_ist_date(punched_at));

-- ---------- Materialized daily status ----------
create table attendance_days (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id),
  work_date     date not null,
  status        day_status not null,
  first_in      timestamptz,
  last_out      timestamptz,
  late_minutes  integer not null default 0,
  approved_by   uuid references profiles(id),  -- owner override of APP_ONLY/DEVICE_ONLY
  note          text,
  updated_at    timestamptz not null default now(),
  unique (profile_id, work_date)
);

create index idx_attdays_date on attendance_days(work_date);

-- ---------- Leave ----------
create table leave_policies (
  id                     uuid primary key default gen_random_uuid(),
  branch_id              uuid not null references branches(id),
  paid_leaves_per_month  numeric(4,1) not null default 1,
  carry_forward          boolean not null default false,
  notes                  text
);

create table leave_requests (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id),
  from_date   date not null,
  to_date     date not null,
  paid        boolean not null default true,
  reason      text,
  status      request_status not null default 'PENDING',
  decided_by  uuid references profiles(id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  check (to_date >= from_date)
);

create table holidays (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id),
  on_date    date not null,
  name       text not null,
  unique (branch_id, on_date)
);

-- ---------- Advances ----------
create table advances (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references profiles(id),
  amount            numeric(12,2) not null check (amount > 0),
  reason            text,
  status            request_status not null default 'PENDING',
  -- how much to recover per payroll run once approved
  installment       numeric(12,2),
  decided_by        uuid references profiles(id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);

create table advance_repayments (
  id              uuid primary key default gen_random_uuid(),
  advance_id      uuid not null references advances(id),
  payroll_run_id  uuid,   -- fk added after payroll_runs exists
  amount          numeric(12,2) not null check (amount > 0),
  created_at      timestamptz not null default now()
);

-- running balance per advance
create view advance_balances as
select
  a.id as advance_id,
  a.profile_id,
  a.amount,
  a.amount - coalesce(sum(r.amount), 0) as balance
from advances a
left join advance_repayments r on r.advance_id = a.id
where a.status = 'APPROVED'
group by a.id;

-- ---------- Payroll ----------
create table payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  month        date not null,   -- always the 1st of the month
  status       payroll_status not null default 'DRAFT',
  created_by   uuid references profiles(id),
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (branch_id, month)
);

alter table advance_repayments
  add constraint fk_repay_run
  foreign key (payroll_run_id) references payroll_runs(id);

create table payslips (
  id              uuid primary key default gen_random_uuid(),
  payroll_run_id  uuid not null references payroll_runs(id),
  profile_id      uuid not null references profiles(id),
  -- frozen snapshot of the entire calculation; never recomputed after CONFIRMED
  data            jsonb not null,
  gross           numeric(12,2) not null,
  deductions      numeric(12,2) not null default 0,
  advance_cut     numeric(12,2) not null default 0,
  net             numeric(12,2) not null,
  unique (payroll_run_id, profile_id)
);

-- ---------- Audit log (append-only) ----------
create table audit_log (
  id          bigint generated always as identity primary key,
  actor       uuid,            -- auth.uid() at the time, null for system jobs
  table_name  text not null,
  row_id      text,
  action      text not null,   -- INSERT / UPDATE / DELETE
  old_data    jsonb,
  new_data    jsonb,
  at          timestamptz not null default now()
);

-- ---------- Notifications ----------
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id),
  title       text not null,
  body        text not null,
  type        text not null,   -- 'advance', 'attendance', 'payslip', ...
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index idx_notif_profile on notifications(profile_id, read);

-- ---------- Storage bucket for selfies ----------
insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', false)
on conflict (id) do nothing;
