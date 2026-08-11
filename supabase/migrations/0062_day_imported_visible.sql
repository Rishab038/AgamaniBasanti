-- ============================================================
-- 0062: a staff member could never be told their scan did not match.
--
-- sale_verification decides between "we have checked that day and found
-- no such sale" and "that day has not arrived yet" by asking whether an
-- oriel_imports row exists. The view is security_invoker, and
-- oriel_imports is readable only by the owner — so for a worker that
-- subquery ALWAYS returned nothing, and every unmatched claim of theirs
-- read AWAITING_IMPORT for ever.
--
-- The owner saw the truth. The person who actually did the scanning saw
-- "checking tonight" permanently, which is the one audience for whom the
-- distinction was built.
--
-- This is the same shape of bug as 0049: a policy or view subquery is
-- itself subject to RLS, so joining to a table the caller cannot read
-- silently yields no rows rather than an error. The house answer is a
-- SECURITY DEFINER function that answers one narrow question, so a
-- worker learns whether their day was imported without gaining sight of
-- the import log, its filenames, or its row counts.
-- ============================================================

create or replace function fn_day_imported(p_branch uuid, p_day date)
returns boolean language sql security definer stable
set search_path = public, pg_temp as
$$
  select exists (
    select 1 from oriel_imports
    where branch_id = p_branch and covers_date = p_day
  );
$$;

comment on function fn_day_imported(uuid, date) is
  'Has this shop-day''s sales file been brought in? Definer, so a staff '
  'member can be told their scan was checked without being shown the '
  'import log. Returns only true or false.';

revoke all on function fn_day_imported(uuid, date) from public, anon;
grant execute on function fn_day_imported(uuid, date) to authenticated;

create or replace view sale_verification
with (security_invoker = on) as
select
  s.id,
  s.branch_id,
  s.profile_id,
  s.sold_on,
  s.barcode,
  s.created_at,
  s.voided_at,
  o.id        as oriel_line_id,
  o.bill_no,
  o.bill_at,
  o.item_desc,
  o.amount    as oriel_amount,
  case
    when s.voided_at is not null                       then 'VOIDED'
    when o.id is not null and (o.is_return or o.is_cancelled)
                                                       then 'UNDONE'
    when o.id is not null                              then 'CONFIRMED'
    when not fn_day_imported(s.branch_id, s.sold_on)   then 'AWAITING_IMPORT'
    else 'NOT_FOUND'
  end as state
from sale_lines s
left join oriel_bill_lines o
       on o.barcode = s.barcode
      and o.branch_id = s.branch_id;

grant select on sale_verification to authenticated;
