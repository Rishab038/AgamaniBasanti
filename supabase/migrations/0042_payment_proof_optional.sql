-- ============================================================
-- 0042: proof of payment becomes optional.
--
-- 0038 refused any staff payment without a screenshot, photo or
-- reference. The intent was sound — a payment with no evidence is a
-- claim — but at a counter it is the wrong trade: a customer hands over
-- cash, there is no screenshot to take and no reference to type, and
-- the person serving is left unable to record money they are holding.
-- A rule that blocks the truthful case is worse than no rule.
--
-- The evidence is still collected and still shown; it is simply no
-- longer a gate. The dashboard marks a payment with nothing attached, so
-- the owner can see which ones rest only on a person's word — which was
-- the real point.
--
-- Unchanged: the ceiling on a bill-linked payment, and who may record
-- one at all.
-- ============================================================

create or replace function fn_guard_credit_payment()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_due  numeric(12,2);
  v_paid numeric(12,2);
begin
  -- Only a payment aimed at one bill has a ceiling. Money on account has
  -- none by design: paying more than is owed is what an advance is.
  if new.sale_id is not null then
    select due_amount into v_due from credit_sales where id = new.sale_id;
    if v_due is null then
      raise exception 'no such credit sale';
    end if;

    select coalesce(sum(amount), 0) into v_paid
    from credit_payments
    where sale_id = new.sale_id and id is distinct from new.id;

    -- checked here rather than only in the app, so a stale screen
    -- showing an old balance cannot book the same money twice
    if v_paid + new.amount > v_due + 0.005 then
      raise exception 'payment of % is more than the % still owed on this bill',
        new.amount, (v_due - v_paid);
    end if;
  end if;

  return new;
end;
$$;
