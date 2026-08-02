// Attendance history: filter by date range / worker / status,
// approve or reject single-verification days, export CSV.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { byName, titleCase } from "../lib/text";

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
  MANUAL: { label: "Marked by owner", tone: "warn" },
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
  /** the screen opens on the exception list — that is the question it answers */
  const [seg, setSeg] = useState<"attention" | "good" | "all">("attention");
  const [query, setQuery] = useState("");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { branchId } = useBranch();

  // per-staff totals for the chosen period. A day counts as present if
  // anyone punched for it — however it was verified, and whatever the
  // owner later decided — except when the ruling was NO_PAY.
  //
  // `total` counts only days the person was expected: rest days,
  // holidays and approved leave are left out of both halves, so a week
  // with a weekly off reads "Came 6 of 6" rather than 6 of 7.
  const summary = (() => {
    const PRESENT = ["VERIFIED", "APP_ONLY", "DEVICE_ONLY", "HALF_DAY", "OVERTIME", "MANUAL"];
    const byStaff = new Map<string, { id: string; name: string; present: number; absent: number }>();
    for (const r of rows) {
      const id = r.profile_id;
      const name = r.profiles?.full_name ?? "Unknown";
      if (!byStaff.has(id)) byStaff.set(id, { id, name, present: 0, absent: 0 });
      const acc = byStaff.get(id)!;
      if (r.status === "ABSENT" || r.decision === "NO_PAY") acc.absent += 1;
      else if (PRESENT.includes(r.status)) acc.present += 1;
    }
    // mixed-case names ("MANDIP" vs "Mithu") must interleave properly
    return [...byStaff.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  })();

  const initialsOf = (name: string) =>
    name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

  const q = query.trim().toLowerCase();
  const people = summary
    .filter((s) => (seg === "attention" ? s.absent > 0 : seg === "good" ? s.absent === 0 : true))
    .filter((s) => !q || s.name.toLowerCase().includes(q));

  const missedCount = summary.filter((s) => s.absent > 0).length;
  const perfectCount = summary.length - missedCount;

  const expected = summary.reduce((t, s) => t + s.present + s.absent, 0);
  const attended = summary.reduce((t, s) => t + s.present, 0);
  const turnout = expected > 0 ? Math.round((attended / expected) * 100) : 0;

  /** "Sat 1 — Sun 2 August", or "Mon 28 July — Sat 2 August" across months */
  const rangeLabel = (() => {
    const a = new Date(`${from}T00:00:00`);
    const b = new Date(`${to}T00:00:00`);
    const wd = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "short" });
    const mo = (d: Date) => d.toLocaleDateString("en-IN", { month: "long" });
    if (from === to) return `${wd(a)} ${a.getDate()} ${mo(a)}`;
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    return sameMonth
      ? `${wd(a)} ${a.getDate()} — ${wd(b)} ${b.getDate()} ${mo(b)}`
      : `${wd(a)} ${a.getDate()} ${mo(a)} — ${wd(b)} ${b.getDate()} ${mo(b)}`;
  })();

  const dayCount = Math.max(
    1,
    Math.round(
      (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000,
    ) + 1,
  );

  /** the badge on a row. "Missed both" is the handoff's copy and only
   *  reads right on a two-day range, so it is kept for exactly that. */
  const tagFor = (s: { present: number; absent: number }) => {
    if (s.absent === 0) return { cls: "full", label: "All days" };
    if (s.present === 0)
      return { cls: "miss-all", label: s.absent === 2 ? "Missed both" : "Missed all" };
    return { cls: "miss-some", label: `Missed ${s.absent}` };
  };

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
    // Deliberately unfiltered otherwise: the list is a roll-up per
    // person, so narrowing at the database would make "Came 3 of 5"
    // count only the days that were already a problem.
    const { data, error: err } = await q;
    if (err) setError(err.message);
    setRows((data as unknown as Row[]) ?? []);
  }, [from, to, workerId, branchId]);

  useEffect(() => {
    if (!branchId) return;
    supabase
      .from("profiles").select("id, full_name, employee_code")
      .eq("role", "worker").eq("branch_id", branchId)
      // alphabetical, sorted here so mixed-case names ("MANDIP" vs
      // "Mithu") interleave properly rather than by ASCII
      .then(({ data }) => setWorkers((data ?? []).slice().sort(byName)));
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  // two-step inline confirm (no native popups — they freeze embedded
  // browsers and confuse non-technical users)
  const [pending, setPending] = useState<string | null>(null); // row id being decided
  const [note, setNote] = useState("");

  // Fixing a day nobody marked at the time. Separate from the row
  // buttons because the day in question often has no row to press.
  const [fixOpen, setFixOpen] = useState(false);
  const [fixWho, setFixWho] = useState("");
  const [fixDate, setFixDate] = useState(today());
  const [fixWhat, setFixWhat] = useState("NORMAL");
  const [fixNote, setFixNote] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const saveFix = async () => {
    if (!fixWho || !fixDate) return;
    setFixBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("fn_owner_set_day", {
      p_profile: fixWho,
      p_date: fixDate,
      p_decision: fixWhat,
      p_note: fixNote.trim() || "Set by the owner afterwards",
    });
    setFixBusy(false);
    if (err) { setError(err.message); return; }
    const who = workers.find((w) => w.id === fixWho)?.full_name ?? "Staff";
    const label = fixWhat === "NORMAL" ? "present"
      : fixWhat === "HALF_DAY" ? "a half day"
      : fixWhat === "OVERTIME" ? "overtime" : "absent";
    setNotice(`${titleCase(who)} marked ${label} for ${fixDate}.`);
    setFixOpen(false);
    setFixNote("");
    await load();
  };

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
      {/* The owner opens this to answer one question — who did not turn
          up? So the screen leads with the range, the headcount and the
          turnout, and the list underneath opens on the exceptions. */}
      <div className="sheet-head">
        <div>
          <h1>Attendance</h1>
          <p className="sub">
            {workerId
              ? "Day by day — decide any day that needs your ruling."
              : `${rangeLabel} · ${summary.length} ${summary.length === 1 ? "person" : "people"} · ${turnout}% turned up`}
          </p>
        </div>
        <div className="sheet-head-acts">
          <div className="pop-wrap">
            <button className="pill-btn" onClick={() => setRangeOpen((o) => !o)}>
              {dayCount === 1 ? "This day" : `These ${dayCount} days`} ▾
            </button>
            {rangeOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setRangeOpen(false)} />
                <div className="pop">
                  <label>
                    From
                    <input type="date" value={from} max={to}
                           onChange={(e) => setFrom(e.target.value)} />
                  </label>
                  <label>
                    To
                    <input type="date" value={to} min={from} max={today()}
                           onChange={(e) => setTo(e.target.value)} />
                  </label>
                  <button className="btn" onClick={() => setRangeOpen(false)}>Done</button>
                </div>
              </>
            )}
          </div>
          <button className="btn primary" onClick={exportCsv} disabled={rows.length === 0}>
            Download CSV
          </button>
        </div>
      </div>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}

      {fixOpen && (
        <div className="shot-zoom" onClick={() => setFixOpen(false)} role="presentation">
          <div className="entry-card" onClick={(e) => e.stopPropagation()}>
            <h3>Change a day</h3>
            <p className="muted">
              For a day nobody marked at the time. Works whether or not anything
              was recorded, and counts towards salary the same as any other day.
            </p>
            <label>
              Staff
              <select value={fixWho} onChange={(e) => setFixWho(e.target.value)}>
                <option value="">Choose a person</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>{titleCase(w.full_name)}</option>
                ))}
              </select>
            </label>
            <label>
              Day
              <input
                type="date"
                value={fixDate}
                max={today()}
                onChange={(e) => setFixDate(e.target.value)}
              />
            </label>
            <label>
              Count it as
              <select value={fixWhat} onChange={(e) => setFixWhat(e.target.value)}>
                <option value="NORMAL">Present — a full working day</option>
                <option value="HALF_DAY">Half day</option>
                <option value="OVERTIME">Overtime</option>
                <option value="NO_PAY">Absent — no pay</option>
              </select>
            </label>
            <label>
              Why (optional)
              <input
                type="text"
                value={fixNote}
                placeholder="e.g. forgot to punch, phone at home"
                onChange={(e) => setFixNote(e.target.value)}
              />
            </label>
            <div className="entry-acts">
              <button
                className="btn primary"
                disabled={!fixWho || !fixDate || fixBusy}
                onClick={saveFix}
              >
                {fixBusy ? "Saving…" : "Save"}
              </button>
              <button className="btn" onClick={() => setFixOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Thirty-six people times a month of rows is a list nobody reads,
          so this stays a roll-up per person; the day-by-day detail
          appears once you pick a name. */}
      {!workerId && (
        <>
          <div className="seg-row">
            <div className="seg" role="group" aria-label="Which people to show">
              {([
                ["attention", `Needs a look · ${missedCount}`],
                ["good", `All good · ${perfectCount}`],
                ["all", `Everyone · ${summary.length}`],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg-btn${seg === k ? " on" : ""}`}
                  aria-pressed={seg === k}
                  onClick={() => setSeg(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              className="seg-search"
              type="search"
              aria-label="Search a name"
              placeholder="Search a name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {people.map((s) => {
            const tag = tagFor(s);
            return (
              <button key={s.id} className="person-row" onClick={() => setWorkerId(s.id)}>
                <span className="avatar">{initialsOf(s.name)}</span>
                <span className="person-name">{titleCase(s.name)}</span>
                <span className="person-days">
                  Came {s.present} of {s.present + s.absent}
                </span>
                <span className="person-tag">
                  <span className={`tag ${tag.cls}`}>{tag.label}</span>
                </span>
                <span className="person-chev" aria-hidden="true">›</span>
              </button>
            );
          })}

          {people.length === 0 && (
            <div className="list-empty">
              {summary.length === 0
                ? "No attendance in this period."
                : query
                ? "No one by that name in this list."
                : seg === "attention"
                ? "Everybody turned up every day."
                : "Nobody in this list."}
            </div>
          )}

          <div className="sheet-foot">
            <span className="count">
              Showing {people.length}{" "}
              {seg === "attention"
                ? "people who missed a day"
                : seg === "good"
                ? "people with full attendance"
                : "people"}
            </span>
            <button className="btn" onClick={() => setFixOpen(true)}>Fix a day</button>
          </div>
        </>
      )}

      {workerId && (
        <div className="detail-head">
          <button className="btn small" onClick={() => setWorkerId("")}>← All staff</button>
          <strong>{titleCase(workers.find((w) => w.id === workerId)?.full_name ?? "")}</strong>
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
                      <strong>{titleCase(r.profiles?.full_name ?? "")}</strong>
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
