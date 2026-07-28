-- ============================================================
-- 0035: a worker's own profile updates live.
--
-- The app read the profile once per session, so anything the owner
-- changed about a person — their shift, their salary, and now their
-- billing-counter permission — did not reach them until a full
-- relaunch. Granting counter access and then telling someone to
-- reinstall the app is not a workable handover.
--
-- Safe to publish: profiles_read lets a worker SELECT only their own
-- row (id = auth.uid()), and Realtime applies the same policy before
-- delivering a change event, so nobody learns anything about anyone
-- else. Replica identity is left at the primary key — `id` is what the
-- subscription filters on, and the new row image carries every column
-- the app needs.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end$$;
