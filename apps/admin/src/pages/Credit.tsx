// The credit book — the list of people, and what each of them owes.
//
// Modelled on the khata the owner already knows: the two totals he
// cares about at the top, then one line per person carrying a name, how
// long since anything happened, and a number. Nothing else, because
// nothing else is being asked at this moment. The bills, the payments
// and the photographs live on the person's own page, one click away.

import { useCallback, useEffect, useMemo, useState } from "react";
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

const rupees = (n: number) => `₹${Math.abs(Number(n)).toLocaleString("en-IN")}`;

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

  const load = useCallback(async () => {
    if (!branchId) return;
    const { data, error: err } = await supabase
      .from("customer_balances")
      .select("*")
      .eq("branch_id", branchId);
    if (err) { setError(err.message); return; }
    setRows((data as Customer[]) ?? []);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

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
    </div>
  );
}
