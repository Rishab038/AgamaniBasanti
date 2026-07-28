-- ============================================================
-- 0033: check-in photos come back, on a two-day clock.
--
-- The photo was removed earlier because the fingerprint machine already
-- proved physical presence, so it added a privacy burden for nothing.
-- It returns for a different job: the GPS radius is not always
-- trustworthy (poor fix indoors, a tight 30 m fence, a phone that
-- reports a stale location), and when the fence is in doubt the owner
-- needs something better than a coordinate to settle it.
--
-- That question is asked within a day or two, so the image is kept for
-- exactly that long. The SHA-256 and every punch detail remain in
-- attendance_app permanently, so deleting the picture never erases the
-- record that a punch happened.
--
-- The value was left at -40 from a one-off manual sweep. Anything below
-- 1 is refused by the edge function now, but it should not be sitting in
-- the table looking like policy either.
-- ============================================================

update app_settings set value = '2' where key = 'selfie_retention_days';

insert into app_settings (key, value) values ('selfie_retention_days', '2')
on conflict (key) do nothing;

comment on column attendance_app.selfie_path is
  'Storage path of the check-in photo. Deleted after '
  'app_settings.selfie_retention_days (2); the row and selfie_sha256 '
  'outlive it, so a missing file is expected, not a fault.';

-- Nothing ever scheduled the cleanup, which is why 234 images from the
-- previous experiment were still sitting in the bucket. With a two-day
-- window an unscheduled sweep is not an untidy detail, it is the whole
-- policy failing silently, so the job is created here rather than left
-- to be wired up by hand.
select cron.unschedule('cleanup-selfies')
where exists (select 1 from cron.job where jobname = 'cleanup-selfies');

select cron.schedule(
  'cleanup-selfies',
  '20 20 * * *',                       -- 01:50 IST, after the nightly finalize
  $job$
  select net.http_post(
    url     := 'https://zhekzbooxkuosolubdjd.supabase.co/functions/v1/cleanup-selfies',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-adms-secret', (select value from internal_secrets where key = 'adms_shared_secret')
               ),
    body    := '{}'::jsonb
  )
  $job$
);
