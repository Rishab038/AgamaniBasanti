// One customer's khata page.
//
// The paper original is a single column of dated lines — goods out on
// one side, money in on the other, and a running total down the edge so
// the answer to "what does he owe today?" never has to be computed. That
// is reproduced here rather than reinvented: entries newest first,
// because a returning customer is asking about the recent end, with the
// balance carried alongside each line.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { titleCase } from "../lib/text";

type Customer = {
  id: string;
  branch_id: string;
  name: string;
  phone: string | null;
  bill_count: number;
  total_owed: number;
  total_received: number;
  balance: number;
};

type Entry = {
  id: string;
  kind: "BILL" | "PAYMENT";
  at: string;
  amount: number;
  detail: string;
  who: string;
  image: string | null;
  /** a payment with neither a picture nor a reference behind it */
  unevidenced: boolean;
  /** what the customer owed immediately after this line */
  running: number;
};

const rupees = (n: number) => `₹${Math.abs(Number(n)).toLocaleString("en-IN")}`;
const fmtDate = (ts: string) =>
  new Date(ts).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });
const fmtTime = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", {
    hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  });

const METHOD_LABEL: Record<string, string> = {
  CASH: "Cash", UPI: "UPI", CARD: "Card", BANK: "Bank", OTHER: "Other",
};

export default function CreditCustomer() {
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [zoom, setZoom] = useState<{ url: string; caption: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [money, setMoney] = useState<{ amount: string; sale: string } | null>(null);
  const [openSales, setOpenSales] = useState<{ id: string; label: string }[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    const [{ data: c, error: cErr }, { data: s }, { data: p }] = await Promise.all([
      supabase.from("customer_balances").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("credit_sales")
        .select("id, bill_no, bill_amount, due_amount, paid_amount, note, bill_path, settled_at, created_at, profiles!credit_sales_recorded_by_fkey(full_name)")
        .eq("customer_id", id)
        .order("created_at"),
      supabase
        .from("credit_payments")
        .select("id, sale_id, amount, method, reference, proof_path, note, created_at, profiles!credit_payments_received_by_fkey(full_name)")
        .eq("customer_id", id)
        .order("created_at"),
    ]);
    if (cErr) { setError(cErr.message); return; }
    setCustomer(c as Customer | null);

    type S = {
      id: string; bill_no: string | null; bill_amount: number; due_amount: number;
      paid_amount: number; note: string | null; bill_path: string | null;
      settled_at: string | null; created_at: string; profiles: { full_name: string } | null;
    };
    type P = {
      id: string; sale_id: string | null; amount: number; method: string | null;
      reference: string | null; proof_path: string | null; note: string | null;
      created_at: string; profiles: { full_name: string } | null;
    };
    const sales = (s as unknown as S[]) ?? [];
    const pays = (p as unknown as P[]) ?? [];

    setOpenSales(
      sales
        .filter((x) => !x.settled_at)
        .map((x) => ({
          id: x.id,
          label: `${fmtDate(x.created_at)} · ${rupees(Number(x.due_amount) - Number(x.paid_amount))} left`,
        })),
    );

    // sign both buckets in one pass
    const paths = [
      ...sales.map((x) => x.bill_path),
      ...pays.map((x) => x.proof_path),
    ].filter(Boolean) as string[];
    const urls: Record<string, string> = {};
    const billPaths = sales.map((x) => x.bill_path).filter(Boolean) as string[];
    const proofPaths = pays.map((x) => x.proof_path).filter(Boolean) as string[];
    if (billPaths.length) {
      const { data: signed } = await supabase.storage.from("bills").createSignedUrls(billPaths, 3600);
      for (const x of signed ?? []) if (x.path && x.signedUrl) urls[x.path] = x.signedUrl;
    }
    if (proofPaths.length) {
      const { data: signed } = await supabase.storage.from("payment-proofs").createSignedUrls(proofPaths, 3600);
      for (const x of signed ?? []) if (x.path && x.signedUrl) urls[x.path] = x.signedUrl;
    }
    void paths;

    // Merge oldest-first so the running balance builds the way the
    // paper page does, then show newest first.
    const merged: Omit<Entry, "running">[] = [
      ...sales.map((x) => ({
        id: `s${x.id}`,
        kind: "BILL" as const,
        at: x.created_at,
        amount: Number(x.due_amount),
        detail: [
          x.bill_no ? `Bill ${x.bill_no}` : "Goods on credit",
          Number(x.due_amount) !== Number(x.bill_amount)
            ? `of ${rupees(x.bill_amount)} total` : "",
          x.note ?? "",
        ].filter(Boolean).join(" · "),
        who: x.profiles?.full_name ?? "—",
        image: x.bill_path ? urls[x.bill_path] ?? null : null,
        unevidenced: false,
      })),
      ...pays.map((x) => ({
        id: `p${x.id}`,
        kind: "PAYMENT" as const,
        at: x.created_at,
        amount: Number(x.amount),
        detail: [
          x.method ? METHOD_LABEL[x.method] ?? x.method : "Payment",
          x.sale_id ? "" : "on account",
          x.reference ?? "",
          x.note ?? "",
        ].filter(Boolean).join(" · "),
        who: x.profiles?.full_name ?? "—",
        image: x.proof_path ? urls[x.proof_path] ?? null : null,
        // proof is optional now, so the owner needs to see which entries
        // rest on nothing but the word of whoever took the money
        unevidenced: !x.proof_path && !(x.reference ?? "").trim(),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    let run = 0;
    const withRunning = merged.map((e) => {
      run += e.kind === "BILL" ? e.amount : -e.amount;
      return { ...e, running: run };
    });
    setEntries(withRunning.reverse());
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const saveMoney = async () => {
    if (!money || !customer) return;
    const amt = Number(money.amount || 0);
    if (amt <= 0) return;
    setBusy(true);
    setError(null);
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from("credit_payments").insert({
      customer_id: customer.id,
      sale_id: money.sale || null,
      amount: amt,
      received_by: me.user?.id,
      method: "OTHER",
      reference: "Entered by owner",
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const after = Number(customer.balance) - amt;
    setNotice(
      after < 0 ? `${rupees(amt)} received — ${rupees(after)} now held as advance.`
      : after === 0 ? "Fully settled."
      : `${rupees(amt)} received — ${rupees(after)} still owed.`,
    );
    setMoney(null);
    await load();
  };

  if (!customer) {
    return (
      <div>
        <div className="page-head"><h1>Customer</h1></div>
        {error && <div className="banner error">{error}</div>}
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const bal = Number(customer.balance);
  const initials = customer.name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "").join("");

  return (
    <div>
      <div className="khata-back">
        <Link to="/credit">← All customers</Link>
      </div>

      <div className="khata-head card">
        <div className="kh-avatar">{initials}</div>
        <div className="kh-who">
          <h1>{titleCase(customer.name)}</h1>
          <p className="muted">
            {customer.phone ?? "no phone number"}
            {" · "}{customer.bill_count} bill{Number(customer.bill_count) === 1 ? "" : "s"}
          </p>
        </div>
        <div className="kh-bal">
          <span className="kh-bal-label">
            {bal > 0 ? "You will get" : bal < 0 ? "You will give" : "Settled"}
          </span>
          <span className={bal > 0 ? "kh-bal-get" : bal < 0 ? "kh-bal-give" : "kh-bal-nil"}>
            {bal === 0 ? "₹0" : rupees(bal)}
          </span>
        </div>
        <div className="kh-acts">
          <button className="btn primary" onClick={() => setMoney({ amount: "", sale: "" })}>
            Money received
          </button>
          {customer.phone && bal > 0 && (
            // Opens WhatsApp with a draft — the owner reads it and sends
            // it themselves. Nothing goes out on its own.
            <a
              className="btn"
              target="_blank"
              rel="noreferrer"
              href={`https://wa.me/91${customer.phone}?text=${encodeURIComponent(
                `Namaste ${customer.name}, this is a gentle reminder that ₹${Number(bal).toLocaleString("en-IN")} is pending at Agamani Basanti. Thank you.`,
              )}`}
            >
              Remind on WhatsApp
            </a>
          )}
        </div>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      <table className="ledger">
        <thead>
          <tr>
            <th>Date</th>
            <th>Details</th>
            <th className="right">Goods given</th>
            <th className="right">Money received</th>
            <th className="right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr><td colSpan={5} className="empty-cell">Nothing on this page yet.</td></tr>
          )}
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="led-date">
                {fmtDate(e.at)}
                <div className="note muted">{fmtTime(e.at)}</div>
              </td>
              <td>
                {e.detail}
                {e.unevidenced && <span className="no-proof">no proof</span>}
                <div className="note muted">by {titleCase(e.who)}</div>
              </td>
              <td className="right">
                {e.kind === "BILL" && <span className="led-out">{rupees(e.amount)}</span>}
              </td>
              <td className="right">
                {e.kind === "PAYMENT" && <span className="led-in">{rupees(e.amount)}</span>}
              </td>
              <td className="right">
                <span className={e.running > 0 ? "led-bal-owed" : e.running < 0 ? "led-bal-adv" : "muted"}>
                  {e.running === 0 ? "₹0" : rupees(e.running)}
                </span>
                {e.image && (
                  <button
                    className="shot-btn led-shot"
                    onClick={() => setZoom({
                      url: e.image!,
                      caption: `${titleCase(customer.name)} · ${fmtDate(e.at)} · ${rupees(e.amount)}`,
                    })}
                  >
                    <img src={e.image} alt="" className="shot" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {money && (
        <div className="shot-zoom" onClick={() => setMoney(null)} role="presentation">
          <div className="entry-card" onClick={(ev) => ev.stopPropagation()}>
            <h3>Money received</h3>
            <p className="muted">
              {bal > 0 ? `${rupees(bal)} currently owed` : "Nothing owed — this will be kept as an advance"}
            </p>
            <label>
              Amount (₹)
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                value={money.amount}
                onChange={(ev) =>
                  setMoney({ ...money, amount: ev.target.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "") })}
              />
            </label>
            <label>
              Against
              <select value={money.sale} onChange={(ev) => setMoney({ ...money, sale: ev.target.value })}>
                <option value="">The whole account</option>
                {openSales.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <div className="entry-acts">
              <button
                className="btn primary"
                disabled={Number(money.amount || 0) <= 0 || busy}
                onClick={saveMoney}
              >
                {busy ? "Saving…" : "Record"}
              </button>
              <button className="btn" onClick={() => setMoney(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {zoom && (
        <div className="shot-zoom" onClick={() => setZoom(null)} role="presentation">
          <figure onClick={(ev) => ev.stopPropagation()}>
            <img src={zoom.url} alt={zoom.caption} />
            <figcaption>{zoom.caption}</figcaption>
          </figure>
          <button className="btn" onClick={() => setZoom(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
