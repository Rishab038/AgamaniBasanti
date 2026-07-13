// "Today" board — the owner's landing page. Live attendance for
// today plus the two things that must never be silent: a stale
// fingerprint-machine heartbeat and punches needing attention.

import { useEffect, useState } from "react";
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

const STATUS_LABEL: Record<string, string> = {
  VERIFIED: "✅ Present (verified)",
  APP_ONLY: "⚠️ App only — no fingerprint",
  DEVICE_ONLY: "⚠️ Fingerprint only — no app",
  ABSENT: "❌ Absent",
  LEAVE_PAID: "🌴 Paid leave",
  LEAVE_UNPAID: "🌴 Unpaid leave",
  HOLIDAY: "🎉 Holiday",
  OFF_DAY: "🛌 Weekly off",
};

const fmtTime = (ts: string | null) =>
  ts ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";

export default function Dashboard() {
  const [rows, setRows] = useState<DayRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pendingAdvances, setPendingAdvances] = useState(0);

  const load = async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [att, dev, adv] = await Promise.all([
      supabase
        .from("attendance_days")
        .select("id, status, first_in, last_out, late_minutes, profiles(full_name, employee_code)")
        .eq("work_date", today)
        .order("status"),
      supabase.from("devices").select("serial, model, last_seen_at"),
      supabase.from("advances").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
    ]);
    setRows((att.data as unknown as DayRow[]) ?? []);
    setDevices(dev.data ?? []);
    setPendingAdvances(adv.count ?? 0);
  };

  useEffect(() => {
    load();
    // live refresh whenever any punch lands
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
  const needsAttention = rows.filter((r) => r.status === "APP_ONLY" || r.status === "DEVICE_ONLY");

  return (
    <div>
      <h1>Today</h1>

      {staleDevices.length > 0 && (
        <div className="banner warn">
          ⚠️ Fingerprint machine {staleDevices.map((d) => d.serial).join(", ")} has not synced
          for over 2 hours. Check the machine's internet.
        </div>
      )}
      {needsAttention.length > 0 && (
        <div className="banner warn">
          {needsAttention.length} attendance record(s) need your attention (single verification only).
        </div>
      )}
      {pendingAdvances > 0 && (
        <div className="banner info">
          💰 {pendingAdvances} advance request(s) waiting for approval.
        </div>
      )}

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
              <td colSpan={5} className="muted">
                No attendance yet today.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.profiles?.full_name}{" "}
                <span className="muted">({r.profiles?.employee_code})</span>
              </td>
              <td>{STATUS_LABEL[r.status] ?? r.status}</td>
              <td>{fmtTime(r.first_in)}</td>
              <td>{fmtTime(r.last_out)}</td>
              <td>{r.late_minutes > 0 ? `${r.late_minutes} min` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
