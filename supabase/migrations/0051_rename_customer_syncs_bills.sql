-- ============================================================
-- 0051: a customer's name lives in two places, and only one of them
-- was ever going to be corrected.
--
-- customers.name is the record. credit_sales also carries its own
-- customer_name / customer_phone, written at the counter when the bill
-- was made — useful, because a bill can be filed before anyone decides
-- which existing customer it belongs to, and one bill in the book has
-- no customer_id at all.
--
-- Nothing kept the two in step. The customer page and the two totals
-- read customers.name; the day-by-day list reads the bill's own copy.
-- Rename someone and the same person would appear under the new name in
-- one place and the old name in the other, with no way to tell which was
-- current. The copy now follows the record.
--
-- Deliberately not the other way round: editing one bill must not
-- rename the person on every other bill. That is why the dashboard
-- writes to customers when the entry has one, and only falls back to
-- the bill's own fields when it does not.
-- ============================================================

create or replace function fn_sync_sale_customer_name()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
begin
  if new.name is distinct from old.name
     or new.phone is distinct from old.phone then
    update credit_sales
       set customer_name  = new.name,
           customer_phone = new.phone
     where customer_id = new.id
       and (customer_name is distinct from new.name
            or customer_phone is distinct from new.phone);
  end if;
  return new;
end;
$$;

comment on function fn_sync_sale_customer_name() is
  'Carries a renamed customer down onto the bills that copied the old '
  'name at the counter, so the day list and the customer page can never '
  'show the same person under two names.';

drop trigger if exists trg_sync_sale_customer_name on customers;
create trigger trg_sync_sale_customer_name
  after update on customers
  for each row execute function fn_sync_sale_customer_name();

-- Straighten out anything that already disagrees. Nothing does today —
-- no name has ever been edited — so this is a no-op that documents which
-- side wins if it ever comes up again.
update credit_sales s
   set customer_name  = c.name,
       customer_phone = c.phone
  from customers c
 where c.id = s.customer_id
   and (s.customer_name is distinct from c.name
        or s.customer_phone is distinct from c.phone);
