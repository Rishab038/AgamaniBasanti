-- ============================================================
-- 0044: let the counter see who works at their shop — names only.
--
-- 0043 gave counter staff the right to file an advance for a colleague,
-- but no way to name one: profiles_read limits a worker to their own
-- row, so the picker had nothing to show. The permission was real and
-- the feature was still unusable.
--
-- The obvious fix — widening profiles_read to the whole branch — is the
-- wrong one. That table holds base_salary and the PF components, so it
-- would hand every counter worker their colleagues' pay. RLS is
-- row-level: allowing the row allows every column on it.
--
-- So the names come through a function that returns exactly two fields
-- and nothing else, scoped to the caller's own branch. Same reasoning
-- as fn_record_consent (0012) and fn_set_push_token (0031).
-- ============================================================

create or replace function fn_branch_colleagues()
returns table (id uuid, full_name text)
language sql security definer
set search_path = public, pg_temp as
$$
  select p.id, p.full_name
  from profiles p
  join profiles me on me.id = auth.uid()
  where p.active
    and p.role = 'worker'
    and p.branch_id = me.branch_id
    and p.id <> me.id                 -- you are not your own colleague
    and me.active
    -- only the counter needs this, and only for filing an advance
    and (me.can_bill or me.role = 'owner')
  order by p.full_name;
$$;

comment on function fn_branch_colleagues() is
  'Names of active workers at the caller''s branch, for the billing '
  'counter to pick when logging an advance. Deliberately returns only '
  'id and full_name — never salary, phone or anything else on profiles.';

revoke all on function fn_branch_colleagues() from public, anon;
grant execute on function fn_branch_colleagues() to authenticated;
