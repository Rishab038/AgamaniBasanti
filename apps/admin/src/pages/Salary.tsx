// Salary — the month-end ritual, made two buttons:
// 1. "Generate draft" runs the engine (regenerate as often as you
//    like while fixing attendance).
// 2. "Confirm & freeze" locks it, recovers advances oldest-first,
//    and puts the payslip in every worker's app.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";

type Run = { id: string; status: "DRAFT" | "CONFIRMED"; confirmed_at: string | null };

type Payslip = {
  id: string;
  gross: number;
  deductions: number;
  advance_cut: number;
  net: number;
  data: Record<string, number | string | boolean>;
  profiles: { full_name: string; employee_code: string } | null;
};

const thisMonth = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;

export default function Salary() {
  const [month, setMonth] = useState(thisMonth());
  const { branchId, branch } = useBranch();
  const [run, setRun] = useState<Run | null>(null);
  const [slips, setSlips] = useState<Payslip[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const monthDate = `${month}-01`;

  const load = useCallback(async () => {
    const bid = branchId;
    if (!bid) return;

    const { data: runs } = await supabase
      .from("payroll_runs")
      .select("id, status, confirmed_at")
      .eq("branch_id", bid)
      .eq("month", monthDate);
    const r = (runs?.[0] as Run) ?? null;
    setRun(r);

    if (r) {
      const { data: ps } = await supabase
        .from("payslips")
        .select("id, gross, deductions, advance_cut, net, data, profiles(full_name, employee_code)")
        .eq("payroll_run_id", r.id)
        .order("id");
      setSlips((ps as unknown as Payslip[]) ?? []);
    } else {
      setSlips([]);
    }

    const monthEnd = new Date(new Date(`${monthDate}T00:00:00`).getFullYear(),
      new Date(`${monthDate}T00:00:00`).getMonth() + 1, 0);
    const { count } = await supabase
      .from("attendance_days")
      .select("id, profiles!attendance_days_profile_id_fkey!inner(branch_id)", {
        count: "exact", head: true,
      })
      .eq("profiles.branch_id", bid)
      .gte("work_date", monthDate)
      .lte("work_date", monthEnd.toLocaleDateString("en-CA"))
      .is("decision", null)
      .not("review_reasons", "eq", "{}");
    setUnresolved(count ?? 0);
  }, [branchId, monthDate]);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    if (!branchId) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("fn_generate_payroll", {
      p_branch: branchId,
      p_month: monthDate,
    });
    if (err) setError(err.message);
    else setNotice("Draft ready. Check every row, then confirm to freeze.");
    setBusy(false);
    await load();
  };

  const confirm = async () => {
    if (!run) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("fn_confirm_payroll", { p_run: run.id });
    if (err) setError(err.message);
    else setNotice("Salary confirmed — payslips are now in every worker's app.");
    setBusy(false);
    await load();
  };

  const exportCsv = () => {
    const header =
      "Month,Code,Name,Days paid,Unpaid days,Gross,Deduction,Advance cut,Net";
    const lines = slips.map((s) =>
      [
        month,
        s.profiles?.employee_code ?? "",
        `"${s.profiles?.full_name ?? ""}"`,
        Number(s.data.worked_days ?? 0) + Number(s.data.rest_days ?? 0) +
          Number(s.data.paid_leave_days ?? 0),
        s.data.unpaid_days_total ?? 0,
        s.gross,
        s.deductions,
        s.advance_cut,
        s.net,
      ].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `salary-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const totals = slips.reduce(
    (t, s) => ({
      gross: t.gross + Number(s.gross),
      ded: t.ded + Number(s.deductions),
      adv: t.adv + Number(s.advance_cut),
      net: t.net + Number(s.net),
    }),
    { gross: 0, ded: 0, adv: 0, net: 0 },
  );

  return (
    <div>
      <div className="page-head">
        <h1>Salary · {branch?.name ?? ""}</h1>
        <p>Generate a draft, check it, confirm — advances are recovered automatically.</p>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      <div className="card filter-row">
        <label>
          Month
          <input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} />
        </label>
        {run?.status !== "CONFIRMED" && (
          <button className="btn primary" onClick={generate} disabled={busy}>
            {busy ? "Working…" : run ? "Regenerate draft" : "Generate draft"}
          </button>
        )}
        {run?.status === "DRAFT" && slips.length > 0 && (
          confirming ? (
            <>
              <button className="btn good" onClick={confirm} disabled={busy}>
                Yes, freeze this month
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn good" onClick={() => setConfirming(true)} disabled={busy}>
              Confirm & freeze
            </button>
          )
        )}
        {run && (
          <span className={`pill ${run.status === "CONFIRMED" ? "good" : "warn"}`}>
            {run.status === "CONFIRMED" ? "Confirmed ✓" : "Draft — not final"}
          </span>
        )}
        <button className="btn" onClick={exportCsv} disabled={slips.length === 0}>
          ⬇ Export CSV
        </button>
      </div>

      {unresolved > 0 && run?.status !== "CONFIRMED" && (
        <div className="banner warn">
          {unresolved} day{unresolved > 1 ? "s" : ""} this month {unresolved > 1 ? "have" : "has"} only
          single verification (app or fingerprint alone). They count as paid — review them on the
          Attendance page before confirming.
        </div>
      )}

      {!run && (
        <div className="card">
          <span className="muted">
            No salary run for this month yet — press "Generate draft" to calculate it from
            attendance.
          </span>
        </div>
      )}

      {slips.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Staff</th>
              <th>Days paid</th>
              <th>Unpaid</th>
              <th>Gross</th>
              <th>Deduction</th>
              <th>Advance</th>
              <th>Net pay</th>
            </tr>
          </thead>
          <tbody>
            {slips.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.profiles?.full_name}</strong>{" "}
                  <span className="muted">({s.profiles?.employee_code})</span>
                  {Number(s.data.single_verified_days ?? 0) > 0 && (
                    <div className="note muted">
                      incl. {s.data.single_verified_days} single-verified day(s)
                    </div>
                  )}
                  {Number(s.data.missing_days ?? 0) > 0 && (
                    <div className="note muted">{s.data.missing_days} day(s) with no record</div>
                  )}
                </td>
                <td>
                  {Number(s.data.worked_days ?? 0) + Number(s.data.rest_days ?? 0) +
                    Number(s.data.paid_leave_days ?? 0)}
                </td>
                <td>{s.data.unpaid_days_total ?? 0}</td>
                <td>{rupees(s.gross)}</td>
                <td>{Number(s.deductions) > 0 ? `− ${rupees(s.deductions)}` : "—"}</td>
                <td>{Number(s.advance_cut) > 0 ? `− ${rupees(s.advance_cut)}` : "—"}</td>
                <td><strong>{rupees(s.net)}</strong></td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong></td>
              <td />
              <td />
              <td><strong>{rupees(totals.gross)}</strong></td>
              <td><strong>{totals.ded > 0 ? `− ${rupees(totals.ded)}` : "—"}</strong></td>
              <td><strong>{totals.adv > 0 ? `− ${rupees(totals.adv)}` : "—"}</strong></td>
              <td><strong>{rupees(totals.net)}</strong></td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
