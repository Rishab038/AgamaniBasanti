-- ============================================================
-- 0063: every file that arrives by email is kept, whether or not we
-- could read it.
--
-- The nightly report will arrive unattended, which means nobody is
-- watching when it goes wrong. The failure that matters is not a crash —
-- it is silence: a layout we do not recognise, an empty attachment, a
-- sender we did not expect. Any of those, dropped quietly, would leave
-- the owner believing sales were being checked when they were not.
--
-- So the raw text lands here first and is only then parsed. A file whose
-- columns we cannot map is not an error, it is a PENDING_MAP row waiting
-- for one screen of answers. And because the original is kept, mapping
-- it later needs no re-send from Oriel.
-- ============================================================

create table if not exists oriel_inbound (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),

  from_addr    text,
  subject      text,
  filename     text,
  -- the attachment exactly as it arrived
  body_text    text not null,
  -- fingerprint of the heading row, so a known layout maps itself
  signature    text,

  branch_id    uuid references branches(id),
  status       text not null default 'PENDING_MAP',
                 -- PENDING_MAP | IMPORTED | UNREADABLE
  rows_ok      integer not null default 0,
  rows_skipped integer not null default 0,
  note         text
);

create index if not exists idx_oriel_inbound_status
  on oriel_inbound (status, received_at desc);

comment on table oriel_inbound is
  'Raw arrivals from the nightly email. Kept regardless of outcome, '
  'because the dangerous failure for an unattended job is the silent '
  'one — a file nobody could read looks exactly like no file at all.';

alter table oriel_inbound enable row level security;

create policy oriel_inbound_read on oriel_inbound for select to authenticated
  using (fn_is_staff_admin());
create policy oriel_inbound_write on oriel_inbound for all to authenticated
  using (fn_is_owner()) with check (fn_is_owner());
