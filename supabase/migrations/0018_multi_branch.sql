-- ============================================================
-- 0018: two shops.
--
-- The schema has carried branch_id since 0001, so the data model
-- already supports this. What was single-shop was the JOINING CODE:
-- it lived in app_settings as one global value, so a self-registering
-- worker could only ever land in "the first branch".
--
-- Moving the code onto the branch makes it the routing key: the worker
-- types the code their shop gave them and is created in that shop.
-- One code per shop, unique across the business.
-- ============================================================

alter table branches
  add column if not exists join_code text;

-- carry the existing global code onto the first shop so the code
-- already shared with staff keeps working
update branches b
set join_code = (
  select (value #>> '{}') from app_settings where key = 'shop_join_code'
)
where b.join_code is null
  and b.id = (select id from branches order by created_at limit 1);

-- any other existing shop gets its own random code
update branches
set join_code = lpad((floor(random() * 900000) + 100000)::int::text, 6, '0')
where join_code is null;

alter table branches alter column join_code set not null;

create unique index if not exists idx_branch_join_code on branches(join_code);

-- app_settings.shop_join_code is now historical; branches.join_code is
-- the source of truth. Left in place so nothing that still reads it
-- breaks mid-deploy.
comment on column branches.join_code is
  'Code staff type in the app to join THIS shop. Supersedes app_settings.shop_join_code.';
