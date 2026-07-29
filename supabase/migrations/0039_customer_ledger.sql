-- ============================================================
-- 0039: from a pile of bills to a customer's khata.
--
-- The owner keeps a paper khata: one page per person, every bill and
-- every payment on it, and a running balance at the bottom. What we
-- had was the opposite — a list of bills, each settled on its own. The
-- same customer taking goods twice appeared as two unrelated debts.
--
-- So customers become real rows, bills and payments hang off them, and
-- the balance is the customer's, not the bill's.
--
-- Advances fall out of the same idea rather than needing machinery of
-- their own: a payment with no bill attached is money received against
-- the person's account. If they owe nothing, their balance simply goes
-- negative and the shop is holding their money.
--
--     balance > 0  ->  customer owes the shop
--     balance < 0  ->  shop is holding an advance for them
--
-- Existing data is real (66 customers, ~₹23 lakh outstanding, entered
-- by the owner today), so everything here backfills rather than resets.
-- Most rows have no phone number, so identity is the name as written,
-- matched case- and space-insensitively within a shop.
-- ============================================================

create table if not exists customers (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id),
  name       text not null,
  phone      text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table customers is
  'One row per person in the shop''s credit book. Their balance is '
  'derived from credit_sales and credit_payments, never stored.';

-- The paper khata has one page per name; two pages for the same name
-- would be the bug this is meant to prevent.
create unique index if not exists uq_customer_branch_name
  on customers (branch_id, lower(btrim(name)));

create index if not exists idx_customers_phone on customers (phone);

alter table credit_sales
  add column if not exists customer_id uuid references customers(id);
alter table credit_payments
  add column if not exists customer_id uuid references customers(id);

-- The proof rule has to be relaxed to an INSERT-only check BEFORE the
-- backfill below touches existing payments: those rows predate the rule
-- and would otherwise refuse to accept a customer_id. The same
-- definition is repeated later in this file where it belongs logically;
-- re-creating it is a no-op.
create or replace function fn_guard_credit_payment()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_due  numeric(12,2);
  v_paid numeric(12,2);
begin
  if new.sale_id is not null then
    select due_amount into v_due from credit_sales where id = new.sale_id;
    if v_due is null then
      raise exception 'no such credit sale';
    end if;

    select coalesce(sum(amount), 0) into v_paid
    from credit_payments
    where sale_id = new.sale_id and id is distinct from new.id;

    if v_paid + new.amount > v_due + 0.005 then
      raise exception 'payment of % is more than the % still owed on this bill',
        new.amount, (v_due - v_paid);
    end if;
  end if;

  if TG_OP = 'INSERT'
     and not fn_is_owner()
     and coalesce(new.proof_path, '') = ''
     and coalesce(nullif(trim(new.reference), ''), '') = ''
  then
    raise exception
      'a payment needs proof: attach a screenshot or photo, or enter a reference number';
  end if;

  return new;
end;
$$;

-- ---------- backfill: every existing bill becomes a customer page ----------
insert into customers (branch_id, name, phone)
select distinct on (s.branch_id, lower(btrim(s.customer_name)))
       s.branch_id,
       btrim(s.customer_name),
       -- keep the first phone number we ever saw for this name
       (array_remove(array_agg(s.customer_phone) over (
          partition by s.branch_id, lower(btrim(s.customer_name))
        ), null))[1]
from credit_sales s
where s.customer_name is not null and btrim(s.customer_name) <> ''
on conflict (branch_id, lower(btrim(name))) do nothing;

update credit_sales s
   set customer_id = c.id
  from customers c
 where s.customer_id is null
   and c.branch_id = s.branch_id
   and lower(btrim(c.name)) = lower(btrim(s.customer_name));

update credit_payments p
   set customer_id = s.customer_id
  from credit_sales s
 where p.customer_id is null and p.sale_id = s.id;

-- ---------- a payment need not belong to a bill ----------
-- This is what makes an advance possible: money on account, before any
-- goods are taken, or spread across several old bills at once.
alter table credit_payments alter column sale_id drop not null;

alter table credit_payments
  drop constraint if exists credit_payment_target_check;
alter table credit_payments
  add constraint credit_payment_target_check
  check (sale_id is not null or customer_id is not null);

-- ---------- triggers reworked for the two shapes of payment ----------
create or replace function fn_sync_credit_sale_paid()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as
$$
declare
  v_sale uuid := coalesce(new.sale_id, old.sale_id);
  v_paid numeric(12,2);
  v_due  numeric(12,2);
begin
  -- account-level money (an advance, or a lump sum against the whole
  -- khata) belongs to no single bill, so there is nothing to sync
  if v_sale is null then
    return null;
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from credit_payments where sale_id = v_sale;

  select due_amount into v_due from credit_sales where id = v_sale;

  update credit_sales
     set paid_amount = v_paid,
         settled_at = case when v_paid >= v_due then coalesce(settled_at, now()) end,
         settled_by = case when v_paid >= v_due then settled_by end
   where id = v_sale;

  return null;
end;
$$;

create or replace function fn_guard_credit_payment()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
declare
  v_due  numeric(12,2);
  v_paid numeric(12,2);
begin
  -- Only a payment aimed at one bill has a ceiling. Money on account
  -- has none by design: paying more than is owed is exactly what an
  -- advance is.
  if new.sale_id is not null then
    select due_amount into v_due from credit_sales where id = new.sale_id;
    if v_due is null then
      raise exception 'no such credit sale';
    end if;

    select coalesce(sum(amount), 0) into v_paid
    from credit_payments
    where sale_id = new.sale_id and id is distinct from new.id;

    if v_paid + new.amount > v_due + 0.005 then
      raise exception 'payment of % is more than the % still owed on this bill',
        new.amount, (v_due - v_paid);
    end if;
  end if;

  -- Proof is a rule about DECLARING a payment, so it is checked when the
  -- row is created. Later edits are already owner-only through RLS, and
  -- re-checking here would block routine maintenance — a backfill adding
  -- customer_id to old rows must not be refused for want of a receipt
  -- that was never required when they were written.
  if TG_OP = 'INSERT'
     and not fn_is_owner()
     and coalesce(new.proof_path, '') = ''
     and coalesce(nullif(trim(new.reference), ''), '') = ''
  then
    raise exception
      'a payment needs proof: attach a screenshot or photo, or enter a reference number';
  end if;

  return new;
end;
$$;

-- keep customer_id filled in even when only sale_id is given
create or replace function fn_fill_payment_customer()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
begin
  if new.customer_id is null and new.sale_id is not null then
    select customer_id into new.customer_id from credit_sales where id = new.sale_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_payment_customer on credit_payments;
create trigger trg_fill_payment_customer
  before insert or update on credit_payments
  for each row execute function fn_fill_payment_customer();

-- ---------- the khata page, as one row per person ----------
create or replace view customer_balances as
select
  c.id,
  c.branch_id,
  c.name,
  c.phone,
  coalesce(s.bills, 0)              as bill_count,
  coalesce(s.owed, 0)               as total_owed,
  coalesce(p.received, 0)           as total_received,
  coalesce(s.owed, 0) - coalesce(p.received, 0) as balance,
  greatest(coalesce(p.received, 0) - coalesce(s.owed, 0), 0) as advance_held,
  s.last_bill_at,
  p.last_payment_at
from customers c
left join (
  select customer_id, count(*) bills, sum(due_amount) owed, max(created_at) last_bill_at
  from credit_sales where customer_id is not null group by customer_id
) s on s.customer_id = c.id
left join (
  select customer_id, sum(amount) received, max(created_at) last_payment_at
  from credit_payments where customer_id is not null group by customer_id
) p on p.customer_id = c.id;

grant select on customer_balances to authenticated;

-- ---------- row level security ----------
alter table customers enable row level security;

create policy customers_read on customers for select to authenticated
  using (
    fn_is_staff_admin()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.active and p.can_bill and p.branch_id = customers.branch_id
    )
  );

create policy customers_insert on customers for insert to authenticated
  with check (
    fn_is_owner()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.active and p.can_bill and p.branch_id = customers.branch_id
    )
  );

-- Renaming or re-phoning a customer rewrites history for every bill on
-- their page, so it stays with the owner.
create policy customers_owner_update on customers for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy customers_owner_delete on customers for delete to authenticated
  using (fn_is_owner());
