-- ============================================================
-- 0036: taking payment against a credit sale.
--
-- Counter staff can now accept money owed, not just record the debt.
--
-- Payments are their own rows rather than an edit to the sale. A debt
-- is rarely cleared in one go — ₹500 today, ₹1,500 next week is normal
-- — and each of those is a separate act by a named person handling
-- cash. Overwriting a single "amount paid" field would lose who took
-- what and when, which is exactly what you want when the money and the
-- till disagree.
--
-- credit_sales.paid_amount is kept in step by a trigger so the
-- dashboard can sort and total without aggregating on every read, and
-- settled_at follows from it: a sale is settled when it is paid off,
-- never as a separate opinion.
-- ============================================================

alter table credit_sales
  add column if not exists paid_amount numeric(12,2) not null default 0;

comment on column credit_sales.paid_amount is
  'Sum of credit_payments for this sale, maintained by trigger. '
  'Balance still owed is due_amount - paid_amount.';

create table if not exists credit_payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references credit_sales(id) on delete cascade,
  amount       numeric(12,2) not null check (amount > 0),
  received_by  uuid not null references profiles(id),
  note         text,
  created_at   timestamptz not null default now()
);

comment on table credit_payments is
  'Money received against a credit sale. Append-only for staff; only '
  'the owner can correct a mistake by deleting a row.';

create index if not exists idx_credit_payments_sale
  on credit_payments (sale_id, created_at);

-- ---------- keep the sale in step ----------
create or replace function fn_sync_credit_sale_paid()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_sale uuid := coalesce(new.sale_id, old.sale_id);
  v_paid numeric(12,2);
  v_due  numeric(12,2);
begin
  select coalesce(sum(amount), 0) into v_paid
  from credit_payments where sale_id = v_sale;

  select due_amount into v_due from credit_sales where id = v_sale;

  update credit_sales
     set paid_amount = v_paid,
         -- Settled follows the money. Re-opening happens by itself if a
         -- wrong payment is deleted, so the two can never disagree.
         settled_at = case when v_paid >= v_due then coalesce(settled_at, now()) end,
         settled_by = case when v_paid >= v_due then settled_by end
   where id = v_sale;

  return null;
end;
$$;

drop trigger if exists trg_sync_credit_paid on credit_payments;
create trigger trg_sync_credit_paid
  after insert or update or delete on credit_payments
  for each row execute function fn_sync_credit_sale_paid();

-- ---------- row level security ----------
alter table credit_payments enable row level security;

-- Same permission as recording the sale, and the same branch: whoever
-- is on the counter can take money for that shop. recorded under their
-- own name, and never for more than is still owed.
create policy credit_payment_insert on credit_payments for insert to authenticated
  with check (
    received_by = auth.uid()
    and exists (
      select 1
      from credit_sales s
      join profiles p on p.id = auth.uid()
      where s.id = credit_payments.sale_id
        and p.active
        and (p.can_bill or fn_is_owner())
        and (p.branch_id = s.branch_id or fn_is_owner())
    )
  );

create policy credit_payment_read on credit_payments for select to authenticated
  using (
    fn_is_staff_admin()
    or received_by = auth.uid()
    or exists (
      select 1 from credit_sales s
      where s.id = credit_payments.sale_id and s.recorded_by = auth.uid()
    )
  );

-- Correcting a payment is the owner's job. Staff cannot unwind money
-- they have already declared received — that is the point of the record.
create policy credit_payment_owner_update on credit_payments for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy credit_payment_owner_delete on credit_payments for delete to authenticated
  using (fn_is_owner());

-- ---------- refuse overpayment at the source ----------
-- Checked in the database rather than only in the app: a stale screen
-- showing an old balance must not be able to book money twice.
create or replace function fn_guard_credit_payment()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_due  numeric(12,2);
  v_paid numeric(12,2);
begin
  select due_amount into v_due from credit_sales where id = new.sale_id;
  if v_due is null then
    raise exception 'no such credit sale';
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from credit_payments
  where sale_id = new.sale_id and id is distinct from new.id;

  if v_paid + new.amount > v_due + 0.005 then
    raise exception 'payment of % is more than the % still owed',
      new.amount, (v_due - v_paid);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_credit_payment on credit_payments;
create trigger trg_guard_credit_payment
  before insert or update on credit_payments
  for each row execute function fn_guard_credit_payment();

-- ---------- backfill ----------
-- Anything the owner already marked paid by hand stays paid: give it a
-- paid_amount matching its due so the new balance maths agrees with
-- what the dashboard has been showing.
update credit_sales
   set paid_amount = due_amount
 where settled_at is not null and paid_amount = 0;
