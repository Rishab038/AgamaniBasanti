-- ============================================================
-- 0049: counter staff could never actually file a colleague's advance.
--
-- 0043 gave them the permission, and the policy looked right:
--
--   exists (select 1 from profiles me
--           join profiles target on target.id = advances.profile_id
--           where me.id = auth.uid() and ... me.can_bill
--             and target.branch_id = me.branch_id)
--
-- The catch is that the subquery reads `profiles`, and a policy's own
-- subqueries are subject to RLS too. profiles_read limits a worker to
-- `id = auth.uid()`, so the join to `target` — a DIFFERENT person's row
-- — matched nothing. exists was always false and every insert was
-- refused, with the generic "violates row-level security policy".
--
-- Reading your own row works, which is why every other credit policy
-- was fine: this is the only one that has to look at somebody else.
--
-- Fixed the same way the colleague picker was (0044): a SECURITY
-- DEFINER function does the lookup, so it sees the rows it needs while
-- still answering only one narrow question and leaking nothing.
-- ============================================================

create or replace function fn_can_log_advance_for(p_target uuid)
returns boolean
language sql security definer
stable
set search_path = public, pg_temp as
$$
  select exists (
    select 1
    from profiles me, profiles target
    where me.id = auth.uid()
      and target.id = p_target
      and me.active
      and target.active
      and (
        -- your own request, exactly as before
        target.id = me.id
        -- or the counter filing for a colleague at the same shop
        or (me.can_bill and target.role = 'worker'
            and target.branch_id = me.branch_id)
        -- the owner may file for anyone at their shops
        or me.role = 'owner'
      )
  );
$$;

comment on function fn_can_log_advance_for(uuid) is
  'May the signed-in user file an advance for this person? Runs as '
  'definer because the check has to read a colleague''s profile row, '
  'which RLS otherwise hides. Returns only true/false.';

revoke all on function fn_can_log_advance_for(uuid) from public, anon;
grant execute on function fn_can_log_advance_for(uuid) to authenticated;

drop policy if exists adv_insert on advances;

create policy adv_insert on advances for insert to authenticated
  with check (
    status = 'PENDING'                    -- filing is never approving
    and recorded_by = auth.uid()          -- cannot file under another name
    and fn_can_log_advance_for(profile_id)
  );
