// Attendance history: filter by date range / worker / status,
// approve or reject single-verification days, export CSV.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";

type Row = {
  id: string;
  profile_id: string;
  work_date: string;
  status: string;
  first_in: string | null;
  last_out: string | null;
  late_minutes: number;
  worked_minutes: number | null;
  review_reasons: string[] | null;
  decision: string | null;
  approved_by: string | null;
  note: string | null;
  profiles: { full_name: string; employee_code: string } | null;
};

type Worker = { id: string; full_name: string; employee_code: string };

const STATUS_META: Record<string, { label: string; tone: string }> = {
  VERIFIED: { label: "Verified", tone: "good" },
  APP_ONLY: { label: "App only", tone: "warn" },
  DEVICE_ONLY: { label: "Fingerprint only", tone: "warn" },
  ABSENT: { label: "Absent", tone: "serious" },
  HALF_DAY: { label: "Half day", tone: "warn" },
  OVERTIME: { label: "Overtime", tone: "good" },
  LEAVE_PAID: { label: "Paid leave", tone: "info" },
  LEAVE_UNPAID: { label: "Unpaid leave", tone: "info" },
  HOLIDAY: { label: "Holiday", tone: "neutral" },
  OFF_DAY: { label: "Weekly off", tone: "neutral" },
};

/** why a day was flagged, in words the owner can act on */
const REASON_LABEL: Record<string, string> = {
  LATE_IN: "came late",
  EARLY_IN: "came early",
  EARLY_OUT: "left early",
  LATE_OUT: "stayed late",
  OFF_DAY_WORK: "worked on their leave day",
};

/** a day the owner has not ruled on that either lacks a second source
 *  or broke the shift window */
const needsDecision = (r: {
  status: string; decision: string | null; review_reasons: string[] | null;
}) =>
  !r.decision &&
  ((r.review_reasons ?? []).length > 0 ||
    r.status === "APP_ONLY" ||
    r.status === "DEVICE_ONLY");

/* A decision is one choice among four, not four separate actions — so
   it reads as a list with each option's pay effect stated, rather than
   a row of buttons competing for the eye. */
const DECISIONS: { key: string; label: string; effect: string }[] = [
  { key: "NORMAL", label: "Normal day", effect: "Full pay" },
  { key: "HALF_DAY", label: "Half day", effect: "Half a day deducted" },
  { key: "NO_PAY", label: "No pay", effect: "Full day deducted" },
  { key: "OVERTIME", label: "Overtime", effect: "Adds an extra day's pay" },
];

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtTime = (ts: string | null) =>
  ts ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";

export default function Attendance() {
  const [rows, setRows] = useState<Row[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [workerId, setWorkerId] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { branchId } = useBranch();

  // per-staff totals for the chosen period. A day counts as present if
  // anyone punched for it — however it was verified, and whatever the
  // owner later decided — except when the ruling was NO_PAY.
  const summary = (() => {
    const PRESENT = ["VERIFIED", "APP_ONLY", "DEVICE_ONLY", "HALF_DAY", "OVERTIME"];
    const byStaff = new Map<string, { id: string; name: string; present: number; absent: number }>();
    for (const r of rows) {
      const id = r.profile_id;
      const name = r.profiles?.full_name ?? "Unknown";
      if (!byStaff.has(id)) byStaff.set(id, { id, name, present: 0, absent: 0 });
      const acc = byStaff.get(id)!;
      if (r.status === "ABSENT" || r.decision === "NO_PAY") acc.absent += 1;
      else if (PRESENT.includes(r.status)) acc.present += 1;
    }
    return [...byStaff.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  const load = useCallback(async () => {
    let q = supabase
      .from("attendance_days")
      .select(
        "id, profile_id, work_date, status, first_in, last_out, late_minutes, worked_minutes, review_reasons, decision, approved_by, note, profiles!attendance_days_profile_id_fkey!inner(full_name, employee_code, branch_id)",
      )
      .eq("profiles.branch_id", branchId ?? "")
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: false });
    if (workerId) q = q.eq("profile_id", workerId);
    // "needs attention" = single-source days OR a flagged shift-window
    // issue that the owner has not ruled on yet
    if (onlyProblems) q = q.is("decision", null).not("review_reasons", "eq", "{}");
    const { data, error: err } = await q;
    if (err) setError(err.message);
    setRows((data as unknown as Row[]) ?? []);
  }, [from, to, workerId, onlyProblems, branchId]);

  useEffect(() => {
    if (!branchId) return;
    supabase
      .from("profiles").select("id, full_name, employee_code")
      .eq("role", "worker").eq("branch_id", branchId).order("employee_code")
      .then(({ data }) => setWorkers(data ?? []));
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  // two-step inline confirm (no native popups — they freeze embedded
  // browsers and confuse non-technical users)
  const [pending, setPending] = useState<string | null>(null); // row id being decided
  const [note, setNote] = useState("");

  const decide = async (row: Row, decision: string) => {
    setPending(null);
    const { error: err } = await supabase.rpc("fn_decide_day", {
      p_profile: row.profile_id,
      p_date: row.work_date,
      p_decision: decision,
      p_note: note || null,
    });
    setNote("");
    if (err) setError(err.message);
    else await load();
  };

  const exportCsv = () => {
    const header = "Date,Code,Name,Status,First In,Last Out,Late (min),Approved,Note";
    const lines = rows.map((r) =>
      [
        r.work_date,
        r.profiles?.employee_code ?? "",
        `"${r.profiles?.full_name ?? ""}"`,
        r.status,
        fmtTime(r.first_in),
        fmtTime(r.last_out),
        r.late_minutes,
        r.approved_by ? "yes" : "",
        `"${(r.note ?? "").replace(/"/g, '""')}"`,
      ].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="page-head">
        <h1>Attendance</h1>
        <p>
          {workerId
            ? "Day by day — decide any day that needs your ruling."
            : "Days present and absent for each person. Click a name to see their days."}
        </p>
      </div>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <div className="card filter-row">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Staff
          <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">Everyone</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>{w.full_name}</option>
            ))}
          </select>
        </label>
        <label className="weekday">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
          />
          Needs attention only
        </label>
        <button className="btn" onClick={exportCsv} disabled={rows.length === 0}>
          ⬇ Export CSV
        </button>
      </div>

      {/* Everyone's totals for the chosen period, at a glance — the
          day-by-day table below answers "what happened on the 14th",
          this answers "how is each person doing overall". */}
      {/* Everyone = totals only. Thirty-six people times a month of rows
          was a thousand-line list nobody reads; the day-by-day detail
          appears once you pick a person. Click a card to do that. */}
      {!workerId && summary.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Staff</th>
              <th className="num">Present</th>
              <th className="num">Absent</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setWorkerId(s.id)}>
                <td>{s.name}</td>
                <td className="num strong">{s.present}</td>
                <td className={`num${s.absent > 0 ? " bad" : " muted"}`}>{s.absent}</td>
                <td className="num">
                  <span className="row-go">View days →</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!workerId && summary.length === 0 && (
        <div className="card muted">No attendance in this period.</div>
      )}

      {workerId && (
        <div className="detail-head">
          <button className="btn small" onClick={() => setWorkerId("")}>← All staff</button>
          <strong>{workers.find((w) => w.id === workerId)?.full_name ?? ""}</strong>
          <span className="muted">
            {summary[0]?.present ?? 0} present · {summary[0]?.absent ?? 0} absent
          </span>
        </div>
      )}

      {workerId && (
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Status</th>
            <th>In</th>
            <th>Out</th>
            <th>Late</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={6} className="muted">Nothing in this period.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.work_date}</td>
              <td>
                {/* the owner's ruling outranks the raw evidence — a day
                    they marked Normal should not keep saying "App only" */}
                {(() => {
                  const d = r.decision;
                  const meta =
                    d === "NORMAL" ? { label: "Present", tone: "good" } :
                    d === "HALF_DAY" ? { label: "Half day", tone: "warn" } :
                    d === "NO_PAY" ? { label: "No pay", tone: "serious" } :
                    d === "OVERTIME" ? { label: "Overtime", tone: "good" } :
                    STATUS_META[r.status] ?? { label: r.status, tone: "neutral" };
                  return <span className={`pill ${meta.tone}`}>{meta.label}</span>;
                })()}
                {(r.review_reasons ?? []).length > 0 && (
                  <div className="muted note">
                    {(r.review_reasons ?? [])
                      .map((x) => REASON_LABEL[x] ?? x)
                      .join(", ")}
                  </div>
                )}
                {r.decision && <div className="muted note">Decided by owner</div>}
                {r.note && <div className="muted note">{r.note}</div>}
              </td>
              <td>{fmtTime(r.first_in) || "—"}</td>
              <td>{fmtTime(r.last_out) || "—"}</td>
              <td>{r.late_minutes > 0 ? `${r.late_minutes} min` : "—"}</td>
              <td className="actions">
                {pending !== r.id && needsDecision(r) && (
                  <button className="btn small primary" onClick={() => setPending(r.id)}>
                    Decide
                  </button>
                )}
                {pending !== r.id && !needsDecision(r) && r.decision && (
                  <button className="btn small" onClick={() => setPending(r.id)}>Change</button>
                )}
                {pending === r.id && (
                  <div className="decide-sheet">
                    <div className="decide-head">
                      <strong>{r.profiles?.full_name}</strong>
                      <span className="muted"> · {r.work_date}</span>
                      {(r.review_reasons ?? []).length > 0 && (
                        <div className="muted note">
                          {(r.review_reasons ?? []).map((x) => REASON_LABEL[x] ?? x).join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="decide-options">
                      {DECISIONS.map((d) => (
                        <button key={d.key} className="decide-option" onClick={() => decide(r, d.key)}>
                          <span className="decide-label">{d.label}</span>
                          <span className="decide-effect">{d.effect}</span>
                        </button>
                      ))}
                    </div>
                    <input
                      className="decide-note"
                      placeholder="Add a reason (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button
                      className="decide-cancel"
                      onClick={() => { setPending(null); setNote(""); }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
