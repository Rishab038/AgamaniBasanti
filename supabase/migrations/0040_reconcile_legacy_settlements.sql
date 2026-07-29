-- ============================================================
-- 0040: give the old settlements a payment row to stand on.
--
-- Before the payment ledger existed, "mark paid" flipped a flag and
-- 0036 backfilled paid_amount to match. Those bills therefore show as
-- paid while having no payment behind them — harmless while the bill
-- was the unit of truth, wrong now that the customer's balance is
-- derived from payments. Prabir ghosh's ₹480 read as settled on the
-- bill and still outstanding on his khata at the same time.
--
-- This invents no money: it writes the exact difference already
-- recorded in paid_amount, attributed to whoever settled it, and marked
-- as migrated so it is never mistaken for cash someone handed over.
-- ============================================================

insert into credit_payments (sale_id, customer_id, amount, received_by, method, reference, note, created_at)
select
  s.id,
  s.customer_id,
  s.paid_amount - coalesce(p.paid, 0),
  coalesce(
    s.settled_by,
    (select id from profiles where role = 'owner' order by created_at limit 1)
  ),
  'OTHER',
  'Migrated from earlier record',
  'Created by migration 0040 so the customer ledger matches a bill that '
    || 'was marked paid before payments were recorded individually.',
  coalesce(s.settled_at, s.updated_at, now())
from credit_sales s
left join (
  select sale_id, sum(amount) paid from credit_payments
  where sale_id is not null group by sale_id
) p on p.sale_id = s.id
where s.paid_amount > coalesce(p.paid, 0)
  and s.paid_amount - coalesce(p.paid, 0) > 0.005
  and s.customer_id is not null;
