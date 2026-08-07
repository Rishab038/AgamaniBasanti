-- ============================================================
-- 0054: the same punch was being recorded several times.
--
-- Staff saw their Today list repeat "Checked in 10:55 am" four times
-- over, and 31 surplus rows had built up across 8 people since 31 July.
--
-- It was never a double tap. Every duplicate group shares a client_ts
-- to the MILLISECOND, and a finger cannot do that. The app writes each
-- punch to a local SQLite queue and then calls drain() to push it up —
-- and drain() is called from three places with nothing serialising
-- them: once on mount, once on every return to the foreground, and once
-- straight after each check-in. Two overlapping runs each read the same
-- undeleted queue rows and each inserted them.
--
-- The client fix is a lock, but a lock only protects the client that
-- has it. This constraint is what makes the rule true of the data: the
-- same person cannot punch the same way at the same instant twice.
-- An app retrying a punch already on the server now gets a duplicate-key
-- error, which is the honest answer, and can safely drop it.
--
-- Payroll was not affected — every touched day still resolved to the
-- same verdict, because the day is built from the first and last punch
-- rather than a count of them. This is a cleanliness and
-- trust-in-the-record fix, not a money fix.
-- ============================================================

-- ---------- 1. clear the surplus, oldest arrival wins ----------
with ranked as (
  select id,
         row_number() over (
           partition by profile_id, punch_kind, client_ts
           order by server_ts, id
         ) as rn
  from attendance_app
)
delete from attendance_app a
using ranked r
where a.id = r.id
  and r.rn > 1;

-- ---------- 2. and stop it coming back ----------
alter table attendance_app
  drop constraint if exists uq_attendance_app_punch,
  add  constraint uq_attendance_app_punch
       unique (profile_id, punch_kind, client_ts);

comment on constraint uq_attendance_app_punch on attendance_app is
  'One punch per person per kind per instant. Makes a re-sent queue row '
  'fail loudly instead of duplicating silently.';
