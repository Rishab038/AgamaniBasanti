// Credit sales — customers who took clothes on due.
//
// Recorded by whoever is on the billing counter (profiles.can_bill),
// read and settled here by the owner. Staff cannot edit an entry once
// filed, which is what makes it worth anything as a record; the owner
// is the only one who can mark money received.

import { Fragment, useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

type Sale = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  bill_no: string | null;
  bill_amount: number;
  due_amount: number;
  paid_amount: number;
  note: string | null;
  bill_path: string | null;
  settled_at: string | null;
  settled_note: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
};

type Payment = {
  id: string;
  amount: number;
  method: string | null;
  reference: string | null;
  proof_path: string | null;
  note: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
};

const METHOD_LABEL: Record<string, string> = {
  CASH: "Cash", UPI: "UPI", CARD: "Card", BANK: "Bank", OTHER: "Other",
};

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const fmtDate = (ts: string) =>
  new Date(ts).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });

/** how long the money has been outstanding */
const ageDays = (ts: string) =>
  Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);

export default function Credit() {
  const { branchId, branch } = useBranch();
  const [sales, setSales] = useState<Sale[]>([]);
  const [bills, setBills] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"open" | "settled">("open");
  const [zoom, setZoom] = useState<{ url: string; who: string } | null>(null);
  /** sale_id -> the payments taken against it, newest first */
  const [payments, setPayments] = useState<Record<string, Payment[]>>({});
  /** proof_path -> signed URL */
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!branchId) return;
    const { data, error: err } = await supabase
      .from("credit_sales")
      .select(
        "id, customer_name, customer_phone, bill_no, bill_amount, due_amount, paid_amount, note, bill_path, settled_at, settled_note, created_at, profiles!credit_sales_recorded_by_fkey(full_name)",
      )
      .eq("branch_id", branchId)
      .order("created_at", { ascending: false });
    if (err) {
      setError(err.message);
      return;
    }
    const rows = (data as unknown as Sale[]) ?? [];
    setSales(rows);

    // Bill images live in a private bucket, so each needs a signed URL.
    // Asked for in one batch; an hour is far longer than anyone spends
    // on this page.
    const paths = rows.map((s) => s.bill_path).filter(Boolean) as string[];
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage
        .from("bills").createSignedUrls(paths, 3600);
      const map: Record<string, string> = {};
      for (const s of signed ?? []) if (s.path && s.signedUrl) map[s.path] = s.signedUrl;
      setBills(map);
    } else {
      setBills({});
    }

    // Who took which instalment. Loaded with the page rather than on
    // demand — it is a small table, and the owner asking "who collected
    // this?" should not have to wait for an answer.
    const ids = rows.map((s) => s.id);
    if (ids.length > 0) {
      const { data: pays } = await supabase
        .from("credit_payments")
        .select("id, sale_id, amount, method, reference, proof_path, note, created_at, profiles!credit_payments_received_by_fkey(full_name)")
        .in("sale_id", ids)
        .order("created_at", { ascending: false });
      const byS: Record<string, Payment[]> = {};
      for (const p of (pays ?? []) as unknown as (Payment & { sale_id: string })[]) {
        (byS[p.sale_id] ??= []).push(p);
      }
      setPayments(byS);

      // Proof images live in their own private bucket; sign them in one
      // batch alongside the bills.
      const proofPaths = (pays ?? [])
        .map((p) => (p as unknown as Payment).proof_path)
        .filter(Boolean) as string[];
      if (proofPaths.length > 0) {
        const { data: signed } = await supabase.storage
          .from("payment-proofs").createSignedUrls(proofPaths, 3600);
        const map: Record<string, string> = {};
        for (const x of signed ?? []) if (x.path && x.signedUrl) map[x.path] = x.signedUrl;
        setProofs(map);
      } else {
        setProofs({});
      }
    } else {
      setPayments({});
      setProofs({});
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  // Settling goes through the payment ledger rather than flipping a
  // flag: staff payments and the owner's own "mark paid" then add up to
  // the same number, and settled_at is always a consequence of money
  // received rather than a second, disagreeing opinion.
  const settle = async (s: Sale) => {
    const balance = Number(s.due_amount) - Number(s.paid_amount);
    if (balance <= 0) return;
    setBusy(s.id);
    setError(null);
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from("credit_payments").insert({
      sale_id: s.id,
      amount: balance,
      received_by: me.user?.id,
      method: "OTHER",
      // Staff payments must carry proof; the owner is exempt because
      // they are the authority rather than a person reporting to one.
      // Stamping the reason anyway means this row never relies on that
      // exemption to be valid, and reads clearly in the history.
      reference: "Settled by owner",
      note: "Marked paid by owner",
    });
    setBusy(null);
    if (err) setError(err.message);
    else {
      setNotice(`${titleCase(s.customer_name)} marked paid — ${rupees(balance)} received.`);
      await load();
    }
  };

  // Undo removes the money, not just the label. Deleting the payments
  // lets the trigger re-open the sale, so a mistaken settle cannot
  // leave a paid-looking row with nothing behind it.
  const unsettle = async (s: Sale) => {
    setBusy(s.id);
    const { error: err } = await supabase
      .from("credit_payments").delete().eq("sale_id", s.id);
    setBusy(null);
    if (err) setError(err.message);
    else {
      setNotice(`${titleCase(s.customer_name)} moved back to still owed.`);
      await load();
    }
  };

  const q = query.trim().toLowerCase();
  const shown = sales
    .filter((s) => (tab === "open" ? !s.settled_at : !!s.settled_at))
    .filter(
      (s) =>
        !q ||
        s.customer_name.toLowerCase().includes(q) ||
        (s.customer_phone ?? "").includes(q) ||
        (s.bill_no ?? "").toLowerCase().includes(q),
    );

  const balanceOf = (s: Sale) => Number(s.due_amount) - Number(s.paid_amount);
  // what is still out on the street, not what was originally lent
  const openTotal = sales
    .filter((s) => !s.settled_at)
    .reduce((t, s) => t + balanceOf(s), 0);
  const openCount = sales.filter((s) => !s.settled_at).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Credit · {branch?.name ?? ""}</h1>
          <p>Customers who took clothes on due</p>
        </div>
        <span className="when">
          {openCount > 0
            ? `${rupees(openTotal)} owed across ${openCount} ${openCount === 1 ? "customer" : "customers"}`
            : "Nothing outstanding"}
        </span>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      <div className="card toolbar">
        <div className="toolbar-actions">
          <button
            className={`btn ${tab === "open" ? "primary" : ""}`}
            onClick={() => setTab("open")}
          >
            Still owed ({sales.filter((s) => !s.settled_at).length})
          </button>
          <button
            className={`btn ${tab === "settled" ? "primary" : ""}`}
            onClick={() => setTab("settled")}
          >
            Paid ({sales.filter((s) => s.settled_at).length})
          </button>
        </div>
        <div className="toolbar-end">
          <input
            className="note-input"
            style={{ width: 220 }}
            placeholder="Search name, phone or bill no."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Bill</th>
            <th>Owed</th>
            <th>Recorded by</th>
            <th>{tab === "open" ? "Waiting" : "Paid on"}</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-cell">
                {tab === "open"
                  ? "No one owes anything right now."
                  : "Nothing has been marked paid yet."}
              </td>
            </tr>
          )}
          {shown.map((s) => {
            const url = s.bill_path ? bills[s.bill_path] : null;
            const days = ageDays(s.created_at);
            return (
              <Fragment key={s.id}>
              <tr>
                <td>
                  <strong>{titleCase(s.customer_name)}</strong>
                  <div className="note muted">
                    {s.customer_phone ?? "no phone"}
                    {s.bill_no ? ` · bill ${s.bill_no}` : ""}
                    {s.note ? ` · ${s.note}` : ""}
                  </div>
                </td>
                <td>
                  {url ? (
                    <button
                      className="shot-btn"
                      onClick={() => setZoom({ url, who: titleCase(s.customer_name) })}
                      title="See the bill"
                    >
                      <img src={url} alt="" className="shot" />
                    </button>
                  ) : (
                    <span className="missing">—</span>
                  )}
                </td>
                <td>
                  <strong className="num">
                    {rupees(tab === "open" ? balanceOf(s) : s.due_amount)}
                  </strong>
                  {tab === "open" && Number(s.paid_amount) > 0 ? (
                    // part-paid: say what has come in, so the smaller
                    // balance does not look like a mistake
                    <div className="note paid-so-far">
                      {rupees(s.paid_amount)} paid of {rupees(s.due_amount)}
                    </div>
                  ) : (
                    Number(s.due_amount) !== Number(s.bill_amount) && (
                      <div className="note muted">bill was {rupees(s.bill_amount)}</div>
                    )
                  )}
                </td>
                <td>
                  {titleCase(s.profiles?.full_name ?? "—")}
                  {(payments[s.id] ?? []).length > 0 && (
                    <div>
                      <button
                        className="link-btn"
                        onClick={() => setOpenRow(openRow === s.id ? null : s.id)}
                      >
                        {(payments[s.id] ?? []).length} payment
                        {(payments[s.id] ?? []).length > 1 ? "s" : ""}
                        {openRow === s.id ? " ▴" : " ▾"}
                      </button>
                    </div>
                  )}
                </td>
                <td>
                  {tab === "open" ? (
                    <>
                      <span className={days >= 30 ? "pill warn" : "pill neutral"}>
                        {days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`}
                      </span>
                      <div className="note muted">since {fmtDate(s.created_at)}</div>
                    </>
                  ) : (
                    fmtDate(s.settled_at!)
                  )}
                </td>
                <td>
                  {tab === "open" ? (
                    <button
                      className="btn small good"
                      disabled={busy === s.id}
                      onClick={() => settle(s)}
                    >
                      {busy === s.id ? "…" : "Mark paid"}
                    </button>
                  ) : (
                    <button
                      className="btn small"
                      disabled={busy === s.id}
                      onClick={() => unsettle(s)}
                    >
                      Undo
                    </button>
                  )}
                </td>
              </tr>

              {openRow === s.id && (
                <tr>
                  <td colSpan={6} className="pay-history-cell">
                    <div className="pay-history">
                      {(payments[s.id] ?? []).map((p) => (
                        <div className="pay-row" key={p.id}>
                          <span className="pay-amt">{rupees(p.amount)}</span>
                          {p.method && (
                            <span className="pay-method">{METHOD_LABEL[p.method] ?? p.method}</span>
                          )}
                          <span>
                            taken by <strong>{titleCase(p.profiles?.full_name ?? "—")}</strong>
                          </span>
                          <span className="muted">{fmtDate(p.created_at)}</span>
                          {p.reference && <span className="pay-ref">{p.reference}</span>}
                          {p.proof_path && proofs[p.proof_path] && (
                            <button
                              className="shot-btn"
                              onClick={() =>
                                setZoom({
                                  url: proofs[p.proof_path!],
                                  who: `${rupees(p.amount)} from ${titleCase(s.customer_name)}`,
                                })
                              }
                              title="See the proof of payment"
                            >
                              <img src={proofs[p.proof_path]} alt="" className="shot" />
                            </button>
                          )}
                          {!p.proof_path && !p.reference && (
                            <span className="pay-noproof">no proof attached</span>
                          )}
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
        Entries are added from the app by staff you have switched on for the
        billing counter (Staff → Manage → Billing counter). Once filed, only you
        can change them.
      </p>

      {zoom && (
        <div className="shot-zoom" onClick={() => setZoom(null)} role="presentation">
          <figure onClick={(e) => e.stopPropagation()}>
            <img src={zoom.url} alt={`Bill for ${zoom.who}`} />
            <figcaption>
              {zoom.who}
              <span>Bill photo — kept until you delete it</span>
            </figcaption>
          </figure>
          <button className="btn" onClick={() => setZoom(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
