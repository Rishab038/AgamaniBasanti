// Reading a file Oriel produced, without having seen one.
//
// Everything here is a pure function so it can be tested against awkward
// samples directly, rather than by clicking through the dashboard and
// hoping. The awkward cases are not hypothetical:
//
//   * Indian ERP exports frequently use SEMICOLONS, because Excel does
//     when the system list separator is set that way. A comma-only
//     parser reads such a file as one enormous column.
//   * 11/08/2026 is the eleventh of August here and the eighth of
//     November in en-US. Date.parse() assumes the latter. Getting this
//     wrong would silently file three months of sales on the wrong days,
//     and nothing downstream would look broken.
//   * ₹1,20,000.50 groups in lakhs, not thousands, so a naive strip of
//     commas is fine but a locale-aware parse is not.

export type Sheet = { headers: string[]; rows: string[][]; delimiter: string };

/** Which separator is this file actually using? */
export function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const counts: Record<string, number> = {
    ",": 0, ";": 0, "\t": 0, "|": 0,
  };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  // the winner, defaulting to comma when the line has no separators at all
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[1]
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

/**
 * A full delimited-text reader: quoted fields, separators and newlines
 * inside quotes, and "" as an escaped quote.
 */
export function parseDelimited(raw: string, delimiter?: string): Sheet {
  const text = raw.replace(/^﻿/, "");           // strip the BOM Excel adds
  const d = delimiter ?? sniffDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field); field = "";
      // a blank line is separation, not a record
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, delimiter: d };
}

/** The identity of a report layout, stable against spacing and case. */
export function headerSignature(headers: string[]): string {
  return headers
    .map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .join("|");
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Day-first, because that is what this shop's software writes.
 * Accepts dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy and ISO yyyy-mm-dd, with an
 * optional trailing time. Returns the calendar date and, when a time was
 * present, a full timestamp fixed to IST.
 */
export function parseWhen(input: string): { date: string; at: string | null } | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  const [datePart, ...timeBits] = s.split(/[ T]+/);
  const timePart = timeBits.join(" ").trim();

  let y: number, m: number, d: number;

  const iso = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dmy = datePart.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);

  if (iso) {
    y = +iso[1]; m = +iso[2]; d = +iso[3];
  } else if (dmy) {
    d = +dmy[1]; m = +dmy[2]; y = +dmy[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else {
    return null;
  }

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = `${y}-${pad(m)}-${pad(d)}`;

  if (!timePart) return { date, at: null };

  const t = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!t) return { date, at: null };
  let hh = +t[1];
  const mm = +t[2];
  const ss = t[3] ? +t[3] : 0;
  const ampm = t[4]?.toLowerCase();
  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return { date, at: null };

  // the shop has one clock, and it is IST
  return { date, at: `${date}T${pad(hh)}:${pad(mm)}:${pad(ss)}+05:30` };
}

/** ₹1,20,000.50 / (500) / -  ->  120000.5 / -500 / null */
export function parseAmount(input: string): number | null {
  const s = (input ?? "").trim();
  if (!s || s === "-" || s === "—") return null;
  const negative = /^\(.*\)$/.test(s) || s.trimStart().startsWith("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return null;
  const n = Number(digits);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

/** Truthy in the way a spreadsheet means it. */
export function isYes(input: string): boolean {
  return /^(y|yes|true|1|r|rtn|ret|return|returned|c|cancel|cancelled|void|voided)$/i
    .test((input ?? "").trim());
}

export type Field =
  | "barcode" | "when" | "bill_no" | "item_desc"
  | "qty" | "rate" | "amount" | "is_return" | "is_cancelled";

export type Mapping = Partial<Record<Field, string>>;

/** What each of our fields tends to be called, best guess first. */
const HINTS: Record<Field, RegExp[]> = {
  barcode:      [/^bar\s*code$/i, /barcode/i, /^bar$/i, /item\s*code/i, /^code$/i],
  when:         [/bill\s*date/i, /invoice\s*date/i, /^date\s*&?\s*time$/i, /^date$/i, /trans.*date/i],
  bill_no:      [/bill\s*(no|number)/i, /invoice\s*(no|number)/i, /^doc.*no/i, /voucher/i],
  item_desc:    [/item\s*desc/i, /^description$/i, /^item(\s*name)?$/i, /product/i, /particular/i],
  qty:          [/^qty/i, /quantity/i],
  rate:         [/^rate$/i, /unit\s*price/i, /^price$/i, /^mrp$/i],
  amount:       [/net\s*amount/i, /^amount$/i, /^value$/i, /^total$/i],
  is_return:    [/return/i, /^rtn/i, /sale.*return/i],
  is_cancelled: [/cancel/i, /^void/i, /status/i],
};

/**
 * A first guess at the mapping, so the usual case is confirming rather
 * than filling in nine dropdowns. Deliberately conservative: a wrong
 * guess the owner does not notice is worse than a blank he has to answer.
 */
export function guessMapping(headers: string[]): Mapping {
  const out: Mapping = {};
  const taken = new Set<string>();
  for (const [field, patterns] of Object.entries(HINTS) as [Field, RegExp[]][]) {
    for (const re of patterns) {
      const hit = headers.find((h) => !taken.has(h) && re.test(h.trim()));
      if (hit) { out[field] = hit; taken.add(hit); break; }
    }
  }
  return out;
}

export type ParsedLine = {
  barcode: string;
  sold_on: string;
  bill_at: string | null;
  bill_no: string | null;
  item_desc: string | null;
  qty: number | null;
  rate: number | null;
  amount: number | null;
  is_return: boolean;
  is_cancelled: boolean;
  raw: Record<string, string>;
};

export type ShapeResult = { lines: ParsedLine[]; skipped: { row: number; why: string }[] };

/** Turn a mapped sheet into rows we can store, keeping the original. */
export function shapeRows(sheet: Sheet, map: Mapping): ShapeResult {
  const idx = (f: Field) => (map[f] ? sheet.headers.indexOf(map[f]!) : -1);
  const at = (r: string[], f: Field) => {
    const i = idx(f);
    return i >= 0 ? (r[i] ?? "") : "";
  };

  const lines: ParsedLine[] = [];
  const skipped: { row: number; why: string }[] = [];

  sheet.rows.forEach((r, n) => {
    const barcode = at(r, "barcode").trim();
    const when = parseWhen(at(r, "when"));

    // Only these two are required. A report missing a bill number or a
    // time is still perfectly usable; one missing a barcode or a date
    // cannot be matched to anything, so say so rather than store a
    // half-row that fails silently later.
    if (!barcode) { skipped.push({ row: n + 2, why: "no barcode" }); return; }
    if (!when)    { skipped.push({ row: n + 2, why: "no readable date" }); return; }

    const qty = parseAmount(at(r, "qty"));
    const amount = parseAmount(at(r, "amount"));

    const raw: Record<string, string> = {};
    sheet.headers.forEach((h, i) => { if (h) raw[h] = r[i] ?? ""; });

    lines.push({
      barcode,
      sold_on: when.date,
      bill_at: when.at,
      bill_no: at(r, "bill_no").trim() || null,
      item_desc: at(r, "item_desc").trim() || null,
      qty,
      rate: parseAmount(at(r, "rate")),
      amount,
      // A return shows up as an explicit flag in some reports and as a
      // negative number in others; treat both as one.
      is_return: isYes(at(r, "is_return")) || (qty ?? 0) < 0 || (amount ?? 0) < 0,
      is_cancelled: isYes(at(r, "is_cancelled")),
      raw,
    });
  });

  return { lines, skipped };
}
