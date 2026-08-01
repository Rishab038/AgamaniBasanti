-- ============================================================
-- 0050: the owner can already correct a credit entry — RLS has allowed
-- him to update and delete both bills and payments since 0036. Two
-- things were never wired up for it, because until now nothing in the
-- dashboard actually used those permissions.
--
-- 1. Changing a bill's amount left `settled_at` frozen.
--
--    fn_sync_credit_sale_paid re-decides settled/unsettled whenever a
--    PAYMENT moves, so the two sides could never disagree — from that
--    direction. Nothing re-decided it when the DUE moved. Correct a
--    ₹10,000 bill down to ₹4,000 after ₹4,000 had been paid and it
--    stayed open forever: fully paid, still listed as owing, still
--    offered on the counter's "against which bill?" menu.
--
-- 2. Deleting a bill silently deleted its payments.
--
--    credit_payments.sale_id is ON DELETE CASCADE. Removing one wrong
--    bill would take the record of money already received with it, with
--    no warning and nothing left to reconcile against. That is exactly
--    the shape of the ₹480 gap 0040 had to repair by hand. A bill with
--    money against it now refuses to go until the payments are dealt
--    with deliberately, one at a time.
-- ============================================================

-- ---------- 1. the due changed, so re-decide settled ----------
create or replace function fn_resettle_credit_sale()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_paid numeric(12,2);
begin
  if new.due_amount is distinct from old.due_amount then
    -- read the payments rather than trust paid_amount on the row the
    -- caller handed us; this is the same source fn_sync_credit_sale_paid
    -- uses, so the two can never drift apart
    select coalesce(sum(amount), 0) into v_paid
    from credit_payments where sale_id = new.id;

    new.paid_amount := v_paid;

    if v_paid >= new.due_amount then
      new.settled_at := coalesce(new.settled_at, now());
    else
      -- the bill has been opened back up; whoever closed it no longer did
      new.settled_at := null;
      new.settled_by := null;
    end if;
  end if;
  return new;
end;
$$;

comment on function fn_resettle_credit_sale() is
  'Keeps settled_at honest when the owner corrects a bill amount. The '
  'payment side already did this; the bill side never did.';

drop trigger if exists trg_resettle_credit_sale on credit_sales;
create trigger trg_resettle_credit_sale
  before update on credit_sales
  for each row execute function fn_resettle_credit_sale();

-- ---------- 2. a bill holding payments will not quietly cascade ----------
create or replace function fn_guard_credit_sale_delete()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_n   int;
  v_sum numeric(12,2);
begin
  select count(*), coalesce(sum(amount), 0)
    into v_n, v_sum
  from credit_payments where sale_id = old.id;

  if v_n > 0 then
    raise exception
      'This bill has % payment% against it, ₹% in total. Delete those first — removing the bill would erase the record of money already received.',
      v_n, case when v_n = 1 then '' else 's' end, v_sum
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

comment on function fn_guard_credit_sale_delete() is
  'Refuses to let a bill take its receipts down with it via the '
  'ON DELETE CASCADE on credit_payments.sale_id.';

drop trigger if exists trg_guard_credit_sale_delete on credit_sales;
create trigger trg_guard_credit_sale_delete
  before delete on credit_sales
  for each row execute function fn_guard_credit_sale_delete();

-- ---------- repair anything already in the wrong state ----------
-- Nothing should be, since no bill amount has ever been edited, but the
-- check costs one scan of a table with 67 rows in it.
update credit_sales s
   set settled_at = case
         when p.paid >= s.due_amount then coalesce(s.settled_at, now())
         else null end,
       settled_by = case
         when p.paid >= s.due_amount then s.settled_by
         else null end,
       paid_amount = p.paid
  from (
    select s2.id, coalesce(sum(cp.amount), 0) as paid
    from credit_sales s2
    left join credit_payments cp on cp.sale_id = s2.id
    group by s2.id
  ) p
 where p.id = s.id
   and (s.paid_amount is distinct from p.paid
        or (p.paid >= s.due_amount) is distinct from (s.settled_at is not null));
