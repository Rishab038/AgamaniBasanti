-- ============================================================
-- 0056: the duplicate-punch guard had a hole, and punches were still
-- duplicating through it.
--
-- 0054 added:
--
--   unique (profile_id, punch_kind, client_ts)
--
-- which reads as "one punch per person per kind per instant" but does
-- not mean that. In SQL a UNIQUE constraint treats NULLs as distinct
-- from each other, so two rows that are identical except for a NULL
-- punch_kind do not collide — the constraint simply does not apply to
-- them. Every punch that carries a kind was protected; every punch that
-- does not was left exactly as exposed as before.
--
-- Three groups slipped through between 4 and 7 August, all of them
-- punch_kind IS NULL. The overlapping-drain bug that produced them is
-- fixed in the app, but the app fix is not on anyone's phone yet, so
-- the database is still the only thing standing in the way.
--
-- Postgres 15 added NULLS NOT DISTINCT for exactly this, which is what
-- the constraint should have said in the first place.
-- ============================================================

-- ---------- clear what came through the hole ----------
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

-- ---------- and close it ----------
alter table attendance_app
  drop constraint if exists uq_attendance_app_punch;

alter table attendance_app
  add constraint uq_attendance_app_punch
  unique nulls not distinct (profile_id, punch_kind, client_ts);

comment on constraint uq_attendance_app_punch on attendance_app is
  'One punch per person per kind per instant. NULLS NOT DISTINCT, '
  'because a punch with no kind recorded is still the same punch and '
  'the plain form silently exempted it.';
