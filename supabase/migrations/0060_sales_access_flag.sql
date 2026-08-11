-- ============================================================
-- 0060: a switch, so the sales tab can be tried before it is trusted.
--
-- The feature has never carried a single real row. Turning it on for all
-- 94 staff at once to find out whether it works would mean discovering
-- any problem at the worst possible scale, with people's own figures
-- attached to it.
--
-- So it ships dark. The owner switches it on for two or three people,
-- they scan real garments for a few days, and when it holds up he
-- switches on the rest — no second app build required.
--
-- This is the pattern `can_bill` already established for the credit
-- book, and it works for the same reason: the app hides the tab, and the
-- database independently refuses the write. Someone who got past the
-- first still cannot get past the second.
-- ============================================================

alter table profiles
  add column if not exists can_log_sales boolean not null default false;

comment on column profiles.can_log_sales is
  'May this person record what they sold? Off by default so the feature '
  'can be proven on a few phones before it reaches ninety-four.';

-- fn_can_log_sale already gated on "active"; now it gates on permission
-- too. It backs both the sale_lines insert policy and the products
-- insert policy, so a person without the flag can neither claim a sale
-- nor invent a product to claim.
create or replace function fn_can_log_sale()
returns boolean language sql security definer stable
set search_path = public, pg_temp as
$$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and can_log_sales
  );
$$;

comment on function fn_can_log_sale() is
  'May the signed-in user record a sale? Definer, because a policy''s own '
  'subqueries are subject to RLS and profiles hides every row but your '
  'own — the trap that made 0049 necessary.';
