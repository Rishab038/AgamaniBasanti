-- ============================================================
-- 0027: carry queued notifications out to phones.
--
-- fn_queue_shift_reminders writes the messages; the send-push edge
-- function delivers them through Expo. pg_net lets cron call that
-- function, so the whole chain runs server-side with nothing on the
-- phone needing to be awake.
--
-- The shared secret lives in `internal_secrets`, a table with RLS
-- enabled and NO policies: anon and authenticated can therefore never
-- read it (RLS denies by default), while cron — running as the
-- database owner — bypasses RLS. Supabase does not allow setting
-- database-level parameters, so this is the equivalent.
-- ============================================================

create extension if not exists pg_net;

create table if not exists internal_secrets (
  key   text primary key,
  value text not null
);

alter table internal_secrets enable row level security;
-- deliberately no policies: nothing reaches this through the API

revoke all on table internal_secrets from anon, authenticated;

create or replace function fn_internal_secret(p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select value from internal_secrets where key = p_key $$;

revoke all on function fn_internal_secret(text) from public, anon, authenticated;

do $$
begin
  perform cron.schedule(
    'send-push',
    '1-56/5 * * * *',
    $job$
      select net.http_post(
        url     := 'https://zhekzbooxkuosolubdjd.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object(
                     'content-type', 'application/json',
                     'x-adms-secret', fn_internal_secret('adms_shared_secret')
                   ),
        body    := '{}'::jsonb
      );
    $job$
  );
exception when others then
  raise notice 'could not schedule send-push: %', sqlerrm;
end
$$;
