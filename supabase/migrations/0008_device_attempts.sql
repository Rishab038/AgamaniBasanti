-- Setup-day helper: when a machine contacts us with a serial that is
-- not registered, remember it. The Settings page then shows
-- "a machine with serial X is trying to connect — [Register it]",
-- which removes the guesswork when the sticker serial and the serial
-- the firmware reports don't match exactly.

create table if not exists device_attempts (
  serial      text primary key,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  hits        integer not null default 1
);

alter table device_attempts enable row level security;

-- owner reads it; only the edge function (service role) writes
create policy attempts_read on device_attempts for select to authenticated
  using (fn_is_owner());

create or replace function fn_record_device_attempt(p_serial text)
returns void
language sql security definer set search_path = public as
$$
  insert into device_attempts (serial) values (p_serial)
  on conflict (serial) do update
    set last_seen = now(), hits = device_attempts.hits + 1;
$$;
