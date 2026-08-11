-- ============================================================
-- 0058: remember how to read Oriel's report.
--
-- We are building against a file nobody has seen yet, so the column
-- names are unknowable today. Guessing them would be the wrong shape of
-- solution: it would work until Oriel renamed a heading, then fail
-- silently and blame the data.
--
-- Instead the format is DISCOVERED once. The first file is shown to the
-- owner with its own headings, he says which one is the barcode and
-- which is the date, and that answer is kept against a fingerprint of
-- the heading row. Every later file with the same headings maps itself.
-- A changed report is not a bug — it is one screen of re-answering.
-- ============================================================

create table if not exists oriel_import_maps (
  id          uuid primary key default gen_random_uuid(),
  -- the heading row, normalised and joined: identity of a report layout
  signature   text not null unique,
  -- our field name -> their column heading
  mapping     jsonb not null,
  label       text,
  times_used  integer not null default 0,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table oriel_import_maps is
  'How to read one layout of Oriel report. Keyed on a fingerprint of the '
  'heading row, so recognising a familiar file needs no naming or '
  'choosing by the person importing it.';

alter table oriel_import_maps enable row level security;

create policy oriel_maps_read on oriel_import_maps for select to authenticated
  using (fn_is_staff_admin());
create policy oriel_maps_write on oriel_import_maps for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());
