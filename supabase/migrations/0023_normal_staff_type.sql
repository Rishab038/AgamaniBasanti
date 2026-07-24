-- ============================================================
-- 0023: NORMAL staff type, and overtime past 26 working days.
--
-- NORMAL is paid exactly like PF/CONTRACT — monthly salary ÷ 30 per
-- day, with 4 leave days a month absorbed free — but carries no
-- provident fund and no contract terms. It is the default kind of
-- shop employee, so it becomes the fallback for anyone whose type has
-- not been set.
--
-- OVERTIME BY DAY COUNT
-- 30 paid days − 4 leave = 26 expected working days. Anything worked
-- beyond 26 in a month is extra, paid at the same per-day rate
-- (salary ÷ 30). This is separate from the existing OVERTIME
-- *decision*, which is for working a specific rostered leave day; both
-- pay one extra day, and the payslip records them separately so the
-- owner can see why.
-- ============================================================

alter type employment_type add value if not exists 'NORMAL';

insert into app_settings (key, value)
values ('standard_working_days', '26')
on conflict (key) do nothing;
