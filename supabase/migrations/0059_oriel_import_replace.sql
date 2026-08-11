-- ============================================================
-- 0059: re-importing a day should REPLACE it, not merge into it.
--
-- 0057 deduplicated bill lines with a unique index over
-- coalesce(bill_no,''), intending re-imports to be harmless. Two things
-- were wrong with that.
--
-- First, mechanically: ON CONFLICT cannot target an expression index, so
-- the importer could not have used it — the same trap that stopped the
-- product importer working in 0053.
--
-- Second, and worse, merging is the wrong behaviour. If a bill is
-- cancelled after Monday's file was sent, Monday's corrected file simply
-- will not contain that line — and a merge would keep the stale row for
-- ever, with nothing to indicate it was withdrawn. A day is a complete
-- statement about that day, so re-importing it replaces it.
--
-- The lines themselves now carry no uniqueness constraint at all. This
-- is deliberate: that table holds SOMEBODY ELSE'S record, and imposing
-- our expectations on it would turn a surprising-but-real file into one
-- that cannot be imported. Our own sale_lines stays strict; Oriel's data
-- is stored as given.
-- ============================================================

drop index if exists uq_oriel_line;

-- One import record per shop per day, so a re-send updates rather than
-- accumulating a pile of half-superseded batches.
delete from oriel_imports a
using oriel_imports b
where a.branch_id = b.branch_id
  and a.covers_date = b.covers_date
  and a.imported_at < b.imported_at;

alter table oriel_imports
  drop constraint if exists uq_oriel_import_day,
  add  constraint uq_oriel_import_day unique (branch_id, covers_date);

comment on constraint uq_oriel_import_day on oriel_imports is
  'One statement per shop per day. Re-importing a day replaces it, which '
  'is how a line withdrawn by a later correction actually disappears.';
