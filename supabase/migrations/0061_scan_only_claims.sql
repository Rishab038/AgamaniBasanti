-- ============================================================
-- 0061: a scan is a claim on a barcode, and nothing else.
--
-- Until now a staff member scanning an unknown code was asked to type a
-- name and a price before the sale would save. That was built when we
-- thought the app had to know what a product WAS. It does not — Oriel
-- already knows. The barcode is the only thing the staff member has that
-- Oriel lacks a link to, so the barcode is the only thing worth asking
-- for.
--
-- What that buys, in order of how much it matters:
--
--   * Staff type nothing. Ever. Point, scan, done — which is the whole
--     difference between a feature people use on a busy Saturday and one
--     they abandon.
--   * No product list to preload. The item name and the amount come from
--     the matched bill line, so they are Oriel's figures rather than a
--     staff member's recollection of them.
--   * A staff member can no longer influence what their own sale was
--     worth, because they never state it. The value of a confirmed sale
--     is whatever the bill says.
--
-- unit_price therefore becomes optional and, in practice, always null.
-- It is kept rather than dropped because the generated `amount` column
-- depends on it, and because a future manual-entry path for a torn label
-- might legitimately carry one. Neither is read for money any more:
-- staff_sales_daily below now counts what Oriel confirmed, not what
-- anybody claimed.
-- ============================================================

alter table sale_lines
  alter column unit_price drop not null;

comment on column sale_lines.unit_price is
  'Vestigial. Staff no longer state a price — the value of a sale is the '
  'matched bill line''s amount. Kept because `amount` is generated from it.';

-- ---------- what a day was actually worth ----------
-- Rebuilt to report Oriel's figures rather than the claim's. A claim
-- with no matching bill line contributes nothing to value, which is the
-- point: unverified is not the same as earned.
--
-- Dropped rather than replaced: the columns are renamed, and CREATE OR
-- REPLACE VIEW can add columns but never rename one.
drop view if exists staff_sales_daily;

create view staff_sales_daily
with (security_invoker = on) as
select
  s.branch_id,
  s.profile_id,
  s.sold_on,
  count(*)                                            as claimed,
  count(o.id) filter (where not o.is_return and not o.is_cancelled)
                                                      as confirmed,
  coalesce(sum(o.amount) filter (
    where not o.is_return and not o.is_cancelled), 0)  as value
from sale_lines s
left join oriel_bill_lines o
       on o.barcode = s.barcode
      and o.branch_id = s.branch_id
where s.voided_at is null
group by s.branch_id, s.profile_id, s.sold_on;

comment on view staff_sales_daily is
  'Per staff member per day: how many garments they claimed, how many '
  'Oriel confirmed, and what the confirmed ones came to. Value is always '
  'Oriel''s number — a claim nobody billed is worth nothing.';

-- ---------- carry the item through to the screens ----------
-- The app shows a staff member what they scanned; without the name from
-- the bill line it could only show them a barcode, which tells them
-- nothing about whether the right thing was recorded.
drop view if exists sale_verification;

create view sale_verification
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
    when not exists (
      select 1 from oriel_imports i
      where i.branch_id = s.branch_id and i.covers_date = s.sold_on
    )                                                  then 'AWAITING_IMPORT'
    else 'NOT_FOUND'
  end as state
from sale_lines s
left join oriel_bill_lines o
       on o.barcode = s.barcode
      and o.branch_id = s.branch_id;

comment on view sale_verification is
  'One staff claim against Oriel''s record of the same barcode, carrying '
  'the item name and amount from the bill. AWAITING_IMPORT means the day '
  'has not arrived yet; NOT_FOUND means it has, and there was no sale.';

grant select on sale_verification to authenticated;
grant select on staff_sales_daily to authenticated;
