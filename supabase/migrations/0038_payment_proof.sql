-- ============================================================
-- 0038: evidence behind a payment.
--
-- A payment row said only "someone says ₹500 came in". Against cash
-- that is a claim, not a record, and it is the one place in this system
-- where a person can quietly write off money they kept.
--
-- So a payment now carries how it was paid and something to check it
-- against: a UPI/bank reference, or a picture — a transaction
-- screenshot from the phone's gallery, or a photo of the signed
-- receipt. Enforced in the database, not just the form.
--
-- The owner is exempt: when they mark a debt paid they are the
-- authority, not a person reporting to one. Their rows are stamped
-- with their own id either way.
-- ============================================================

alter table credit_payments
  add column if not exists method       text,
  add column if not exists reference    text,
  add column if not exists proof_path   text,
  add column if not exists proof_sha256 text;

comment on column credit_payments.method is
  'CASH | UPI | CARD | BANK | OTHER — how the money arrived.';
comment on column credit_payments.reference is
  'UPI transaction id, cheque number, last digits of a card — whatever '
  'can be matched against the shop account later.';
comment on column credit_payments.proof_path is
  'Object in the payment-proofs bucket: a transaction screenshot or a '
  'photo of the receipt. Kept as long as the sale.';

alter table credit_payments
  drop constraint if exists credit_payments_method_check;
alter table credit_payments
  add constraint credit_payments_method_check
  check (method is null or method in ('CASH', 'UPI', 'CARD', 'BANK', 'OTHER'));

-- ---------- require proof from staff ----------
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

  -- A stale screen showing an old balance must not be able to book the
  -- same money twice, so the ceiling is checked here and not only in
  -- the app.
  if v_paid + new.amount > v_due + 0.005 then
    raise exception 'payment of % is more than the % still owed',
      new.amount, (v_due - v_paid);
  end if;

  -- Staff must show something. The owner settling a debt is the
  -- authority on it and needs no receipt from themselves.
  if not fn_is_owner()
     and coalesce(new.proof_path, '') = ''
     and coalesce(nullif(trim(new.reference), ''), '') = ''
  then
    raise exception
      'a payment needs proof: attach a screenshot or photo, or enter a reference number';
  end if;

  return new;
end;
$$;

-- ---------- where the pictures live ----------
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', false)
on conflict (id) do nothing;

-- Path convention: payment-proofs/{branch_id}/{yyyy-mm}/{timestamp}.jpg
-- Insert-only for staff, same as every other evidence bucket here: the
-- person who uploads it can never replace or remove it afterwards.
drop policy if exists payment_proof_insert on storage.objects;
create policy payment_proof_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.active and (p.can_bill or fn_is_owner())
    )
  );

drop policy if exists payment_proof_read on storage.objects;
create policy payment_proof_read on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      fn_is_staff_admin()
      or exists (
        select 1
        from credit_payments cp
        join credit_sales s on s.id = cp.sale_id
        join profiles p on p.id = auth.uid()
        where cp.proof_path = storage.objects.name
          and (
            cp.received_by = auth.uid()
            or (p.active and p.can_bill and p.branch_id = s.branch_id)
          )
      )
    )
  );
