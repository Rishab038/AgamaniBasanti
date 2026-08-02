-- ============================================================
-- 0052: what each staff member sold.
--
-- The shop bills on Oriel, which prints a barcode onto every product.
-- Oriel does not record WHO made the sale, and that is the only thing
-- the owner is missing. So this is not a second till — it records
-- attribution, and nothing else. No bill number, no customer, no stock:
-- a staff member, a product, how many, and what it came to.
--
-- Two decisions worth stating, because the schema only makes sense with
-- them:
--
-- 1. The product master is SHARED BY BOTH SHOPS, keyed on the barcode
--    alone. The barcodes come off the same supplier stock, so a product
--    named once at Kanchrapara is already named at Krishnanagar. Sales
--    are branch-scoped; the dictionary they point at is not.
--
-- 2. A line remembers its own price. products.price is what to charge
--    today; sale_lines.unit_price is what was actually charged then.
--    Re-pricing an item must never silently rewrite last month's
--    figures — that is the difference between a record and a report.
--
-- Tamper model: a staff member may add their own lines and remove a
-- mistake the same day. After midnight it is the owner's to correct.
-- Every line carries who entered it, which is not always who is
-- credited with it — the owner can log on someone's behalf.
-- ============================================================

-- ---------- today, in the only timezone this shop has ----------
create or replace function fn_today_ist()
returns date language sql stable
set search_path = public, pg_temp as
$$ select (now() at time zone 'Asia/Kolkata')::date $$;

comment on function fn_today_ist() is
  'The current business day. Written out as a function so RLS policies '
  'and defaults cannot drift from each other.';

revoke all on function fn_today_ist() from public, anon;
grant execute on function fn_today_ist() to authenticated;

-- ---------- may the signed-in user log a sale at all? ----------
-- A definer function, because a policy''s own subqueries are subject to
-- RLS and profiles hides every row but your own. 0049 was this same bug.
create or replace function fn_can_log_sale()
returns boolean language sql security definer stable
set search_path = public, pg_temp as
$$ select exists (select 1 from profiles where id = auth.uid() and active) $$;

revoke all on function fn_can_log_sale() from public, anon;
grant execute on function fn_can_log_sale() to authenticated;

-- ---------- the dictionary ----------
create table if not exists products (
  id         uuid primary key default gen_random_uuid(),
  barcode    text not null,
  name       text not null,
  -- nullable on purpose: an import may arrive without prices, and
  -- "we do not know" is a truer answer than zero
  price      numeric(12,2) check (price is null or price >= 0),
  active     boolean not null default true,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_products_barcode
  on products (btrim(barcode));

comment on table products is
  'Barcode to name and price. Shared by both shops. Filled either by '
  'importing a list out of Oriel or by a staff member naming a code the '
  'first time it is scanned.';

create or replace function fn_touch_product()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_touch_product on products;
create trigger trg_touch_product before update on products
  for each row execute function fn_touch_product();

-- ---------- the record ----------
create table if not exists sale_lines (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  -- who gets the credit
  profile_id  uuid not null references profiles(id),
  product_id  uuid references products(id),
  -- kept alongside product_id so a line still says what was sold even
  -- if the dictionary entry is later merged or removed
  barcode     text not null,

  qty         integer not null default 1 check (qty > 0),
  unit_price  numeric(12,2) not null check (unit_price >= 0),
  amount      numeric(12,2) generated always as (qty * unit_price) stored,

  sold_on     date not null default fn_today_ist(),
  note        text,

  -- who typed it, which is the owner when he logs for someone else
  recorded_by uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);

comment on table sale_lines is
  'One product sold, credited to one staff member, on one day. Append '
  'and same-day-remove for staff; the owner may correct anything.';

create index if not exists idx_sale_lines_branch_day
  on sale_lines (branch_id, sold_on);
create index if not exists idx_sale_lines_staff_day
  on sale_lines (profile_id, sold_on);
create index if not exists idx_sale_lines_barcode
  on sale_lines (barcode);

-- A day that has not happened cannot have been sold on.
create or replace function fn_guard_sale_line()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
begin
  if new.sold_on > fn_today_ist() then
    raise exception 'Cannot log a sale for %, which is in the future.', new.sold_on;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sale_line on sale_lines;
create trigger trg_guard_sale_line before insert or update on sale_lines
  for each row execute function fn_guard_sale_line();

-- ---------- row level security ----------
alter table products   enable row level security;
alter table sale_lines enable row level security;

-- Anyone on the staff can read the dictionary — it is names and prices
-- of things on the shelf, and scanning is useless without it.
create policy products_read on products for select to authenticated
  using (fn_can_log_sale());

-- and name a code the first time they meet one
create policy products_insert on products for insert to authenticated
  with check (fn_can_log_sale() and created_by = auth.uid());

-- but not re-price one afterwards; that is the owner's, so a staff
-- member cannot inflate what their own past sales were worth
create policy products_owner_update on products for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

create policy products_owner_delete on products for delete to authenticated
  using (fn_is_owner());

-- Your own sales, or all of them if you run the place.
create policy sale_lines_read on sale_lines for select to authenticated
  using (fn_is_staff_admin() or profile_id = auth.uid());

-- Logged under your own name, at your own shop, for today. The owner is
-- exempt from all three so he can put right what someone forgot.
create policy sale_lines_insert on sale_lines for insert to authenticated
  with check (
    fn_is_owner()
    or (
      fn_can_log_sale()
      and profile_id  = auth.uid()
      and recorded_by = auth.uid()
      and branch_id   = fn_branch()
      and sold_on     = fn_today_ist()
    )
  );

-- Same-day only. A mistake noticed today is a mistake; a line removed
-- three weeks later is a figure being managed.
create policy sale_lines_delete on sale_lines for delete to authenticated
  using (
    fn_is_owner()
    or (profile_id = auth.uid() and sold_on = fn_today_ist())
  );

create policy sale_lines_owner_update on sale_lines for update to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- what the dashboard reads ----------
-- security_invoker so the view cannot become a way around the policies
-- above. Views run as their owner by default, which is how counter staff
-- briefly got to see both shops' customers in 0041.
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
group by l.branch_id, l.profile_id, l.sold_on;

comment on view staff_sales_daily is
  'One row per staff member per day. security_invoker, so it shows a '
  'staff member only their own row and the owner everything.';

grant select on staff_sales_daily to authenticated;
