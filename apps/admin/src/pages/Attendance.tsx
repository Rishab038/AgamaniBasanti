// Attendance history: filter by date range / worker / status,
// approve or reject single-verification days, export CSV.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Row = {
  id: string;
  profile_id: string;
  work_date: string;
  status: string;
  first_in: string | null;
  last_out: string | null;
  late_minutes: number;
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
  LEAVE_PAID: { label: "Paid leave", tone: "info" },
  LEAVE_UNPAID: { label: "Unpaid leave", tone: "info" },
  HOLIDAY: { label: "Holiday", tone: "neutral" },
  OFF_DAY: { label: "Weekly off", tone: "neutral" },
};

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

  const load = useCallback(async () => {
    let q = supabase
      .from("attendance_days")
      .select(
        "id, profile_id, work_date, status, first_in, last_out, late_minutes, approved_by, note, profiles!attendance_days_profile_id_fkey(full_name, employee_code)",
      )
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: false });
    if (workerId) q = q.eq("profile_id", workerId);
    if (onlyProblems) q = q.in("status", ["APP_ONLY", "DEVICE_ONLY"]);
    const { data, error: err } = await q;
    if (err) setError(err.message);
    setRows((data as unknown as Row[]) ?? []);
  }, [from, to, workerId, onlyProblems]);

  useEffect(() => {
    supabase
      .from("profiles").select("id, full_name, employee_code")
      .eq("role", "worker").order("employee_code")
      .then(({ data }) => setWorkers(data ?? []));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // two-step inline confirm (no native popups — they freeze embedded
  // browsers and confuse non-technical users)
  const [pending, setPending] = useState<{ id: string; status: "VERIFIED" | "ABSENT" } | null>(null);
  const [note, setNote] = useState("");

  const decide = async (row: Row, status: "VERIFIED" | "ABSENT") => {
    setPending(null);
    const { error: err } = await supabase.rpc("fn_approve_day", {
      p_profile: row.profile_id,
      p_date: row.work_date,
      p_status: status,
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
        <p>Full history — approve or reject days that only have single verification.</p>
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
              <option key={w.id} value={w.id}>{w.employee_code} — {w.full_name}</option>
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

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Staff</th>
            <th>Status</th>
            <th>In</th>
            <th>Out</th>
            <th>Late</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={7} className="muted">Nothing in this period.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.work_date}</td>
              <td>{r.profiles?.employee_code} — {r.profiles?.full_name}</td>
              <td>
                <span className={`pill ${(STATUS_META[r.status] ?? { tone: "neutral" }).tone}`}>
                  {(STATUS_META[r.status] ?? { label: r.status }).label}
                </span>
                {r.approved_by && <span className="muted"> (owner decision)</span>}
                {r.note && <div className="muted note">{r.note}</div>}
              </td>
              <td>{fmtTime(r.first_in) || "—"}</td>
              <td>{fmtTime(r.last_out) || "—"}</td>
              <td>{r.late_minutes > 0 ? `${r.late_minutes} min` : "—"}</td>
              <td className="actions">
                {(r.status === "APP_ONLY" || r.status === "DEVICE_ONLY") && pending?.id !== r.id && (
                  <>
                    <button className="btn small" onClick={() => setPending({ id: r.id, status: "VERIFIED" })}>Approve</button>
                    <button className="btn small danger" onClick={() => setPending({ id: r.id, status: "ABSENT" })}>Reject</button>
                  </>
                )}
                {pending?.id === r.id && (
                  <>
                    <input
                      className="note-input"
                      placeholder="reason (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button
                      className={`btn small ${pending.status === "ABSENT" ? "danger" : "primary"}`}
                      onClick={() => decide(r, pending.status)}
                    >
                      Confirm {pending.status === "VERIFIED" ? "approve" : "reject"}
                    </button>
                    <button className="btn small" onClick={() => { setPending(null); setNote(""); }}>Cancel</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
