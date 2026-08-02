-- ============================================================
-- 0053: the product import could never have run.
--
-- 0052 spelled the uniqueness rule as an expression index:
--
--   create unique index uq_products_barcode on products (btrim(barcode))
--
-- which does enforce the rule — a padded code collides with a trimmed
-- one, and that was tested. What it cannot do is satisfy
-- `on conflict (barcode)`, because Postgres matches ON CONFLICT against
-- a constraint or index on exactly those columns, and btrim(barcode) is
-- not barcode. Pasting an Oriel export would have failed on the first
-- row with `42P10: there is no unique or exclusion constraint matching
-- the ON CONFLICT specification`, which tells the owner nothing.
--
-- Trimming now happens on the way in instead, so the stored value is
-- already canonical and a plain unique constraint says the same thing
-- in a form the importer can actually use. Same rule, one layer earlier.
-- ============================================================

create or replace function fn_normalise_barcode()
returns trigger language plpgsql
set search_path = public, pg_temp as
$$
begin
  new.barcode := btrim(new.barcode);
  if new.barcode = '' then
    raise exception 'A barcode cannot be blank.';
  end if;
  return new;
end;
$$;

comment on function fn_normalise_barcode() is
  'Trims a barcode before it is stored, so uniqueness can be a plain '
  'constraint that ON CONFLICT can target.';

drop trigger if exists trg_normalise_product_barcode on products;
create trigger trg_normalise_product_barcode
  before insert or update on products
  for each row execute function fn_normalise_barcode();

drop trigger if exists trg_normalise_line_barcode on sale_lines;
create trigger trg_normalise_line_barcode
  before insert or update on sale_lines
  for each row execute function fn_normalise_barcode();

-- straighten out anything already stored padded, before the constraint
update products   set barcode = btrim(barcode) where barcode <> btrim(barcode);
update sale_lines set barcode = btrim(barcode) where barcode <> btrim(barcode);

drop index if exists uq_products_barcode;

alter table products
  drop constraint if exists uq_products_barcode,
  add  constraint uq_products_barcode unique (barcode);
