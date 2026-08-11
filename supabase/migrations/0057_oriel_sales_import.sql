-- ============================================================
-- 0057: somewhere to put Oriel's own record of what was sold.
--
-- The route we are taking is Oriel's "Schedule Auto Mailing" sending a
-- Product-wise sales report every night. We do not yet know that
-- report's exact columns, so this is built to survive being surprised:
--
--   * every row keeps its ORIGINAL form in `raw`, so a column we did not
--     anticipate is captured rather than discarded, and a re-parse later
--     needs no re-export;
--   * only two fields are actually required — a barcode and a date.
--     Everything else is nullable, because a report that turns out to
--     omit the bill time should degrade, not fail;
--   * imports are batched and idempotent, so re-sending Tuesday's file
--     twice does not double Tuesday.
--
-- The two shops keep separate databases synced to head office, so a file
-- belongs to one branch and imports are per branch per day.
--
-- WHY THIS IS SIMPLER THAN PLANNED. Every barcode is one physical
-- garment. So a code appears in at most one live bill line, and matching
-- a staff member's claim to the real sale is a lookup, not a
-- reconciliation: no time window, no quantity budget, no ambiguity about
-- which unit was sold. That is why there is a view here and no matching
-- job — with a unique key on both sides, the join IS the answer and it
-- is always current.
-- ============================================================

-- ---------- one delivered file ----------
create table if not exists oriel_imports (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  -- the trading day this file reports on; how we know a claim has been
  -- checked rather than merely unmatched-so-far
  covers_date  date not null,
  source       text not null default 'EMAIL',   -- EMAIL | UPLOAD | BRIDGE
  filename     text,
  rows_ok      integer not null default 0,
  rows_skipped integer not null default 0,
  note         text,
  imported_by  uuid references profiles(id),
  imported_at  timestamptz not null default now()
);

create index if not exists idx_oriel_imports_branch_day
  on oriel_imports (branch_id, covers_date desc);

comment on table oriel_imports is
  'One row per file received from Oriel. covers_date is what lets the '
  'dashboard tell "no sale found for this scan" apart from "that day has '
  'not been imported yet" — very different messages for a staff member.';

-- ---------- what Oriel says was sold ----------
create table if not exists oriel_bill_lines (
  id           uuid primary key default gen_random_uuid(),
  import_id    uuid not null references oriel_imports(id) on delete cascade,
  branch_id    uuid not null references branches(id),

  bill_no      text,
  bill_at      timestamptz,          -- null if the report omits the time
  sold_on      date not null,

  barcode      text not null,
  item_desc    text,
  qty          numeric(12,3),
  rate         numeric(12,2),
  amount       numeric(12,2),

  -- a return and a cancellation both mean "this did not stay sold"
  is_return    boolean not null default false,
  is_cancelled boolean not null default false,

  -- the row exactly as it arrived, so an unforeseen column is kept
  raw          jsonb,

  created_at   timestamptz not null default now()
);

create index if not exists idx_oriel_lines_barcode on oriel_bill_lines (barcode);
create index if not exists idx_oriel_lines_branch_day on oriel_bill_lines (branch_id, sold_on);

-- Re-importing the same day must not double it. A bill number plus a
-- barcode identifies a line, and where the report carries no bill number
-- the barcode alone still does, because one code is one garment.
create unique index if not exists uq_oriel_line
  on oriel_bill_lines (branch_id, coalesce(bill_no, ''), barcode);

comment on table oriel_bill_lines is
  'Oriel''s own record of what left the shop. The truth a staff member''s '
  'claim is checked against; never edited by hand.';

-- ---------- who may see it ----------
alter table oriel_imports   enable row level security;
alter table oriel_bill_lines enable row level security;

create policy oriel_imports_read on oriel_imports for select to authenticated
  using (fn_is_staff_admin());
create policy oriel_imports_write on oriel_imports for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- The owner sees the whole book. A staff member sees only the lines that
-- correspond to something they themselves claimed — enough to be told
-- their own sale was confirmed, and nothing about anybody else's.
-- The subquery reads sale_lines under ITS policy, which already limits a
-- worker to their own rows, so that restriction does the work here.
create policy oriel_lines_read on oriel_bill_lines for select to authenticated
  using (
    fn_is_staff_admin()
    or exists (
      select 1 from sale_lines s
      where s.barcode = oriel_bill_lines.barcode
        and s.voided_at is null
    )
  );

create policy oriel_lines_write on oriel_bill_lines for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());

-- ---------- the answer ----------
-- Four states, and the difference between the middle two is the whole
-- point: "we checked and there was no such sale" is an accusation,
-- "tonight's file has not arrived" is not.
create or replace view sale_verification
with (security_invoker = on) as
select
  s.id,
  s.branch_id,
  s.profile_id,
  s.sold_on,
  s.barcode,
  s.unit_price,
  s.amount,
  s.voided_at,
  o.id        as oriel_line_id,
  o.bill_no,
  o.bill_at,
  o.amount    as oriel_amount,
  case
    when s.voided_at is not null                       then 'VOIDED'
    when o.id is not null and (o.is_return or o.is_cancelled)
                                                       then 'UNDONE'
    when o.id is not null                              then 'CONFIRMED'
    when not exists (
      select 1 from oriel_imports i
      where i.branch_id = s.branch_id and i.covers_date = s.sold_on
    )                                                  then 'AWAITING_IMPORT'
    else 'NOT_FOUND'
  end as state
from sale_lines s
left join oriel_bill_lines o
       on o.barcode = s.barcode
      and o.branch_id = s.branch_id;

comment on view sale_verification is
  'One staff claim against Oriel''s record of the same barcode. '
  'AWAITING_IMPORT means the day has not been delivered yet; NOT_FOUND '
  'means it has, and there was no such sale.';

grant select on sale_verification to authenticated;

-- ---------- sales nobody claimed ----------
create or replace view oriel_unclaimed
with (security_invoker = on) as
select o.*
from oriel_bill_lines o
where not o.is_return
  and not o.is_cancelled
  and not exists (
    select 1 from sale_lines s
    where s.barcode = o.barcode
      and s.branch_id = o.branch_id
      and s.voided_at is null
  );

comment on view oriel_unclaimed is
  'Real sales no staff member took credit for. Also the honest measure '
  'of whether the feature is being used at all.';

grant select on oriel_unclaimed to authenticated;
