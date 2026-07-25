-- Live updates in the worker app.
--
-- The owner dashboard reflects backend changes instantly because it
-- subscribes to Supabase Realtime. The worker app did not: only
-- attendance_days was ever published, and the app opened no channel at
-- all. So while the app sat open, an approved advance, a finalized day,
-- or a fresh notification never appeared until the worker fully
-- relaunched. Publish the remaining tables each tab reads live; the app
-- (see MainScreen) now opens one channel scoped to the worker.
--
-- RLS still applies to Realtime: a worker only receives change events
-- for rows their SELECT policy already lets them read (their own).

do $$
declare t text;
begin
  foreach t in array array['attendance_app', 'advances', 'notifications'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- Filtering postgres_changes by profile_id must also work on UPDATE
-- events (an advance flipping PENDING -> APPROVED, a day's status
-- changing). That match runs against the WAL row image, which by
-- default carries only the primary key. REPLICA IDENTITY FULL includes
-- every column so the profile_id filter holds on updates too. These are
-- low-volume tables, so the extra WAL is negligible.
alter table public.attendance_app  replica identity full;
alter table public.attendance_days replica identity full;
alter table public.advances        replica identity full;
alter table public.notifications   replica identity full;
