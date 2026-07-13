-- ============================================================
-- 0002: Row Level Security — roles enforced in the database.
-- owner:      everything
-- supervisor: attendance + leave for own branch; NO salary data
-- worker:     own rows only; raw punches are insert-only
-- Tables with RLS enabled and no policy for a verb = denied.
-- ============================================================

-- ---------- Role helpers (security definer => bypass RLS on profiles) ----------
create or replace function fn_role()
returns user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create or replace function fn_branch()
returns uuid
language sql stable security definer set search_path = public as
$$ select branch_id from profiles where id = auth.uid() $$;

create or replace function fn_is_owner()
returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(fn_role() = 'owner', false) $$;

create or replace function fn_is_staff_admin()  -- owner or supervisor
returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(fn_role() in ('owner','supervisor'), false) $$;

-- ---------- Enable RLS everywhere ----------
alter table app_settings        enable row level security;
alter table branches            enable row level security;
alter table shifts              enable row level security;
alter table profiles            enable row level security;
alter table devices             enable row level security;
alter table attendance_app      enable row level security;
alter table device_punches      enable row level security;
alter table attendance_days     enable row level security;
alter table leave_policies      enable row level security;
alter table leave_requests      enable row level security;
alter table holidays            enable row level security;
alter table advances            enable row level security;
alter table advance_repayments  enable row level security;
alter table payroll_runs        enable row level security;
alter table payslips            enable row level security;
alter table audit_log           enable row level security;
alter table notifications       enable row level security;

-- ---------- app_settings: read all, write owner ----------
create policy settings_read  on app_settings for select to authenticated using (true);
create policy settings_write on app_settings for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- branches / shifts / holidays / leave_policies: read all, write owner ----------
create policy branches_read  on branches for select to authenticated using (true);
create policy branches_write on branches for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy shifts_read  on shifts for select to authenticated using (true);
create policy shifts_write on shifts for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy holidays_read  on holidays for select to authenticated using (true);
create policy holidays_write on holidays for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy leavepol_read  on leave_policies for select to authenticated using (true);
create policy leavepol_write on leave_policies for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- profiles ----------
-- workers see themselves; supervisors see their branch; owner sees all
create policy profiles_read on profiles for select to authenticated
  using (
    id = auth.uid()
    or fn_is_owner()
    or (fn_role() = 'supervisor' and branch_id = fn_branch())
  );
-- only the owner creates/edits staff (salary lives here — workers must not self-edit)
create policy profiles_write on profiles for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- devices: owner reads (heartbeat banner); writes owner only ----------
create policy devices_read  on devices for select to authenticated using (fn_is_staff_admin());
create policy devices_write on devices for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- attendance_app: insert-only for workers, no update/delete for anyone ----------
create policy attapp_insert on attendance_app for insert to authenticated
  with check (profile_id = auth.uid());
create policy attapp_read on attendance_app for select to authenticated
  using (
    profile_id = auth.uid()
    or fn_is_owner()
    or (fn_role() = 'supervisor' and branch_id = fn_branch())
  );
-- (no update/delete policies on purpose: raw punches are immutable)

-- ---------- device_punches: written only by the ADMS edge function (service role) ----------
create policy devpunch_read on device_punches for select to authenticated
  using (fn_is_staff_admin());

-- ---------- attendance_days ----------
create policy attdays_read on attendance_days for select to authenticated
  using (
    profile_id = auth.uid()
    or fn_is_owner()
    or (fn_role() = 'supervisor'
        and exists (select 1 from profiles p
                    where p.id = attendance_days.profile_id
                      and p.branch_id = fn_branch()))
  );
-- corrections (approve APP_ONLY, mark leave, etc.) — owner only; audited by trigger
create policy attdays_update on attendance_days for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());
-- inserts happen via security-definer rebuild functions, not clients

-- ---------- leave_requests ----------
create policy leave_insert on leave_requests for insert to authenticated
  with check (profile_id = auth.uid() and status = 'PENDING');
create policy leave_read on leave_requests for select to authenticated
  using (
    profile_id = auth.uid()
    or fn_is_owner()
    or (fn_role() = 'supervisor'
        and exists (select 1 from profiles p
                    where p.id = leave_requests.profile_id
                      and p.branch_id = fn_branch()))
  );
create policy leave_decide on leave_requests for update to authenticated
  using (fn_is_staff_admin()) with check (fn_is_staff_admin());

-- ---------- advances: workers request + view own; owner decides ----------
create policy adv_insert on advances for insert to authenticated
  with check (profile_id = auth.uid() and status = 'PENDING');
create policy adv_read on advances for select to authenticated
  using (profile_id = auth.uid() or fn_is_owner());
create policy adv_decide on advances for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy repay_read on advance_repayments for select to authenticated
  using (
    fn_is_owner()
    or exists (select 1 from advances a
               where a.id = advance_repayments.advance_id
                 and a.profile_id = auth.uid())
  );
create policy repay_write on advance_repayments for insert to authenticated
  with check (fn_is_owner());

-- ---------- payroll: owner runs it; workers see their own payslips ----------
create policy payrun_all on payroll_runs for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy payslip_read on payslips for select to authenticated
  using (profile_id = auth.uid() or fn_is_owner());
create policy payslip_write on payslips for insert to authenticated
  with check (fn_is_owner());

-- ---------- audit_log: owner reads; nobody writes directly (triggers only) ----------
create policy audit_read on audit_log for select to authenticated
  using (fn_is_owner());

-- ---------- notifications: own rows; mark-as-read allowed ----------
create policy notif_read on notifications for select to authenticated
  using (profile_id = auth.uid());
create policy notif_mark_read on notifications for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ============================================================
-- Storage: 'selfies' bucket.
-- Path convention: {worker_uid}/{yyyy-mm}/{timestamp}.jpg
-- Workers may INSERT into their own folder only. No client may
-- ever UPDATE or DELETE — that is the tamper-evidence guarantee
-- (cleanup runs with the service role after retention expires).
-- ============================================================
create policy selfies_worker_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy selfies_read on storage.objects for select to authenticated
  using (
    bucket_id = 'selfies'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or fn_is_staff_admin()
    )
  );
