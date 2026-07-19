-- ============================================================
-- TEST DATA RESET — run in the Supabase SQL editor right before
-- the real pilot starts. Wipes every punch, payslip, advance and
-- notification while KEEPING: staff logins & profiles, branches,
-- shifts, holidays, leave policies, and registered devices.
--
-- NOT a migration — never put this in supabase/migrations.
-- Selfie photos: clear the 'selfies' bucket from Dashboard →
-- Storage (or run the cleanup-selfies function with retention 0).
-- ============================================================

begin;

delete from advance_repayments;
delete from payslips;
delete from payroll_runs;
delete from notifications;
delete from advances;
delete from leave_requests;
delete from attendance_days;
delete from device_punches;
delete from attendance_app;
delete from audit_log;

commit;

-- sanity check: everything should be 0
select
  (select count(*) from attendance_app)   as app_punches,
  (select count(*) from device_punches)   as machine_punches,
  (select count(*) from attendance_days)  as day_records,
  (select count(*) from advances)         as advances,
  (select count(*) from payslips)         as payslips;
