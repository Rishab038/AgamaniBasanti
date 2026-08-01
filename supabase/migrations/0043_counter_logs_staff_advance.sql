-- ============================================================
-- 0043: the counter can log an advance taken by a colleague.
--
-- Cash for advances is handed over at the billing counter, so the
-- person who actually knows an advance happened is whoever is standing
-- there — not the worker who took the money and walked off. Until now
-- only the worker could file it (adv_insert required
-- profile_id = auth.uid()), which meant the counter watched money leave
-- the till with no way to write it down.
--
-- Now a worker with the billing permission can log one for any active
-- colleague at their own shop. It is filed PENDING exactly like a
-- self-request: the owner still decides, and nothing reaches payroll
-- until they do. Logging is not approving.
--
-- recorded_by is added because "who took the money" and "who wrote it
-- down" become different people for the first time, and when the till
-- disagrees with the book that difference is the whole question.
-- ============================================================

alter table advances
  add column if not exists recorded_by uuid references profiles(id);

comment on column advances.recorded_by is
  'Who filed this advance. Same as profile_id for a self-request; the '
  'counter staff member when logged on a colleague''s behalf.';

-- Everything filed so far was somebody requesting their own.
update advances set recorded_by = profile_id where recorded_by is null;

-- Older app builds insert without this column, and a worker asking for
-- their own advance should never have to think about it. Fill it in
-- rather than making the client responsible for getting it right.
create or replace function fn_fill_advance_recorder()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
begin
  if new.recorded_by is null then
    new.recorded_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_advance_recorder on advances;
create trigger trg_fill_advance_recorder
  before insert on advances
  for each row execute function fn_fill_advance_recorder();

-- ---------- who may file one ----------
drop policy if exists adv_insert on advances;

create policy adv_insert on advances for insert to authenticated
  with check (
    status = 'PENDING'                       -- filing is never approving
    and recorded_by = auth.uid()             -- cannot file under another name
    and exists (
      select 1
      from profiles me
      join profiles target on target.id = advances.profile_id
      where me.id = auth.uid()
        and me.active
        and target.active
        and (
          -- asking for your own, as before
          target.id = me.id
          -- or the counter logging one for a colleague at the same shop
          or (me.can_bill and target.branch_id = me.branch_id
              and target.role = 'worker')
        )
    )
  );

-- ---------- who may see it ----------
-- The person who filed it needs to see it afterwards, otherwise they
-- have no way to tell a successful entry from a lost one, and would
-- file it twice.
drop policy if exists adv_read on advances;

create policy adv_read on advances for select to authenticated
  using (
    profile_id = auth.uid()
    or recorded_by = auth.uid()
    or fn_is_owner()
  );
