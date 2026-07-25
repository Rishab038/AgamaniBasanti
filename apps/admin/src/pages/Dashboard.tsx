// "Today at the shop" — the owner's landing page. Three counts up
// top, a live table cross-checking app check-ins against the
// fingerprint machine, and advance requests answerable in one click.

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

type DayRow = {
  id: string;
  profile_id: string;
  status: string;
  decision: string | null;
  review_reasons: string[] | null;
  late_minutes: number;
  profiles: { full_name: string; employee_code: string; device_enroll_no: number | null } | null;
};

type Device = { serial: string; last_seen_at: string | null };

type PendingAdvance = {
  id: string;
  profile_id: string;
  amount: number;
  reason: string | null;
  profiles: { full_name: string } | null;
};

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtTime = (ts: string | null | undefined) =>
  ts
    ? new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })
    : null;
const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;

export default function Dashboard() {
  const [rows, setRows] = useState<DayRow[]>([]);
  const [appFirst, setAppFirst] = useState<Record<string, string>>({});
  const [devFirst, setDevFirst] = useState<Record<number, string>>({});
  const [devices, setDevices] = useState<Device[]>([]);
  const [advances, setAdvances] = useState<PendingAdvance[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [dismissed, setDismissed] = useState<string[]>(
    () => JSON.parse(sessionStorage.getItem("dismissedAdvances") ?? "[]"),
  );
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [staffCount, setStaffCount] = useState(0);
  const { branchId, branch } = useBranch();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const load = async () => {
    if (!branchId) return;
    const today = istToday();
    const dayStartUtc = new Date(`${today}T00:00:00+05:30`).toISOString();

    // device_punches references machines by serial text rather than a
    // foreign key, so the branch filter cannot be an embedded join —
    // resolve this shop's serials first.
    const { data: devs } = await supabase
      .from("devices").select("serial, last_seen_at").eq("branch_id", branchId);
    const serials = (devs ?? []).map((d) => d.serial);

    const [att, app, dev, adv, bal, staff] = await Promise.all([
      supabase
        .from("attendance_days")
        // !inner makes the embedded profile a join, so the branch
        // filter below actually restricts the rows returned
        .select(
          "id, profile_id, status, decision, review_reasons, late_minutes, profiles!attendance_days_profile_id_fkey!inner(full_name, employee_code, device_enroll_no, branch_id)",
        )
        .eq("work_date", today)
        .eq("profiles.branch_id", branchId)
        .order("status"),
      supabase
        .from("attendance_app")
        .select("profile_id, server_ts")
        .gte("server_ts", dayStartUtc)
        .order("server_ts"),
      // Enrollment numbers restart per machine, so #70 exists at both
      // shops. Punches must be limited to THIS branch's machines or one
      // shop's fingerprint times would appear on the other's rows.
      serials.length > 0
        ? supabase
            .from("device_punches")
            .select("enroll_no, punched_at")
            .gte("punched_at", dayStartUtc)
            .in("device_serial", serials)
            .order("punched_at")
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("advances")
        .select("id, profile_id, amount, reason, profiles!advances_profile_id_fkey!inner(full_name, branch_id)")
        .eq("status", "PENDING")
        .eq("profiles.branch_id", branchId)
        .order("created_at"),
      supabase.from("advance_balances").select("profile_id, balance"),
      supabase
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("role", "worker").eq("active", true).eq("branch_id", branchId),
    ]);
    if (att.error) setError(att.error.message);
    if (adv.error) setError(adv.error.message);
    setRows((att.data as unknown as DayRow[]) ?? []);

    const af: Record<string, string> = {};
    for (const p of app.data ?? []) if (!af[p.profile_id]) af[p.profile_id] = p.server_ts;
    setAppFirst(af);
    const df: Record<number, string> = {};
    for (const p of dev.data ?? []) if (!df[p.enroll_no]) df[p.enroll_no] = p.punched_at;
    setDevFirst(df);

    setDevices(devs ?? []);
    setStaffCount(staff.count ?? 0);
    setAdvances((adv.data as unknown as PendingAdvance[]) ?? []);
    const b: Record<string, number> = {};
    for (const r of bal.data ?? []) {
      b[r.profile_id] = (b[r.profile_id] ?? 0) + Number(r.balance);
    }
    setBalances(b);
  };

  // reloads whenever the owner switches shop
  useEffect(() => {
    load();
    const ch = supabase
      .channel("today")
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_days" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const decideAdvance = async (a: PendingAdvance, approve: boolean) => {
    if (!approve) {
      // "Not now" just tucks it away for this session; it stays in Approvals
      const next = [...dismissed, a.id];
      setDismissed(next);
      sessionStorage.setItem("dismissedAdvances", JSON.stringify(next));
      return;
    }
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase
      .from("advances")
      .update({ status: "APPROVED", decided_by: me.user?.id, decided_at: new Date().toISOString() })
      .eq("id", a.id);
    if (err) setError(err.message);
    else await load();
  };

  const staleDevices = devices.filter(
    (d) => !d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 2 * 3600 * 1000,
  );
  // Anyone who punched today is present, however the day was verified.
  // Counting only VERIFIED hid every day the owner had already approved:
  // an approved day keeps status APP_ONLY (that IS what the evidence
  // was) and records the ruling in `decision`.
  const PRESENT = ["VERIFIED", "APP_ONLY", "DEVICE_ONLY", "HALF_DAY", "OVERTIME"];
  const present = rows.filter((r) => PRESENT.includes(r.status)).length;
  const late = rows.filter((r) => r.late_minutes > 0).length;
  const absent = rows.filter((r) => r.status === "ABSENT").length;
  // only days still waiting on the owner
  const needsAttention = rows.filter(
    (r) =>
      !r.decision &&
      ((r.review_reasons ?? []).length > 0 ||
        r.status === "APP_ONLY" ||
        r.status === "DEVICE_ONLY"),
  ).length;
  const visibleAdvances = advances.filter((a) => !dismissed.includes(a.id));

  const statusPill = (r: DayRow) => {
    // a decision the owner has made outranks the raw evidence
    if (r.decision === "HALF_DAY") return <span className="pill warn">Half day</span>;
    if (r.decision === "NO_PAY") return <span className="pill serious">No pay</span>;
    if (r.decision === "OVERTIME") return <span className="pill good">Overtime</span>;
    if (r.decision === "NORMAL") return <span className="pill good">Present</span>;

    if (r.status === "APP_ONLY" || r.status === "DEVICE_ONLY")
      return <span className="pill serious">Check this</span>;
    if (r.status === "ABSENT") return <span className="pill serious">Absent</span>;
    if (r.late_minutes > 0) return <span className="pill warn">Late</span>;
    if (r.status === "VERIFIED") return <span className="pill good">Verified</span>;
    if (r.status === "LEAVE_PAID" || r.status === "LEAVE_UNPAID")
      return <span className="pill neutral">On leave</span>;
    return <span className="pill neutral">{r.status === "HOLIDAY" ? "Holiday" : "Weekly off"}</span>;
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Today at {branch?.name ?? "the shop"}</h1>
          <p>{staffCount} active staff</p>
        </div>
        <span className="when">
          {now.toLocaleDateString("en-IN", {
            weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
          })}
          {" · "}
          {now.toLocaleTimeString("en-IN", {
            hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
          })}
        </span>
      </div>


      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {staleDevices.length > 0 && (
        <div className="banner warn">
          <WifiOff />
          The fingerprint machine hasn't synced for over 2 hours — check its internet.
        </div>
      )}

      <div className="stats">
        <div className="stat good">
          <div className="value">{present}</div>
          <div className="label">Checked in today</div>
        </div>
        <div className="stat amber">
          <div className="value">{needsAttention}</div>
          <div className="label">Need your decision</div>
        </div>
        <div className="stat amber">
          <div className="value">{late}</div>
          <div className="label">Late today</div>
        </div>
        <div className="stat rose">
          <div className="value">{absent}</div>
          <div className="label">Absent</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Staff</th>
            <th>App check-in</th>
            <th>Fingerprint</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty-cell">
                Nothing yet — staff appear here the moment they check in.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const appTime = fmtTime(appFirst[r.profile_id]);
            const devTime =
              r.profiles?.device_enroll_no != null
                ? fmtTime(devFirst[r.profiles.device_enroll_no])
                : null;
            return (
              <tr key={r.id}>
                <td><strong>{titleCase(r.profiles?.full_name ?? "")}</strong></td>
                <td>{appTime ?? <span className="missing">— missing</span>}</td>
                <td>{devTime ?? <span className="missing">— missing</span>}</td>
                <td>{statusPill(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {visibleAdvances.map((a) => (
        <div className="approval-card" key={a.id}>
          <div>
            <div className="who">
              {titleCase(a.profiles?.full_name ?? "")} asked for {rupees(a.amount)} advance
            </div>
            <div className="why">
              {a.reason ? `${a.reason} · ` : ""}
              balance after: {rupees((balances[a.profile_id] ?? 0) + Number(a.amount))}
            </div>
          </div>
          <div className="acts">
            <button className="btn good" onClick={() => decideAdvance(a, true)}>Approve</button>
            <button className="btn soft" onClick={() => decideAdvance(a, false)}>Not now</button>
          </div>
        </div>
      ))}
    </div>
  );
}
