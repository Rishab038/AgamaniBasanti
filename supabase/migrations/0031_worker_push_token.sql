-- ============================================================
-- 0031: let a worker register their own push token.
--
-- Shift reminders were being generated correctly (64 queued) and
-- send-push was running every 5 minutes and returning 200 — but always
-- {"sent":0}, because not one worker had a push_token. The app does
--
--     supabase.from("profiles").update({ push_token }).eq("id", ...)
--
-- and the only UPDATE policy on profiles is profiles_write, which
-- requires fn_is_owner(). For a worker that matches no rows, so the
-- update silently affected nothing — PostgREST reports success, and
-- push.ts swallows failures by design. No token, no notification.
--
-- Same reasoning as 0012 (consent): RLS cannot restrict which COLUMNS
-- a user may write, and a policy permissive enough to let a worker set
-- push_token would also let them edit their own base_salary. So the
-- write goes through a SECURITY DEFINER function that touches exactly
-- one column on exactly one row — the caller's own.
-- ============================================================

create or replace function fn_set_push_token(p_token text)
returns void
language plpgsql security definer
set search_path = public, pg_temp as
$$
begin
  -- Expo tokens look like ExponentPushToken[xxxxxxxx]; reject anything
  -- else so a bad value can never reach the Expo push API.
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'invalid push token';
  end if;

  update profiles
     set push_token = p_token
   where id = auth.uid()
     and push_token is distinct from p_token;   -- no-op write when unchanged
end;
$$;

revoke all on function fn_set_push_token(text) from public;
grant execute on function fn_set_push_token(text) to authenticated;
