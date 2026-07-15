// "Today" board — the owner's landing page. KPI tiles up top,
// live attendance below, and banners for the two things that must
// never be silent: a stale fingerprint machine and punches needing
// attention. Status always reads as dot + label, never color alone.

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CalendarX2,
  Clock4,
  UserCheck,
  Wallet,
  WifiOff,
} from "lucide-react";
import { supabase } from "../lib/supabase";

type DayRow = {
  id: string;
  status: string;
  first_in: string | null;
  last_out: string | null;
  late_minutes: number;
  profiles: { full_name: string; employee_code: string } | null;
};

type Device = { serial: string; model: string | null; last_seen_at: string | null };

const STATUS_META: Record<string, { label: string; tone: string }> = {
  VERIFIED: { label: "Present · verified", tone: "good" },
  APP_ONLY: { label: "App only — no fingerprint", tone: "warn" },
  DEVICE_ONLY: { label: "Fingerprint only — no app", tone: "warn" },
  ABSENT: { label: "Absent", tone: "serious" },
  LEAVE_PAID: { label: "Paid leave", tone: "info" },
  LEAVE_UNPAID: { label: "Unpaid leave", tone: "info" },
  HOLIDAY: { label: "Holiday", tone: "neutral" },
  OFF_DAY: { label: "Weekly off", tone: "neutral" },
};

const fmtTime = (ts: string | null) =>
  ts ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";

export default function Dashboard() {
  const [rows, setRows] = useState<DayRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pendingAdvances, setPendingAdvances] = useState(0);
  const [staffCount, setStaffCount] = useState(0);

  const load = async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [att, dev, adv, staff] = await Promise.all([
      supabase
        .from("attendance_days")
        .select(
          "id, status, first_in, last_out, late_minutes, profiles!attendance_days_profile_id_fkey(full_name, employee_code)",
        )
        .eq("work_date", today)
        .order("status"),
      supabase.from("devices").select("serial, model, last_seen_at"),
      supabase.from("advances").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
      supabase
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("role", "worker").eq("active", true),
    ]);
    if (att.error) console.error("attendance query failed:", att.error);
    if (dev.error) console.error("devices query failed:", dev.error);
    setRows((att.data as unknown as DayRow[]) ?? []);
    setDevices(dev.data ?? []);
    setPendingAdvances(adv.count ?? 0);
    setStaffCount(staff.count ?? 0);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel("today")
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_days" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  const staleDevices = devices.filter(
    (d) => !d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 2 * 3600 * 1000,
  );
  const present = rows.filter((r) => r.status === "VERIFIED").length;
  const needsAttention = rows.filter((r) => r.status === "APP_ONLY" || r.status === "DEVICE_ONLY");
  const late = rows.filter((r) => r.late_minutes > 0).length;
  const absent = rows.filter((r) => r.status === "ABSENT").length;

  return (
    <div>
      <div className="page-head">
        <h1>Today</h1>
        <p>
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata",
          })}
          {" · "}{staffCount} active staff
        </p>
      </div>

      {staleDevices.length > 0 && (
        <div className="banner warn">
          <WifiOff />
          Fingerprint machine {staleDevices.map((d) => d.serial).join(", ")} has not synced for
          over 2 hours — check the machine's internet.
        </div>
      )}
      {pendingAdvances > 0 && (
        <div className="banner info">
          <Wallet />
          {pendingAdvances} advance request{pendingAdvances > 1 ? "s" : ""} waiting for your approval.
        </div>
      )}

      <div className="stats">
        <div className="stat good">
          <div className="label"><UserCheck /> Present</div>
          <div className="value">{present}</div>
        </div>
        <div className="stat warn">
          <div className="label"><AlertTriangle /> Needs attention</div>
          <div className="value">{needsAttention.length}</div>
        </div>
        <div className="stat info">
          <div className="label"><Clock4 /> Late arrivals</div>
          <div className="value">{late}</div>
        </div>
        <div className="stat serious">
          <div className="label"><CalendarX2 /> Absent</div>
          <div className="value">{absent}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Staff</th>
            <th>Status</th>
            <th>In</th>
            <th>Out</th>
            <th>Late</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty-cell">
                No attendance yet today — punches appear here live as staff check in.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const meta = STATUS_META[r.status] ?? { label: r.status, tone: "neutral" };
            return (
              <tr key={r.id}>
                <td>
                  <strong>{r.profiles?.full_name}</strong>{" "}
                  <span className="muted">({r.profiles?.employee_code})</span>
                </td>
                <td><span className={`pill ${meta.tone}`}>{meta.label}</span></td>
                <td>{fmtTime(r.first_in)}</td>
                <td>{fmtTime(r.last_out)}</td>
                <td>{r.late_minutes > 0 ? `${r.late_minutes} min` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
