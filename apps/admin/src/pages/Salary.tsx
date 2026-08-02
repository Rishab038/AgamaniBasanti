// Salary — the month-end ritual, made two buttons:
// 1. "Generate draft" runs the engine (regenerate as often as you
//    like while fixing attendance).
// 2. "Confirm & freeze" locks it, recovers advances oldest-first,
//    and puts the payslip in every worker's app.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

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

/** Indian grouping, paise only when there are any, and a real minus
 *  sign (U+2212) rather than a hyphen — straight from the handoff. */
const inr = (n: number) => {
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(2).split(".");
  const dec = frac === "00" ? "" : `.${frac}`;
  let last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  if (rest) last3 = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
  return `${neg ? "−₹" : "₹"}${last3}${dec}`;
};

/** "2026-08" -> "August 2026" */
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export default function Salary() {
  const [month, setMonth] = useState(thisMonth());
  const { branchId, branch } = useBranch();
  const [run, setRun] = useState<Run | null>(null);
  const [slips, setSlips] = useState<Payslip[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const [payGaps, setPayGaps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [salSeg, setSalSeg] = useState<"all" | "review" | "zero">("all");
  const [monthOpen, setMonthOpen] = useState(false);
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

    // Staff whose pay inputs are missing come out of the engine as ₹0 —
    // silently. Warn before the owner generates or confirms anything:
    // PF staff need the component breakdown (Basic/HRA/…), everyone
    // else needs a base salary.
    const { data: staff } = await supabase
      .from("profiles")
      .select("full_name, employment_type, base_salary, salary_basic")
      .eq("branch_id", bid)
      .eq("role", "worker")
      .eq("active", true);
    setPayGaps(
      (staff ?? [])
        .filter((p) =>
          p.employment_type === "PF"
            ? !Number(p.salary_basic)
            : !Number(p.base_salary),
        )
        .map((p) => titleCase(p.full_name)),
    );
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

  // A day proved by only one of the two sources — the app or the
  // fingerprint, not both. It is still being paid; the owner is only
  // being told it rests on one leg.
  const oneWay = (s: Payslip) => Number(s.data.single_verified_days ?? 0) > 0;
  const daysPaid = (s: Payslip) =>
    Number(s.data.worked_days ?? 0) +
    Number(s.data.rest_days ?? 0) +
    Number(s.data.paid_leave_days ?? 0);
  /** what came off, whatever the reason: absence plus advance recovery */
  const cutOf = (s: Payslip) => Number(s.deductions) + Number(s.advance_cut);

  const reviewCount = slips.filter(oneWay).length;
  const zeroCount = slips.filter((s) => Number(s.net) === 0).length;

  const shown = [...slips]
    .filter((s) =>
      salSeg === "review" ? oneWay(s) : salSeg === "zero" ? Number(s.net) === 0 : true)
    .sort((a, b) => Number(b.net) - Number(a.net));

  const frozen = run?.status === "CONFIRMED";
  const showNotice = !!run && !frozen && reviewCount > 0 && salSeg !== "review";

  return (
    <div>
      {/* What is owed sits at the top right, because that is the number
          the owner came for; the controls that change it sit below. */}
      <div className="sheet-head">
        <div>
          <h1>Salary · {branch?.name ?? ""}</h1>
          <p className="sub">Check the draft, then confirm. Advances come off on their own.</p>
        </div>
        {slips.length > 0 && (
          <div className="big-figure">
            <div className="amount">{inr(totals.net)}</div>
            <div className="under">
              to pay · {slips.length} {slips.length === 1 ? "person" : "people"}
            </div>
          </div>
        )}
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      <div className="seg-row">
        {slips.length > 0 && (
          <div className="seg" role="group" aria-label="Which staff to show">
            {([
              ["all", `Everyone · ${slips.length}`],
              ["review", `Needs review · ${reviewCount}`],
              ["zero", `Nothing to pay · ${zeroCount}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                className={`seg-btn${salSeg === k ? " on" : ""}`}
                aria-pressed={salSeg === k}
                onClick={() => setSalSeg(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="pop-wrap">
          <button className="pill-btn" onClick={() => setMonthOpen((o) => !o)}>
            {monthName(month)} ▾
          </button>
          {monthOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMonthOpen(false)} />
              <div className="pop">
                <label>
                  Month
                  <input
                    type="month"
                    value={month}
                    max={thisMonth()}
                    onChange={(e) => { setMonth(e.target.value); setMonthOpen(false); }}
                  />
                </label>
              </div>
            </>
          )}
        </div>

        {run && (
          <span className={`state-pill ${frozen ? "done" : "draft"}`}>
            {frozen ? "✓ Confirmed" : "● Draft"}
          </span>
        )}
      </div>

      {showNotice && (
        <div className="notice-strip">
          <span className="notice-mark" aria-hidden="true">!</span>
          <span className="say">
            {reviewCount} {reviewCount === 1 ? "person has" : "people have"} a day marked only one
            way — app or fingerprint, not both. Those days are being paid.
          </span>
          <button className="go" onClick={() => setSalSeg("review")}>Review them</button>
        </div>
      )}

      {payGaps.length > 0 && run?.status !== "CONFIRMED" && (
        <div className="banner warn">
          {payGaps.length} staff {payGaps.length > 1 ? "have" : "has"} no salary set up —
          their pay will come out as <strong>₹0</strong>:{" "}
          {payGaps.slice(0, 5).join(", ")}
          {payGaps.length > 5 ? ` and ${payGaps.length - 5} more` : ""}. For PF staff fill in
          the salary breakup (Basic, HRA…), for others the monthly salary — on the Staff page.
        </div>
      )}

      {unresolved > 0 && !frozen && !showNotice && (
        <div className="banner warn">
          {unresolved} day{unresolved > 1 ? "s" : ""} this month {unresolved > 1 ? "have" : "has"} only
          single verification (app or fingerprint alone). They count as paid — review them on the
          Attendance page before confirming.
        </div>
      )}

      {!run && (
        <div className="card">
          <span className="muted">
            No salary run for this month yet — press "Make draft" to calculate it from
            attendance.
          </span>
        </div>
      )}

      {slips.length > 0 && (
        <table className="pay-table">
          <thead>
            <tr>
              <th>Staff</th>
              <th className="mid" style={{ width: 110 }}>Days paid</th>
              <th className="end" style={{ width: 130 }}>Cut</th>
              <th className="end" style={{ width: 150 }}>Take home</th>
              <th style={{ width: 14 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const cut = cutOf(s);
              return (
                <tr key={s.id}>
                  <td>
                    <span className="pay-staff">
                      <span className="pay-name">{titleCase(s.profiles?.full_name ?? "")}</span>
                      {oneWay(s) && (
                        <span
                          className="oneway-dot"
                          title={`${s.data.single_verified_days} day(s) proved only one way`}
                        />
                      )}
                    </span>
                  </td>
                  <td className="mid pay-days">{daysPaid(s)}</td>
                  <td
                    className="end pay-cut"
                    title={
                      cut > 0
                        ? `Absence ${inr(Number(s.deductions))} · advance ${inr(Number(s.advance_cut))}`
                        : undefined
                    }
                  >
                    {cut > 0 ? inr(-cut) : "—"}
                  </td>
                  <td className="end pay-net">{inr(Number(s.net))}</td>
                  <td className="end person-chev" aria-hidden="true">›</td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="list-empty">
                  {salSeg === "review"
                    ? "Every day this month is proved both ways."
                    : "Everybody has something to be paid."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {slips.length > 0 && (
        <div className="sheet-foot">
          <span className="count">
            <span className="foot-legend">
              <span className="oneway-dot" aria-hidden="true" />
              one-way day · total cut {inr(totals.ded + totals.adv)}
            </span>
          </span>
          <div className="sheet-foot-acts">
            {!frozen && (
              <button className="btn" onClick={generate} disabled={busy}>
                {busy ? "Working…" : run ? "Make draft again" : "Make draft"}
              </button>
            )}
            <button className="btn" onClick={exportCsv} disabled={slips.length === 0}>
              Download CSV
            </button>
            {!frozen && (
              confirming ? (
                <>
                  <button className="btn confirm" onClick={confirm} disabled={busy}>
                    Yes, confirm &amp; lock
                  </button>
                  <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn confirm" onClick={() => setConfirming(true)} disabled={busy}>
                  Confirm &amp; lock
                </button>
              )
            )}
          </div>
        </div>
      )}

      {!run && (
        <div className="sheet-foot">
          <span className="count" />
          <div className="sheet-foot-acts">
            <button className="btn primary" onClick={generate} disabled={busy}>
              {busy ? "Working…" : "Make draft"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
