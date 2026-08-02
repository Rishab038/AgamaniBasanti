// Who sold what.
//
// Oriel knows the shop's takings; it does not know whose hands the sale
// passed through. That is the whole of this page: a date range, and the
// staff of one shop ranked by what they moved through it.
//
// A name opens out into the individual items rather than navigating
// away, because the question after "who sold the most" is almost always
// "what did they sell", and losing the ranking to find out is a poor
// trade.
//
// The second tab is the dictionary the app scans against. It can be
// filled by pasting an export out of Oriel, or it fills itself as staff
// name codes at the counter — whichever the shop ends up able to do.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

type StaffRow = {
  profile_id: string;
  name: string;
  lines: number;
  items: number;
  value: number;
};

type Line = {
  id: string;
  profile_id: string;
  barcode: string;
  qty: number;
  unit_price: number;
  amount: number;
  sold_on: string;
  note: string | null;
  created_at: string;
  products: { name: string } | null;
};

type Product = {
  id: string;
  barcode: string;
  name: string;
  price: number | null;
  active: boolean;
  created_at: string;
};

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric", month: "short",
  });

export default function Sales() {
  const { branchId, branch } = useBranch();
  const [view, setView] = useState<"staff" | "products">("staff");

  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(istToday());

  const [rows, setRows] = useState<StaffRow[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [pQuery, setPQuery] = useState("");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ p: Product; name: string; price: string } | null>(null);

  const loadSales = useCallback(async () => {
    if (!branchId) return;
    // The lines themselves, once: small enough for the range the owner
    // actually looks at, and the same rows answer both the ranking and
    // the drill-down without a second round trip.
    const [{ data: ls, error: lErr }, { data: staff }] = await Promise.all([
      supabase
        .from("sale_lines")
        .select("id, profile_id, barcode, qty, unit_price, amount, sold_on, note, created_at, products(name)")
        .eq("branch_id", branchId)
        .gte("sold_on", from)
        .lte("sold_on", to)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("branch_id", branchId),
    ]);
    if (lErr) { setError(lErr.message); return; }

    const names = new Map<string, string>();
    for (const s of (staff as { id: string; full_name: string }[]) ?? []) {
      names.set(s.id, s.full_name);
    }

    const all = (ls as unknown as Line[]) ?? [];
    setLines(all);

    const by = new Map<string, StaffRow>();
    for (const l of all) {
      if (!by.has(l.profile_id)) {
        by.set(l.profile_id, {
          profile_id: l.profile_id,
          name: names.get(l.profile_id) ?? "Someone no longer on the staff",
          lines: 0, items: 0, value: 0,
        });
      }
      const r = by.get(l.profile_id)!;
      r.lines += 1;
      r.items += l.qty;
      r.value += Number(l.amount);
    }
    setRows([...by.values()].sort((a, b) => b.value - a.value));
  }, [branchId, from, to]);

  const loadProducts = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("products")
      .select("id, barcode, name, price, active, created_at")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (err) { setError(err.message); return; }
    setProducts((data as Product[]) ?? []);
  }, []);

  useEffect(() => { loadSales(); }, [loadSales]);
  useEffect(() => { if (view === "products") loadProducts(); }, [view, loadProducts]);

  const totals = rows.reduce(
    (t, r) => ({ items: t.items + r.items, value: t.value + r.value }),
    { items: 0, value: 0 },
  );

  const shownProducts = useMemo(() => {
    const q = pQuery.trim().toLowerCase();
    if (!q) return products.slice(0, 300);
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || p.barcode.includes(q))
      .slice(0, 300);
  }, [products, pQuery]);

  /** paste an Oriel export: barcode, name, price — one item per line */
  const runImport = async () => {
    const parsed: { barcode: string; name: string; price: number | null }[] = [];
    const bad: string[] = [];

    for (const raw of importText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // comma or tab, so a CSV and a spreadsheet paste both work
      const cells = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ""));
      const [barcode, name, price] = cells;
      if (!barcode || !name) { bad.push(line); continue; }
      // a header row names its columns rather than describing an item
      if (/^barcode$/i.test(barcode)) continue;
      const n = price === undefined || price === "" ? null : Number(price.replace(/[^0-9.]/g, ""));
      parsed.push({ barcode, name, price: n != null && isFinite(n) ? n : null });
    }

    if (parsed.length === 0) {
      setError("Nothing to import. One item per line: barcode, name, price.");
      return;
    }

    setBusy(true);
    setError(null);
    // An upsert is an insert as far as RLS is concerned, and
    // products_insert demands created_by = auth.uid()
    const { data: me } = await supabase.auth.getUser();
    const { data, error: err } = await supabase
      .from("products")
      .upsert(
        parsed.map((p) => ({ ...p, created_by: me.user?.id ?? null })),
        { onConflict: "barcode", ignoreDuplicates: false },
      )
      .select("id");
    setBusy(false);

    if (err) { setError(err.message); return; }
    setImportText("");
    setNotice(
      `${data?.length ?? 0} item${data?.length === 1 ? "" : "s"} imported.` +
      (bad.length ? ` ${bad.length} line${bad.length === 1 ? "" : "s"} skipped — no barcode or no name.` : ""),
    );
    await loadProducts();
  };

  const saveProduct = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setError("An item needs a name."); return; }
    setBusy(true);
    const { data, error: err } = await supabase
      .from("products")
      .update({ name, price: editing.price === "" ? null : Number(editing.price) })
      .eq("id", editing.p.id)
      .select("id");
    setBusy(false);
    if (err) { setError(err.message); return; }
    if (!data || data.length === 0) { setError("Nothing was changed — this is not yours to edit."); return; }
    setEditing(null);
    await loadProducts();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales · {branch?.name ?? ""}</h1>
          <p>What each person sold</p>
        </div>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      <div className="khata-tabs">
        <button
          className={`khata-tab${view === "staff" ? " on" : ""}`}
          onClick={() => setView("staff")}
        >
          By staff
        </button>
        <button
          className={`khata-tab${view === "products" ? " on" : ""}`}
          onClick={() => setView("products")}
        >
          Products
        </button>
      </div>

      {view === "staff" ? (
        <>
          <div className="card toolbar">
            <label className="toolbar-field">
              From
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="toolbar-field">
              To
              <input type="date" value={to} min={from} max={istToday()}
                     onChange={(e) => setTo(e.target.value)} />
            </label>
            <div className="toolbar-actions">
              <button className="btn" onClick={() => { setFrom(istToday()); setTo(istToday()); }}>
                Today
              </button>
              <button className="btn" onClick={() => { setFrom(daysAgo(6)); setTo(istToday()); }}>
                Last 7 days
              </button>
              <button className="btn" onClick={() => { setFrom(daysAgo(29)); setTo(istToday()); }}>
                Last 30 days
              </button>
            </div>
            <div className="toolbar-end">
              <span className="toolbar-count">
                {totals.items} item{totals.items === 1 ? "" : "s"} · {rupees(totals.value)}
              </span>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Staff</th>
                <th className="right">Items</th>
                <th className="right">Value</th>
                <th className="right">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    Nothing logged in these dates.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const isOpen = open === r.profile_id;
                const share = totals.value > 0 ? (r.value / totals.value) * 100 : 0;
                return (
                  <Fragment key={r.profile_id}>
                    <tr
                      className={`day-row${isOpen ? " open" : ""}`}
                      onClick={() => setOpen(isOpen ? null : r.profile_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpen(isOpen ? null : r.profile_id);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isOpen}
                    >
                      <td>
                        <span className="day-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                        {titleCase(r.name)}
                        <div className="note muted">
                          {r.lines} entr{r.lines === 1 ? "y" : "ies"}
                        </div>
                      </td>
                      <td className="right">{r.items}</td>
                      <td className="right"><span className="led-out">{rupees(r.value)}</span></td>
                      <td className="right">
                        <span className="muted">{share.toFixed(0)}%</span>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="day-detail">
                        <td colSpan={4}>
                          <div className="dt-list">
                            {lines.filter((l) => l.profile_id === r.profile_id).map((l) => (
                              <div className="dt" key={l.id}>
                                <span className="dt-time">{fmtDay(l.sold_on)}</span>
                                <span className="dt-who">{l.products?.name ?? "Unnamed code"}</span>
                                <span className="dt-detail muted">
                                  {l.barcode}
                                  {l.qty > 1 ? ` · ${l.qty} × ${rupees(l.unit_price)}` : ""}
                                  {l.note ? ` · ${l.note}` : ""}
                                </span>
                                <span className="dt-amt">
                                  <span className="led-out">{rupees(Number(l.amount))}</span>
                                </span>
                                <span className="dt-staff muted" />
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <p className="hint-line muted">
            Staff scan each item as it leaves the counter, so this is what they
            recorded — not what Oriel billed. A line can be removed by whoever
            logged it on the day itself, and by you at any time.
          </p>
        </>
      ) : (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Import from Oriel</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              Export the item list out of Oriel and paste it here — one item per
              line, as <code>barcode, name, price</code>. A comma or a tab both
              work, so a spreadsheet copy pastes straight in. Re-importing
              updates the items already here rather than duplicating them.
            </p>
            <textarea
              className="bulk-input"
              rows={7}
              placeholder={"8901234567890, Cotton saree red, 1200\n8901234567891, Silk kurta blue, 2450"}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button
              className="btn primary"
              disabled={busy || !importText.trim()}
              onClick={runImport}
            >
              {busy ? "Importing…" : "Import"}
            </button>
          </div>

          <div className="card toolbar">
            <div className="toolbar-end">
              <input
                className="note-input"
                style={{ width: 240 }}
                placeholder="Search name or barcode"
                value={pQuery}
                onChange={(e) => setPQuery(e.target.value)}
              />
            </div>
            <span className="toolbar-count">
              {products.length} item{products.length === 1 ? "" : "s"} in the list
            </span>
          </div>

          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Barcode</th>
                <th className="right">Price</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shownProducts.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    {pQuery
                      ? "Nothing matches that."
                      : "No products yet. Import a list, or let staff name codes as they scan them."}
                  </td>
                </tr>
              )}
              {shownProducts.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button className="name-link" onClick={() => setEditing({
                      p, name: p.name, price: p.price == null ? "" : String(p.price),
                    })}>
                      {p.name}
                    </button>
                  </td>
                  <td><code>{p.barcode}</code></td>
                  <td className="right">
                    {p.price == null
                      ? <span className="missing">not priced</span>
                      : rupees(p.price)}
                  </td>
                  <td className="right">
                    <button
                      className="btn small"
                      onClick={() => setEditing({
                        p, name: p.name, price: p.price == null ? "" : String(p.price),
                      })}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="hint-line muted">
            A price here is what the app fills in on the next scan. It never
            changes what a past sale was worth — every line keeps the price it
            was sold at.
          </p>
        </>
      )}

      {editing && (
        <div className="shot-zoom" onClick={() => !busy && setEditing(null)} role="presentation">
          <div className="entry-card edit-entry" onClick={(e) => e.stopPropagation()}>
            <h3>Edit item</h3>
            <p className="muted"><code>{editing.p.barcode}</code></p>
            <label>
              Name
              <input
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label>
              Price (₹)
              <input
                type="text"
                inputMode="numeric"
                placeholder="not priced"
                value={editing.price}
                onChange={(e) => setEditing({
                  ...editing,
                  price: e.target.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, ""),
                })}
              />
            </label>
            <div className="entry-acts">
              <button className="btn primary" disabled={busy} onClick={saveProduct}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button className="btn" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
