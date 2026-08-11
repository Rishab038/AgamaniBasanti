// Reading Oriel's sales report into the book.
//
// Nobody has seen this file yet, so the screen does not pretend to know
// it. Drop a file in, and it shows you its own column headings and asks
// which is the barcode and which is the date. That answer is remembered
// against a fingerprint of the heading row, so it is asked once per
// report layout and never again.
//
// Two smaller decisions worth stating:
//
//  * Only the barcode and the date are required. A report with no bill
//    number or no time is still perfectly matchable, and refusing it
//    would be us being precious about a format we do not control.
//  * Importing a day REPLACES that day. A corrected file that no longer
//    contains a cancelled bill has to be able to remove it, which a
//    merge could never do.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import {
  type Field, type Mapping, type ParsedLine, type Sheet,
  guessMapping, headerSignature, parseDelimited, shapeRows,
} from "../lib/delimited";

/** what we ask for, in the order the questions make sense */
const FIELDS: { key: Field; label: string; need: boolean; hint: string }[] = [
  { key: "barcode",      label: "Barcode",      need: true,
    hint: "the number staff scan — this is what a sale is matched on" },
  { key: "when",         label: "Bill date",    need: true,
    hint: "date, with the time too if the report has it" },
  { key: "bill_no",      label: "Bill number",  need: false, hint: "" },
  { key: "item_desc",    label: "Item name",    need: false, hint: "" },
  { key: "qty",          label: "Quantity",     need: false, hint: "" },
  { key: "rate",         label: "Rate",         need: false, hint: "" },
  { key: "amount",       label: "Amount",       need: false, hint: "" },
  { key: "is_return",    label: "Return flag",  need: false,
    hint: "leave blank if returns show as a negative amount" },
  { key: "is_cancelled", label: "Cancelled flag", need: false, hint: "" },
];

type SavedMap = { id: string; signature: string; mapping: Mapping; times_used: number };

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });

export default function OrielImport({
  onDone,
}: {
  onDone?: () => void;
}) {
  const { branchId, branch } = useBranch();
  const fileRef = useRef<HTMLInputElement>(null);

  const [filename, setFilename] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [map, setMap] = useState<Mapping>({});
  const [savedMap, setSavedMap] = useState<SavedMap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<
    { covers_date: string; rows_ok: number; rows_skipped: number; imported_at: string }[]
  >([]);

  const loadRecent = useCallback(async () => {
    if (!branchId) return;
    const { data } = await supabase
      .from("oriel_imports")
      .select("covers_date, rows_ok, rows_skipped, imported_at")
      .eq("branch_id", branchId)
      .order("covers_date", { ascending: false })
      .limit(14);
    setRecent(data ?? []);
  }, [branchId]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  /** take raw text, work out its shape, and recall how we read it last time */
  const ingest = useCallback(async (text: string, name: string | null) => {
    setError(null);
    setNotice(null);
    const parsed = parseDelimited(text);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setError("That file has no readable rows. It should have a heading row and at least one line.");
      return;
    }
    setSheet(parsed);
    setFilename(name);

    const sig = headerSignature(parsed.headers);
    const { data } = await supabase
      .from("oriel_import_maps")
      .select("id, signature, mapping, times_used")
      .eq("signature", sig)
      .maybeSingle();

    if (data) {
      setSavedMap(data as SavedMap);
      setMap((data as SavedMap).mapping);
      setNotice("This is a report layout you have imported before — the columns are already matched up.");
    } else {
      setSavedMap(null);
      setMap(guessMapping(parsed.headers));
    }
  }, []);

  const onFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name) && !/\.csv$/i.test(f.name)) {
      setError(
        `"${f.name}" is an Excel file. Open it in Excel and use File → Save As → CSV, ` +
        "then drop that in. (Excel's own format needs a reader we have not added yet.)",
      );
      return;
    }
    await ingest(await f.text(), f.name);
  };

  const shaped = useMemo(
    () => (sheet ? shapeRows(sheet, map) : null),
    [sheet, map],
  );

  /** one entry per trading day the file covers */
  const byDate = useMemo(() => {
    const m = new Map<string, ParsedLine[]>();
    for (const l of shaped?.lines ?? []) {
      if (!m.has(l.sold_on)) m.set(l.sold_on, []);
      m.get(l.sold_on)!.push(l);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shaped]);

  const ready = !!sheet && !!map.barcode && !!map.when && (shaped?.lines.length ?? 0) > 0;

  const runImport = async () => {
    if (!ready || !branchId || !sheet || !shaped) return;
    setBusy(true);
    setError(null);
    try {
      const { data: me } = await supabase.auth.getUser();
      let inserted = 0;

      for (const [date, lines] of byDate) {
        // A day is one complete statement, so replace it rather than
        // adding to it — that is how a withdrawn line disappears.
        const { data: imp, error: iErr } = await supabase
          .from("oriel_imports")
          .upsert(
            {
              branch_id: branchId,
              covers_date: date,
              source: "UPLOAD",
              filename,
              rows_ok: lines.length,
              rows_skipped: shaped.skipped.length,
              imported_by: me.user?.id ?? null,
              imported_at: new Date().toISOString(),
            },
            { onConflict: "branch_id,covers_date" },
          )
          .select("id")
          .single();
        if (iErr) throw iErr;

        await supabase.from("oriel_bill_lines")
          .delete().eq("branch_id", branchId).eq("sold_on", date);

        // chunked so a big day does not become one enormous request
        for (let i = 0; i < lines.length; i += 500) {
          const chunk = lines.slice(i, i + 500).map((l) => ({
            import_id: imp.id,
            branch_id: branchId,
            bill_no: l.bill_no,
            bill_at: l.bill_at,
            sold_on: l.sold_on,
            barcode: l.barcode,
            item_desc: l.item_desc,
            qty: l.qty,
            rate: l.rate,
            amount: l.amount,
            is_return: l.is_return,
            is_cancelled: l.is_cancelled,
            raw: l.raw,
          }));
          const { data: got, error: lErr } = await supabase
            .from("oriel_bill_lines").insert(chunk).select("id");
          if (lErr) throw lErr;
          inserted += got?.length ?? 0;
        }
      }

      // remember how this layout was read, so it is never asked again
      const sig = headerSignature(sheet.headers);
      await supabase.from("oriel_import_maps").upsert(
        {
          signature: sig,
          mapping: map,
          label: filename,
          times_used: (savedMap?.times_used ?? 0) + 1,
          created_by: me.user?.id ?? null,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "signature" },
      );

      setNotice(
        `${inserted} sale${inserted === 1 ? "" : "s"} imported across ` +
        `${byDate.length} day${byDate.length === 1 ? "" : "s"}` +
        (shaped.skipped.length ? `, ${shaped.skipped.length} row(s) skipped.` : "."),
      );
      setSheet(null);
      setFilename(null);
      if (fileRef.current) fileRef.current.value = "";
      await loadRecent();
      onDone?.();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "That import did not go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      {!sheet && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Bring in Oriel's sales report</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Export <strong>Product-wise</strong> sales from Oriel for a day, save it as
            CSV, and drop it here. The columns only need matching up the first time —
            after that a report of the same shape reads itself.
          </p>

          <div
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") fileRef.current?.click(); }}
          >
            <strong>Drop the file here</strong>
            <span className="muted">or click to choose one · CSV</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.tsv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => onFile(e.target.files?.[0])}
          />

          <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
            Or paste the rows straight from Excel:
          </p>
          <textarea
            className="bulk-input"
            rows={4}
            placeholder="Paste including the heading row"
            onPaste={(e) => {
              const t = e.clipboardData.getData("text");
              if (t.trim()) { e.preventDefault(); ingest(t, "pasted"); }
            }}
            onChange={() => {}}
          />
        </div>
      )}

      {sheet && (
        <>
          <div className="card">
            <div className="table-head" style={{ margin: 0 }}>
              <div className="table-head-text">
                <h2 style={{ margin: 0 }}>
                  Which column is which?
                </h2>
                <span className="muted">
                  {filename ?? "pasted"} · {sheet.rows.length} row
                  {sheet.rows.length === 1 ? "" : "s"} ·{" "}
                  {sheet.delimiter === "\t" ? "tab" : `"${sheet.delimiter}"`} separated
                </span>
              </div>
              <button className="btn" onClick={() => { setSheet(null); setFilename(null); }}>
                Start again
              </button>
            </div>

            <div className="map-grid">
              {FIELDS.map((f) => (
                <label key={f.key} className="toolbar-field">
                  {f.label}{f.need && <span className="req"> *</span>}
                  <select
                    value={map[f.key] ?? ""}
                    onChange={(e) =>
                      setMap({ ...map, [f.key]: e.target.value || undefined })}
                  >
                    <option value="">— not in this report —</option>
                    {sheet.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  {f.hint && <span className="field-hint">{f.hint}</span>}
                </label>
              ))}
            </div>
          </div>

          {shaped && (
            <>
              <div className="card">
                <h2 style={{ marginTop: 0 }}>What that gives us</h2>
                {!map.barcode || !map.when ? (
                  <p className="missing">
                    Choose which column holds the barcode and which holds the date —
                    without those a sale cannot be matched to anything.
                  </p>
                ) : (
                  <>
                    <p className="muted" style={{ fontSize: 13 }}>
                      {shaped.lines.length} readable row
                      {shaped.lines.length === 1 ? "" : "s"}
                      {shaped.skipped.length > 0 && (
                        <> · <span className="missing">
                          {shaped.skipped.length} skipped
                        </span></>
                      )}
                    </p>

                    <table className="pay-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Bill</th>
                          <th>Barcode</th>
                          <th>Item</th>
                          <th className="end">Amount</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {shaped.lines.slice(0, 6).map((l, i) => (
                          <tr key={i}>
                            <td className="pay-days">
                              {fmtDay(l.sold_on)}
                              {l.bill_at && (
                                <div className="note muted">
                                  {new Date(l.bill_at).toLocaleTimeString("en-IN", {
                                    hour: "numeric", minute: "2-digit",
                                    timeZone: "Asia/Kolkata",
                                  })}
                                </div>
                              )}
                            </td>
                            <td className="pay-days">{l.bill_no ?? "—"}</td>
                            <td><code>{l.barcode}</code></td>
                            <td>{l.item_desc ?? "—"}</td>
                            <td className="end pay-net">
                              {l.amount == null ? "—" : `₹${l.amount.toLocaleString("en-IN")}`}
                            </td>
                            <td>
                              {l.is_return && <span className="tag miss-some">return</span>}
                              {l.is_cancelled && <span className="tag miss-all">cancelled</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {shaped.lines.length > 6 && (
                      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                        …and {shaped.lines.length - 6} more.
                      </p>
                    )}

                    {shaped.skipped.length > 0 && (
                      <p className="hint-line muted">
                        Skipped:{" "}
                        {shaped.skipped.slice(0, 6)
                          .map((s) => `line ${s.row} (${s.why})`).join(", ")}
                        {shaped.skipped.length > 6 && ` and ${shaped.skipped.length - 6} more`}.
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="sheet-foot">
                <span className="count">
                  {byDate.length > 0 && (
                    <>
                      Covers {byDate.map(([d]) => fmtDay(d)).join(", ")} at{" "}
                      {branch?.name ?? "this shop"}.{" "}
                      <strong>Importing replaces those days.</strong>
                    </>
                  )}
                </span>
                <div className="sheet-foot-acts">
                  <button className="btn" onClick={() => setSheet(null)}>Cancel</button>
                  <button
                    className="btn primary"
                    disabled={!ready || busy}
                    onClick={runImport}
                  >
                    {busy ? "Importing…" : "Import"}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <h2>Days brought in</h2>
      {recent.length === 0 ? (
        <div className="card muted">
          Nothing imported yet for {branch?.name ?? "this shop"}.
        </div>
      ) : (
        <table className="pay-table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="mid">Sales</th>
              <th className="mid">Skipped</th>
              <th className="end">Brought in</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.covers_date}>
                <td className="pay-name">{fmtDay(r.covers_date)}</td>
                <td className="mid pay-days">{r.rows_ok}</td>
                <td className="mid pay-days">
                  {r.rows_skipped > 0
                    ? <span className="missing">{r.rows_skipped}</span>
                    : "—"}
                </td>
                <td className="end pay-days">
                  {new Date(r.imported_at).toLocaleDateString("en-IN", {
                    day: "numeric", month: "short", timeZone: "Asia/Kolkata",
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
