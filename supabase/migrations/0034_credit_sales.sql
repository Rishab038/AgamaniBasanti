-- ============================================================
-- 0034: credit sales (goods taken on due) recorded at the counter.
--
-- The counter staff records the customer, the amount owed and a photo
-- of the bill; the owner reads them on the dashboard and marks them
-- settled when the money comes in.
--
-- Who may do it is a per-person permission the owner grants and can
-- withdraw (profiles.can_bill), not a role and not a fixed employee —
-- whoever is on the counter today. profiles is already owner-only for
-- UPDATE, so the flag cannot be granted by the person who benefits
-- from it.
--
-- This is money owed to the shop, so unlike attendance photos nothing
-- here expires: the bill image is the evidence behind the debt and is
-- kept until the owner deletes it deliberately.
-- ============================================================

alter table profiles
  add column if not exists can_bill boolean not null default false;

comment on column profiles.can_bill is
  'Owner-granted permission to record credit sales at the billing '
  'counter. Revocable at any time; only the owner can set it.';

create table if not exists credit_sales (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  recorded_by    uuid not null references profiles(id),

  customer_name  text not null,
  customer_phone text,
  bill_no        text,
  bill_amount    numeric(12,2) not null check (bill_amount >= 0),
  due_amount     numeric(12,2) not null check (due_amount >= 0),
  note           text,

  bill_path      text,          -- storage object in the 'bills' bucket
  bill_sha256    text,          -- outlives the image, proves it was not swapped

  settled_at     timestamptz,
  settled_by     uuid references profiles(id),
  settled_note   text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table credit_sales is
  'Customers who took goods on credit. due_amount is what is still '
  'owed; settled_at is set by the owner when it is paid.';

create index if not exists idx_credit_branch_open
  on credit_sales (branch_id, settled_at, created_at desc);
create index if not exists idx_credit_phone
  on credit_sales (customer_phone);

-- keep updated_at honest without the client having to remember
create or replace function fn_touch_credit_sale()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_credit_sale on credit_sales;
create trigger trg_touch_credit_sale
  before update on credit_sales
  for each row execute function fn_touch_credit_sale();

-- ---------- row level security ----------
alter table credit_sales enable row level security;

-- The counter staff may add a sale, but only: with the permission, in
-- their own shop, and stamped with their own identity. Without the
-- recorded_by check a permitted worker could file an entry under
-- someone else's name.
create policy credit_insert on credit_sales for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.active
        and p.can_bill
        and p.branch_id = credit_sales.branch_id
    )
  );

-- Owner and supervisor see every sale; a counter worker sees only what
-- they themselves recorded — enough to check their own work, not a
-- window onto the shop's whole debtor book.
create policy credit_read on credit_sales for select to authenticated
  using (fn_is_staff_admin() or recorded_by = auth.uid());

-- Settling a debt is the owner's call alone. Staff cannot edit an entry
-- after filing it, which is what makes the record worth anything.
create policy credit_owner_update on credit_sales for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy credit_owner_delete on credit_sales for delete to authenticated
  using (fn_is_owner());

-- ---------- bill images ----------
insert into storage.buckets (id, name, public)
values ('bills', 'bills', false)
on conflict (id) do nothing;

-- Path convention: bills/{branch_id}/{yyyy-mm}/{timestamp}.jpg
-- Same tamper-evidence rule as attendance photos: whoever uploads can
-- never overwrite or remove it afterwards.
create policy bills_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'bills'
    and exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.active and p.can_bill
    )
  );

create policy bills_read on storage.objects for select to authenticated
  using (
    bucket_id = 'bills'
    and (
      fn_is_staff_admin()
      or exists (
        select 1 from credit_sales c
        where c.bill_path = storage.objects.name and c.recorded_by = auth.uid()
      )
    )
  );

-- ---------- what the owner actually looks at ----------
create or replace view credit_outstanding as
select
  c.branch_id,
  count(*) filter (where c.settled_at is null)              as open_count,
  coalesce(sum(c.due_amount) filter (where c.settled_at is null), 0) as open_amount,
  coalesce(sum(c.due_amount) filter (
    where c.settled_at >= date_trunc('month', now() at time zone 'Asia/Kolkata')
  ), 0)                                                     as settled_this_month
from credit_sales c
group by c.branch_id;

grant select on credit_outstanding to authenticated;
