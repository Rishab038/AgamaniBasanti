// ============================================================
// The nightly sales report, arriving by itself.
//
// Oriel emails its Product-wise report to sales@agamanibasantifashion.com.
// A Cloudflare Email Worker takes the attachment off the message and
// POSTs it here. This function stores the raw text, works out whether it
// recognises the layout, and if it does, imports the day.
//
// Two decisions shape everything below.
//
// 1. STORE FIRST, PARSE SECOND. Nobody is watching at 10pm. The failure
//    that actually hurts is not a crash — it is a file we could not read
//    being dropped silently, leaving the owner believing sales were
//    checked when they were not. So the text lands in oriel_inbound
//    whatever happens, and an unreadable layout becomes a PENDING_MAP
//    row the dashboard can show, not an error nobody sees.
//
// 2. A DAY IS REPLACED, NOT MERGED. If a bill is cancelled after
//    Monday's file was sent, Monday's corrected file simply will not
//    contain that line. Merging would keep the stale row for ever.
//
// Security: x-oriel-secret must match ORIEL_INBOUND_SECRET. The sender
// address is recorded but deliberately not trusted as authentication —
// from headers are trivially forged, and the secret is the real gate.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SHARED_SECRET = Deno.env.get("ORIEL_INBOUND_SECRET") ?? "";

// ---------- reading a delimited file ----------
// Deliberately a copy of apps/admin/src/lib/delimited.ts rather than a
// shared package: that one runs in a browser bundle and this one in
// Deno, and the 49 tests that pin its behaviour live with the original.
// If one changes, change both — the header of each says so.

function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (const ch of first) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

function parseDelimited(raw: string) {
  const text = raw.replace(/^﻿/, "");
  const d = sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows };
}

const headerSignature = (headers: string[]) =>
  headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean).join("|");

const pad = (n: number) => String(n).padStart(2, "0");

/** Day-first, because that is what this shop's software writes. */
function parseWhen(input: string): { date: string; at: string | null } | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const [datePart, ...rest] = s.split(/[ T]+/);
  const timePart = rest.join(" ").trim();

  let y: number, m: number, d: number;
  const iso = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dmy = datePart.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) {
    d = +dmy[1]; m = +dmy[2]; y = +dmy[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = `${y}-${pad(m)}-${pad(d)}`;
  if (!timePart) return { date, at: null };

  const t = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!t) return { date, at: null };
  let hh = +t[1];
  const mm = +t[2], ss = t[3] ? +t[3] : 0;
  const ap = t[4]?.toLowerCase();
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return { date, at: null };
  return { date, at: `${date}T${pad(hh)}:${pad(mm)}:${pad(ss)}+05:30` };
}

function parseAmount(input: string): number | null {
  const s = (input ?? "").trim();
  if (!s || s === "-" || s === "—") return null;
  const neg = /^\(.*\)$/.test(s) || s.trimStart().startsWith("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return null;
  const n = Number(digits);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const isYes = (v: string) =>
  /^(y|yes|true|1|r|rtn|ret|return|returned|c|cancel|cancelled|void|voided)$/i
    .test((v ?? "").trim());

// ---------- the door ----------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("POST only", { status: 405 });
  }
  if (!SHARED_SECRET || req.headers.get("x-oriel-secret") !== SHARED_SECRET) {
    return new Response("no", { status: 401 });
  }

  let payload: {
    filename?: string; from?: string; to?: string; subject?: string;
    text?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const text = (payload.text ?? "").trim();

  // Which shop. The two shops keep separate databases, so each sends its
  // own report — and the reliable way to tell them apart is the address
  // it was sent TO, not the subject line. Each branch gets its own
  // address (sales-krishnanagar@, sales-kanchrapara@), so a mail routed
  // to one cannot be filed against the other.
  //
  // Subject and filename are searched only as a fallback, and if neither
  // names a shop the file is parked rather than guessed at: a day filed
  // against the wrong branch is worse than a day not filed at all.
  const { data: branches } = await supabase.from("branches").select("id, name");
  const recipient = (payload.to ?? "").toLowerCase();
  const hay = `${payload.subject ?? ""} ${payload.filename ?? ""}`.toLowerCase();
  const key = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 7);

  let branch = (branches ?? []).find((b) => recipient.includes(key(b.name)))
            ?? (branches ?? []).find((b) => hay.includes(key(b.name)));
  if (!branch && (branches?.length ?? 0) === 1) branch = branches![0];

  // Land the raw file first, whatever happens next.
  const { data: inbound, error: inErr } = await supabase
    .from("oriel_inbound")
    .insert({
      from_addr: payload.from ?? null,
      subject: payload.subject ?? null,
      filename: payload.filename ?? null,
      body_text: text,
      branch_id: branch?.id ?? null,
      status: "PENDING_MAP",
    })
    .select("id")
    .single();
  if (inErr) {
    return new Response(JSON.stringify({ error: inErr.message }), { status: 500 });
  }

  const fail = async (note: string, status = "UNREADABLE") => {
    await supabase.from("oriel_inbound").update({ status, note }).eq("id", inbound.id);
    return new Response(JSON.stringify({ ok: false, note }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  if (!text) return await fail("the message had no readable attachment");
  if (!branch) {
    return await fail(
      "could not tell which shop this is for — send it to sales-krishnanagar@ or sales-kanchrapara@",
      "PENDING_MAP",
    );
  }

  const sheet = parseDelimited(text);
  if (sheet.headers.length === 0 || sheet.rows.length === 0) {
    return await fail("no heading row, or no rows under it");
  }

  const signature = headerSignature(sheet.headers);
  const { data: mapRow } = await supabase
    .from("oriel_import_maps")
    .select("id, mapping, times_used")
    .eq("signature", signature)
    .maybeSingle();

  await supabase.from("oriel_inbound").update({ signature }).eq("id", inbound.id);

  if (!mapRow) {
    return await fail(
      "this report layout has not been matched up yet — open it on the dashboard once",
      "PENDING_MAP",
    );
  }

  // ---------- shape it ----------
  const map = mapRow.mapping as Record<string, string>;
  const idx = (f: string) => (map[f] ? sheet.headers.indexOf(map[f]) : -1);
  const at = (r: string[], f: string) => { const i = idx(f); return i >= 0 ? (r[i] ?? "") : ""; };

  const lines: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const r of sheet.rows) {
    const barcode = at(r, "barcode").trim();
    const when = parseWhen(at(r, "when"));
    if (!barcode || !when) { skipped++; continue; }

    const qty = parseAmount(at(r, "qty"));
    const amount = parseAmount(at(r, "amount"));
    const raw: Record<string, string> = {};
    sheet.headers.forEach((h, i) => { if (h) raw[h] = r[i] ?? ""; });

    lines.push({
      branch_id: branch.id,
      bill_no: at(r, "bill_no").trim() || null,
      bill_at: when.at,
      sold_on: when.date,
      barcode,
      item_desc: at(r, "item_desc").trim() || null,
      qty,
      rate: parseAmount(at(r, "rate")),
      amount,
      is_return: isYes(at(r, "is_return")) || (qty ?? 0) < 0 || (amount ?? 0) < 0,
      is_cancelled: isYes(at(r, "is_cancelled")),
      raw,
    });
  }

  if (lines.length === 0) return await fail("no row had both a barcode and a readable date");

  // ---------- import, one day at a time ----------
  const days = [...new Set(lines.map((l) => l.sold_on as string))].sort();
  let inserted = 0;

  for (const day of days) {
    const forDay = lines.filter((l) => l.sold_on === day);

    const { data: imp, error: impErr } = await supabase
      .from("oriel_imports")
      .upsert({
        branch_id: branch.id,
        covers_date: day,
        source: "EMAIL",
        filename: payload.filename ?? null,
        rows_ok: forDay.length,
        rows_skipped: skipped,
        imported_at: new Date().toISOString(),
      }, { onConflict: "branch_id,covers_date" })
      .select("id")
      .single();
    if (impErr) return await fail(`could not record the day: ${impErr.message}`);

    // a day is one complete statement about that day
    await supabase.from("oriel_bill_lines")
      .delete().eq("branch_id", branch.id).eq("sold_on", day);

    for (let i = 0; i < forDay.length; i += 500) {
      const chunk = forDay.slice(i, i + 500).map((l) => ({ ...l, import_id: imp.id }));
      const { data: got, error: lErr } = await supabase
        .from("oriel_bill_lines").insert(chunk).select("id");
      if (lErr) return await fail(`could not store the sales: ${lErr.message}`);
      inserted += got?.length ?? 0;
    }
  }

  await supabase.from("oriel_import_maps")
    .update({ times_used: (mapRow.times_used ?? 0) + 1, last_used_at: new Date().toISOString() })
    .eq("id", mapRow.id);

  await supabase.from("oriel_inbound").update({
    status: "IMPORTED",
    rows_ok: inserted,
    rows_skipped: skipped,
    note: `${inserted} sales across ${days.length} day(s) at ${branch.name}`,
  }).eq("id", inbound.id);

  return new Response(JSON.stringify({
    ok: true, branch: branch.name, days, inserted, skipped,
  }), { headers: { "content-type": "application/json" } });
});
