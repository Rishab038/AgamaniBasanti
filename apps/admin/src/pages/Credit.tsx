// The credit book — the list of people, and what each of them owes.
//
// Modelled on the khata the owner already knows: the two totals he
// cares about at the top, then one line per person carrying a name, how
// long since anything happened, and a number. Nothing else, because
// nothing else is being asked at this moment. The bills, the payments
// and the photographs live on the person's own page, one click away.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  bill_count: number;
  total_owed: number;
  total_received: number;
  balance: number;
  last_bill_at: string | null;
  last_payment_at: string | null;
};

/** a single line of the book — one bill, or one payment */
type Txn = {
  id: string;
  /** the row's own id, without the s/p prefix the list keys on */
  rowId: string;
  kind: "BILL" | "PAYMENT";
  at: string;
  amount: number;
  /** the customer, as named on the entry */
  who: string;
  customerId: string | null;
  /** the phone on the record behind that name, where there is one */
  phone: string | null;
  detail: string;
  /** the staff member who wrote it down */
  staff: string;
  /** what the correction dialog needs to open filled in */
  billNo: string | null;
  billAmount: number | null;
  method: string | null;
  reference: string | null;
  note: string | null;
};

/** an entry the owner has opened to correct */
type EditState = {
  txn: Txn;
  custName: string;
  custPhone: string;
  amount: string;
  billNo: string;
  billAmount: string;
  method: string;
  reference: string;
  note: string;
  busy: boolean;
  confirmDelete: boolean;
  error: string | null;
};

/** one day's movement across the whole book */
type DayTotals = {
  date: string;
  given: number;      // goods handed over on credit
  received: number;   // money taken in
  bills: number;
  payments: number;
  items: Txn[];
};

const rupees = (n: number) => `₹${Math.abs(Number(n)).toLocaleString("en-IN")}`;
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
const fmtTime = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", {
    hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  });

const METHOD_LABEL: Record<string, string> = {
  CASH: "Cash", UPI: "UPI", CARD: "Card", BANK: "Bank", OTHER: "Other",
};

/** "7 days ago", "4 weeks ago" — the shape of memory, not a timestamp */
const ago = (ts: string | null): string => {
  if (!ts) return "no activity";
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  const m = Math.floor(days / 30);
  return `${m} month${m === 1 ? "" : "s"} ago`;
};

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

type Filter = "all" | "owes" | "advance" | "clear";

export default function Credit() {
  const { branchId, branch } = useBranch();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"people" | "days">("people");
  const [days, setDays] = useState<DayTotals[]>([]);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    const [{ data, error: err }, { data: sales }, { data: pays }] = await Promise.all([
      supabase.from("customer_balances").select("*").eq("branch_id", branchId),
      supabase
        .from("credit_sales")
        .select("id, customer_id, customer_name, customer_phone, bill_no, bill_amount, due_amount, note, created_at, profiles!credit_sales_recorded_by_fkey(full_name), customers(name, phone)")
        .eq("branch_id", branchId),
      // payments carry no branch of their own; they belong to the shop
      // that made the sale, so reach it through the customer
      supabase
        .from("credit_payments")
        .select("id, customer_id, sale_id, amount, method, reference, note, created_at, profiles!credit_payments_received_by_fkey(full_name), customers!inner(branch_id, name, phone)")
        .eq("customers.branch_id", branchId),
    ]);
    if (err) { setError(err.message); return; }
    setRows((data as Customer[]) ?? []);

    // One row per day: goods that went out on credit, money that came
    // back in, and the individual lines behind both. Grouped here rather
    // than in SQL because the book is small and the owner wants the
    // totals and the lines from the same reading.
    type S = {
      id: string; customer_id: string | null; customer_name: string;
      customer_phone: string | null;
      bill_no: string | null; bill_amount: number; due_amount: number;
      note: string | null; created_at: string;
      profiles: { full_name: string } | null;
      customers: { name: string; phone: string | null } | null;
    };
    type P = {
      id: string; customer_id: string; sale_id: string | null; amount: number;
      method: string | null; reference: string | null; note: string | null;
      created_at: string; profiles: { full_name: string } | null;
      customers: { name: string; phone: string | null } | null;
    };

    const byDay = new Map<string, DayTotals>();
    const touch = (iso: string) => {
      const d = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      if (!byDay.has(d)) {
        byDay.set(d, { date: d, given: 0, received: 0, bills: 0, payments: 0, items: [] });
      }
      return byDay.get(d)!;
    };

    for (const x of (sales as unknown as S[]) ?? []) {
      const e = touch(x.created_at);
      e.given += Number(x.due_amount);
      e.bills += 1;
      e.items.push({
        id: `s${x.id}`,
        rowId: x.id,
        kind: "BILL",
        at: x.created_at,
        amount: Number(x.due_amount),
        // the customer record is the name that counts; the bill's own
        // copy only stands in when the bill was never linked to one
        who: x.customers?.name ?? x.customer_name,
        customerId: x.customer_id,
        phone: x.customers?.phone ?? x.customer_phone,
        detail: [
          x.bill_no ? `Bill ${x.bill_no}` : "Goods on credit",
          // a part-paid bill: say what the whole sale came to
          Number(x.due_amount) !== Number(x.bill_amount)
            ? `of ${rupees(x.bill_amount)} total` : "",
          x.note ?? "",
        ].filter(Boolean).join(" · "),
        staff: x.profiles?.full_name ?? "—",
        billNo: x.bill_no,
        billAmount: Number(x.bill_amount),
        method: null,
        reference: null,
        note: x.note,
      });
    }

    for (const x of (pays as unknown as P[]) ?? []) {
      const e = touch(x.created_at);
      e.received += Number(x.amount);
      e.payments += 1;
      e.items.push({
        id: `p${x.id}`,
        rowId: x.id,
        kind: "PAYMENT",
        at: x.created_at,
        amount: Number(x.amount),
        who: x.customers?.name ?? "—",
        customerId: x.customer_id,
        phone: x.customers?.phone ?? null,
        detail: [
          x.method ? METHOD_LABEL[x.method] ?? x.method : "Payment",
          x.sale_id ? "" : "on account",
          x.reference ?? "",
          x.note ?? "",
        ].filter(Boolean).join(" · "),
        staff: x.profiles?.full_name ?? "—",
        billNo: null,
        billAmount: null,
        method: x.method,
        reference: x.reference,
        note: x.note,
      });
    }

    for (const d of byDay.values()) d.items.sort((a, b) => a.at.localeCompare(b.at));
    setDays([...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)));
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const openEdit = (t: Txn) =>
    setEdit({
      txn: t,
      custName: t.who,
      custPhone: t.phone ?? "",
      amount: String(t.amount),
      billNo: t.billNo ?? "",
      billAmount: t.billAmount == null ? "" : String(t.billAmount),
      method: t.method ?? "",
      reference: t.reference ?? "",
      note: t.note ?? "",
      busy: false,
      confirmDelete: false,
      error: null,
    });

  const digits = (s: string) => s.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
  // a landline carries its STD code, so leading zeros stay
  const phoneDigits = (s: string) => s.replace(/[^0-9]/g, "").slice(0, 15);

  // PostgREST reports a successful update even when RLS matched no rows,
  // so every write here asks for the row back and treats an empty answer
  // as the refusal it actually is.
  const saveEdit = async () => {
    if (!edit) return;
    const { txn } = edit;
    const amount = Number(edit.amount || 0);
    const name = edit.custName.trim();
    const phone = edit.custPhone.trim() || null;
    if (amount <= 0) { setEdit({ ...edit, error: "Amount has to be more than zero." }); return; }
    if (!name) { setEdit({ ...edit, error: "The customer needs a name." }); return; }
    setEdit({ ...edit, busy: true, error: null });

    // Who this is gets corrected on the customer record, so it lands on
    // every entry of theirs at once. The one bill in the book with no
    // customer behind it can only be corrected on the bill itself.
    if (name !== txn.who || phone !== (txn.phone ?? null)) {
      if (txn.customerId) {
        const { data: c, error: cErr } = await supabase
          .from("customers").update({ name, phone })
          .eq("id", txn.customerId).select("id");
        if (cErr) {
          setEdit({
            ...edit, busy: false,
            error: cErr.code === "23505"
              ? `There is already a customer called “${name}” at this shop. Two pages cannot share a name — rename one of them first.`
              : cErr.message,
          });
          return;
        }
        if (!c || c.length === 0) {
          setEdit({ ...edit, busy: false, error: "The name was not changed — this customer is not yours to edit." });
          return;
        }
      } else {
        const { error: sErr } = await supabase
          .from("credit_sales")
          .update({ customer_name: name, customer_phone: phone })
          .eq("id", txn.rowId);
        if (sErr) { setEdit({ ...edit, busy: false, error: sErr.message }); return; }
      }
    }

    const q = txn.kind === "BILL"
      ? supabase.from("credit_sales").update({
          due_amount: amount,
          bill_amount: Number(edit.billAmount || 0) || amount,
          bill_no: edit.billNo.trim() || null,
          note: edit.note.trim() || null,
        }).eq("id", txn.rowId)
      : supabase.from("credit_payments").update({
          amount,
          method: edit.method || null,
          reference: edit.reference.trim() || null,
          note: edit.note.trim() || null,
        }).eq("id", txn.rowId);

    const { data, error: err } = await q.select("id");
    if (err) { setEdit({ ...edit, busy: false, error: err.message }); return; }
    if (!data || data.length === 0) {
      setEdit({ ...edit, busy: false, error: "Nothing was changed — this entry is not yours to edit." });
      return;
    }
    setEdit(null);
    await load();
  };

  const deleteEdit = async () => {
    if (!edit) return;
    const { txn } = edit;
    setEdit({ ...edit, busy: true, error: null });

    const table = txn.kind === "BILL" ? "credit_sales" : "credit_payments";
    const { data, error: err } = await supabase
      .from(table).delete().eq("id", txn.rowId).select("id");

    if (err) { setEdit({ ...edit, busy: false, error: err.message }); return; }
    if (!data || data.length === 0) {
      setEdit({ ...edit, busy: false, error: "Nothing was removed — this entry is not yours to delete." });
      return;
    }
    setEdit(null);
    await load();
  };

  const lastActivity = (c: Customer) => {
    const a = c.last_bill_at, b = c.last_payment_at;
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  };

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    return rows
      .filter((c) =>
        filter === "all" ? true
        : filter === "owes" ? Number(c.balance) > 0
        : filter === "advance" ? Number(c.balance) < 0
        : Number(c.balance) === 0)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone ?? "").includes(q))
      // most recently touched first, the way a khata falls open
      .sort((a, b) => (lastActivity(b) ?? "").localeCompare(lastActivity(a) ?? ""));
  }, [rows, filter, q]);

  const willGet = rows.reduce((t, c) => t + (Number(c.balance) > 0 ? Number(c.balance) : 0), 0);
  const willGive = rows.reduce((t, c) => t + (Number(c.balance) < 0 ? -Number(c.balance) : 0), 0);

  const counts = {
    all: rows.length,
    owes: rows.filter((c) => Number(c.balance) > 0).length,
    advance: rows.filter((c) => Number(c.balance) < 0).length,
    clear: rows.filter((c) => Number(c.balance) === 0).length,
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Credit book · {branch?.name ?? ""}</h1>
          <p>One page per customer</p>
        </div>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {/* The two numbers the owner opens this page for. */}
      <div className="khata-summary card">
        <div className="ks-half">
          <span className="ks-label">You will give</span>
          <span className="ks-give">{willGive === 0 ? "₹0" : rupees(willGive)}</span>
          <span className="ks-note">advances held for customers</span>
        </div>
        <div className="ks-divider" />
        <div className="ks-half">
          <span className="ks-label">You will get</span>
          <span className="ks-get">{willGet === 0 ? "₹0" : rupees(willGet)}</span>
          <span className="ks-note">
            from {counts.owes} customer{counts.owes === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Two ways to read the same book: by person (who owes me) and by
          day (what moved). The owner asks both, at different moments. */}
      <div className="khata-tabs">
        <button
          className={`khata-tab${view === "people" ? " on" : ""}`}
          onClick={() => setView("people")}
        >
          By customer
        </button>
        <button
          className={`khata-tab${view === "days" ? " on" : ""}`}
          onClick={() => setView("days")}
        >
          Day by day
        </button>
      </div>

      {view === "days" ? (
        <>
          <table className="ledger">
            <thead>
              <tr>
                <th>Date</th>
                <th className="right">Goods given</th>
                <th className="right">Money received</th>
                <th className="right">Day's change</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 && (
                <tr><td colSpan={4} className="empty-cell">Nothing recorded yet.</td></tr>
              )}
              {days.map((d) => {
                const net = d.given - d.received;
                const open = openDay === d.date;
                const toggle = () => setOpenDay(open ? null : d.date);
                return (
                  <Fragment key={d.date}>
                    <tr
                      className={`day-row${open ? " open" : ""}`}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={open}
                    >
                      <td className="led-date">
                        <span className="day-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                        {fmtDay(d.date)}
                        <div className="note muted">
                          {d.bills > 0 && `${d.bills} bill${d.bills === 1 ? "" : "s"}`}
                          {d.bills > 0 && d.payments > 0 && " · "}
                          {d.payments > 0 && `${d.payments} payment${d.payments === 1 ? "" : "s"}`}
                        </div>
                      </td>
                      <td className="right">
                        {d.given > 0 ? <span className="led-out">{rupees(d.given)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="right">
                        {d.received > 0 ? <span className="led-in">{rupees(d.received)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="right">
                        {/* what the shop's outstanding did that day */}
                        <span className={net > 0 ? "led-bal-owed" : net < 0 ? "led-bal-adv" : "muted"}>
                          {net === 0 ? "no change" : `${net > 0 ? "+" : "−"}${rupees(net)}`}
                        </span>
                      </td>
                    </tr>

                    {/* the day opened out: every line behind those totals,
                        in the order it happened */}
                    {open && (
                      <tr className="day-detail">
                        <td colSpan={4}>
                          <div className="dt-list">
                            {d.items.map((t) => (
                              <div className="dt" key={t.id}>
                                <span className="dt-time">{fmtTime(t.at)}</span>
                                {t.customerId ? (
                                  <button
                                    className="dt-who name-link"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(`/credit/${t.customerId}`);
                                    }}
                                  >
                                    {titleCase(t.who)}
                                  </button>
                                ) : (
                                  <span className="dt-who" title="Not linked to a customer page">
                                    {titleCase(t.who)}
                                  </span>
                                )}
                                <span className="dt-detail muted">{t.detail}</span>
                                <span className="dt-amt">
                                  <span className={t.kind === "BILL" ? "led-out" : "led-in"}>
                                    {t.kind === "BILL" ? "+" : "−"}{rupees(t.amount)}
                                  </span>
                                </span>
                                <span className="dt-staff muted">by {t.staff}</span>
                                <button
                                  className="dt-edit"
                                  onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                                >
                                  Edit
                                </button>
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
            {days.length > 0 && (
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="right">
                    <strong className="led-out">
                      {rupees(days.reduce((t, d) => t + d.given, 0))}
                    </strong>
                  </td>
                  <td className="right">
                    <strong className="led-in">
                      {rupees(days.reduce((t, d) => t + d.received, 0))}
                    </strong>
                  </td>
                  <td className="right">
                    <strong>
                      {rupees(days.reduce((t, d) => t + d.given - d.received, 0))}
                    </strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="hint-line muted">
            Click a day to see every entry behind it, and Edit to correct one.
            Goods given is what went on credit, money received is what came back
            in — against a bill or on account. Dates are the day the entry was
            made, so the old book that was typed in shows as one large day.
          </p>
        </>
      ) : (
      <>
      <div className="card toolbar">
        <div className="toolbar-actions">
          {([
            ["all", `All (${counts.all})`],
            ["owes", `Owes you (${counts.owes})`],
            ["advance", `Advance (${counts.advance})`],
            ["clear", `Settled (${counts.clear})`],
          ] as [Filter, string][]).map(([k, label]) => (
            <button
              key={k}
              className={`btn ${filter === k ? "primary" : ""}`}
              onClick={() => setFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-end">
          <input
            className="note-input"
            style={{ width: 220 }}
            placeholder="Search customer"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="khata-list card">
        {shown.length === 0 && (
          <div className="empty-cell">
            {query ? "No customer matches that search." : "No customers in this book yet."}
          </div>
        )}
        {shown.map((c) => {
          const bal = Number(c.balance);
          return (
            <button
              key={c.id}
              className="kl-row"
              onClick={() => navigate(`/credit/${c.id}`)}
            >
              <span className="kl-avatar">{initialsOf(c.name)}</span>
              <span className="kl-who">
                <span className="kl-name">{titleCase(c.name)}</span>
                <span className="kl-ago">{ago(lastActivity(c))}</span>
              </span>
              <span className="kl-money">
                <span className={bal > 0 ? "kl-get" : bal < 0 ? "kl-give" : "kl-nil"}>
                  {bal === 0 ? "₹0" : rupees(bal)}
                </span>
                <span className="kl-dir">
                  {bal > 0 ? "you will get" : bal < 0 ? "you will give" : "settled"}
                </span>
              </span>
              <span className="kl-chev">›</span>
            </button>
          );
        })}
      </div>

      <p className="hint-line muted">
        Staff switched on for the billing counter add bills and take payments from
        the app. Money taken with nothing owed is held as an advance.
      </p>
      </>
      )}

      {/* Correcting an entry. Money already written down is not casually
          rewritten, so the amount is the only figure that opens focused,
          and removing a line asks a second time before it goes. */}
      {edit && (
        <div className="shot-zoom" onClick={() => !edit.busy && setEdit(null)} role="presentation">
          <div className="entry-card edit-entry" onClick={(e) => e.stopPropagation()}>
            <h3>{edit.txn.kind === "BILL" ? "Correct this bill" : "Correct this payment"}</h3>
            <p className="muted">
              {titleCase(edit.txn.who)} · {fmtDay(
                new Date(edit.txn.at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
              )} at {fmtTime(edit.txn.at)} · entered by {edit.txn.staff}
            </p>

            {edit.error && <div className="banner error">{edit.error}</div>}

            <label>
              Customer
              <input
                type="text"
                value={edit.custName}
                onChange={(e) => setEdit({ ...edit, custName: e.target.value })}
              />
            </label>
            <label>
              Phone
              <input
                type="text"
                inputMode="tel"
                value={edit.custPhone}
                placeholder="none"
                onChange={(e) => setEdit({ ...edit, custPhone: phoneDigits(e.target.value) })}
              />
            </label>
            <p className="field-hint">
              {edit.txn.customerId
                ? "This is the customer's own record — a correction here shows on every one of their entries."
                : "This entry was never linked to a customer page, so the name stays on the bill alone."}
            </p>

            <label>
              {edit.txn.kind === "BILL" ? "Amount on credit (₹)" : "Amount received (₹)"}
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                value={edit.amount}
                onChange={(e) => setEdit({ ...edit, amount: digits(e.target.value) })}
              />
            </label>

            {edit.txn.kind === "BILL" ? (
              <>
                <label>
                  Bill total (₹)
                  <input
                    type="text"
                    inputMode="numeric"
                    value={edit.billAmount}
                    onChange={(e) => setEdit({ ...edit, billAmount: digits(e.target.value) })}
                  />
                </label>
                <label>
                  Bill number
                  <input
                    type="text"
                    value={edit.billNo}
                    placeholder="none"
                    onChange={(e) => setEdit({ ...edit, billNo: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  How it was paid
                  <select
                    value={edit.method}
                    onChange={(e) => setEdit({ ...edit, method: e.target.value })}
                  >
                    <option value="">Not recorded</option>
                    {Object.entries(METHOD_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Reference
                  <input
                    type="text"
                    value={edit.reference}
                    placeholder="UPI reference, cheque number…"
                    onChange={(e) => setEdit({ ...edit, reference: e.target.value })}
                  />
                </label>
              </>
            )}

            <label>
              Note
              <input
                type="text"
                value={edit.note}
                placeholder="optional"
                onChange={(e) => setEdit({ ...edit, note: e.target.value })}
              />
            </label>

            {edit.confirmDelete ? (
              <>
                <p className="error">
                  {edit.txn.kind === "BILL"
                    ? "Remove this bill from the book? What the customer owes drops by this amount."
                    : "Remove this payment? The bill it was against goes back to owing."}
                </p>
                <div className="entry-acts">
                  <button className="btn danger" disabled={edit.busy} onClick={deleteEdit}>
                    {edit.busy ? "Removing…" : "Yes, remove it"}
                  </button>
                  <button
                    className="btn"
                    disabled={edit.busy}
                    onClick={() => setEdit({ ...edit, confirmDelete: false })}
                  >
                    Keep it
                  </button>
                </div>
              </>
            ) : (
              <div className="entry-acts">
                <button className="btn primary" disabled={edit.busy} onClick={saveEdit}>
                  {edit.busy ? "Saving…" : "Save"}
                </button>
                <button className="btn" disabled={edit.busy} onClick={() => setEdit(null)}>
                  Cancel
                </button>
                <button
                  className="btn danger entry-act-end"
                  disabled={edit.busy}
                  onClick={() => setEdit({ ...edit, confirmDelete: true, error: null })}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
