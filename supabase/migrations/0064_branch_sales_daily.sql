-- ============================================================
-- 0064: a shop's takings, one row per day.
--
-- The dashboard's Today page wants a week of daily totals for the bar
-- chart beside the roster. Without this the browser would have to pull
-- every bill line for seven days — thousands of rows on a busy week —
-- and add them up in JavaScript, on a page that is already the heaviest
-- one the owner opens.
--
-- Returns and cancellations are excluded rather than subtracted. A line
-- that was returned did not stay sold, and the owner reading "Tuesday:
-- ₹9,400" means money that is still in the till on Tuesday night.
--
-- security_invoker so RLS on oriel_bill_lines still decides who sees
-- which shop. A worker cannot read that table at all, so this view
-- shows them nothing — which is correct; takings are the owner's.
-- ============================================================

create or replace view branch_sales_daily
with (security_invoker = on) as
select
  branch_id,
  sold_on,
  count(*)                             as lines,
  coalesce(sum(amount), 0)::numeric(14,2) as total
from oriel_bill_lines
where not is_return
  and not is_cancelled
group by branch_id, sold_on;

comment on view branch_sales_daily is
  'One row per shop per day: how many garments left and what they came '
  'to. Returns and cancellations are excluded, not netted off — the '
  'figure is meant to answer "what did today take".';

grant select on branch_sales_daily to authenticated;

-- The view groups on exactly these two columns, so the rollup is an
-- index scan rather than a sort of the whole table.
create index if not exists idx_oriel_bill_lines_branch_day
  on oriel_bill_lines (branch_id, sold_on)
  where not is_return and not is_cancelled;
