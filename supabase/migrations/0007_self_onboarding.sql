-- Self-onboarding: workers join with a shop code and wait for
-- owner approval.
--   approved_at NULL  + active=false  -> waiting for approval
--   approved_at set   + active=true   -> normal staff
--   approved_at set   + active=false  -> deactivated ex-staff

alter table profiles add column if not exists approved_at timestamptz default now();

-- shop joining code the owner shares with staff (changeable in Settings)
insert into app_settings (key, value)
values ('shop_join_code', to_jsonb((floor(random() * 900000) + 100000)::int::text))
on conflict (key) do nothing;

-- unapproved/deactivated accounts cannot punch in or request advances
drop policy if exists attapp_insert on attendance_app;
create policy attapp_insert on attendance_app for insert to authenticated
  with check (
    profile_id = auth.uid()
    and exists (select 1 from profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists adv_insert on advances;
create policy adv_insert on advances for insert to authenticated
  with check (
    profile_id = auth.uid()
    and status = 'PENDING'
    and exists (select 1 from profiles p where p.id = auth.uid() and p.active)
  );
