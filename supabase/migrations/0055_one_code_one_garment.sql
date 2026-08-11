-- ============================================================
-- 0055: one barcode is one garment.
--
-- 0052 was built without knowing what a barcode meant, so it took the
-- safe reading: a code identifies a STYLE, each scan adds a unit, and
-- scanning the same label twice means two pieces sold. The client has
-- now confirmed the opposite — Oriel prints a unique code for every
-- individual piece.
--
-- That is the better answer, because it turns double-counting from
-- something we can only guess at into something the database can refuse:
--
--   * qty is always 1. A single garment cannot be sold 1.5 times, and a
--     staff member mis-typing "5" into the manual-entry box can no
--     longer inflate a day by four items.
--   * a code can be claimed once. A second scan of the same label is a
--     mistake, not quantity — whether it is the same person scanning
--     twice or two people claiming the same piece.
--
-- Returns are the one case where a code legitimately sells twice: a
-- piece comes back and goes out again weeks later. Deleting the first
-- line would free the code but destroy the record, so instead a line can
-- be voided, and uniqueness only applies to lines still standing.
-- ============================================================

-- ---------- a line that has been undone, without losing it ----------
alter table sale_lines
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references profiles(id),
  add column if not exists void_reason text;

comment on column sale_lines.voided_at is
  'Set when a sale is undone — a return, or a correction after the day '
  'closed. The row stays for the record; only live rows count and only '
  'live rows hold their barcode.';

-- ---------- one garment, one sale ----------
alter table sale_lines
  drop constraint if exists sale_lines_qty_check;

alter table sale_lines
  add constraint sale_lines_qty_check check (qty = 1);

drop index if exists uq_sale_lines_barcode_live;
create unique index uq_sale_lines_barcode_live
  on sale_lines (barcode)
  where voided_at is null;

comment on index uq_sale_lines_barcode_live is
  'Every barcode is one physical garment, so at most one live sale line '
  'may claim it. Voided lines release the code for a genuine resale.';

-- ---------- only live lines count ----------
-- The daily roll-up must not keep paying for a sale that was undone.
create or replace view staff_sales_daily
with (security_invoker = on) as
select
  l.branch_id,
  l.profile_id,
  l.sold_on,
  count(*)      as lines,
  sum(l.qty)    as items,
  sum(l.amount) as value
from sale_lines l
where l.voided_at is null
group by l.branch_id, l.profile_id, l.sold_on;

comment on view staff_sales_daily is
  'One row per staff member per day, voided lines excluded. '
  'security_invoker, so a staff member sees only their own row.';
