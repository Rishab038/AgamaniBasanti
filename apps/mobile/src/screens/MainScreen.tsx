// The app shell: three tabs (Home · Attendance · Money) and the
// shared data every tab needs — this month's attendance, today's
// punches, advances, and the worker's shift.

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Branch, Profile, supabase } from "../lib/supabase";
import { drain, pendingCount } from "../lib/queue";
import { registerForPush } from "../lib/push";
import { colors, fonts, radius, shadow } from "../lib/theme";
import HomeTab from "./tabs/HomeTab";
import AttendanceTab from "./tabs/AttendanceTab";
import MoneyTab from "./tabs/MoneyTab";

export type DayRecord = { work_date: string; status: string; late_minutes: number };
export type PunchKind = "ARRIVAL" | "LUNCH_OUT" | "LUNCH_IN" | "DEPARTURE";
export type PunchRecord = {
  direction: "IN" | "OUT";
  server_ts: string;
  punch_kind: PunchKind | null;
};
export type AdvanceRecord = {
  id: string;
  amount: number;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
};
export type ShiftInfo = { name: string; start_time: string; end_time: string } | null;

export type SharedData = {
  monthDays: DayRecord[];
  todayPunches: PunchRecord[];
  advances: AdvanceRecord[];
  /** total advance money actually handed to this worker (approved requests) */
  advancePaid: number;
  lateSyncDates: Set<string>;
  shift: ShiftInfo;
  pending: number;
  reload: () => Promise<void>;
};

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const TABS = [
  { key: "home", label: "Home", icon: "home-outline", iconOn: "home" },
  { key: "attendance", label: "Attendance", icon: "calendar-outline", iconOn: "calendar" },
  { key: "money", label: "Money", icon: "wallet-outline", iconOn: "wallet" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function MainScreen({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [tab, setTab] = useState<TabKey>("home");
  const [monthDays, setMonthDays] = useState<DayRecord[]>([]);
  const [todayPunches, setTodayPunches] = useState<PunchRecord[]>([]);
  const [advances, setAdvances] = useState<AdvanceRecord[]>([]);
  const [advancePaid, setAdvancePaid] = useState(0);
  const [lateSyncDates, setLateSyncDates] = useState<Set<string>>(new Set());
  const [shift, setShift] = useState<ShiftInfo>(null);
  const [pending, setPending] = useState(0);

  const reload = useCallback(async () => {
    try {
      const monthStart = `${istToday().slice(0, 7)}-01`;
      const monthStartUtc = new Date(`${monthStart}T00:00:00+05:30`).toISOString();
      const dayStartUtc = new Date(`${istToday()}T00:00:00+05:30`).toISOString();

      const [days, punches, adv, bal, lateSync] = await Promise.all([
        supabase
          .from("attendance_days")
          .select("work_date, status, late_minutes")
          .eq("profile_id", profile.id)
          .gte("work_date", monthStart),
        supabase
          .from("attendance_app")
          .select("direction, server_ts, punch_kind")
          .eq("profile_id", profile.id)
          .gte("server_ts", dayStartUtc)
          .order("server_ts"),
        supabase
          .from("advances")
          .select("id, amount, reason, status, created_at")
          .eq("profile_id", profile.id)
          .order("created_at", { ascending: false })
          .limit(20),
        // total advance money handed over, not the outstanding balance:
        // salary figures are deliberately not shown in the worker app, so a
        // "still owed" number would have no context to make sense against
        supabase
          .from("advances")
          .select("amount")
          .eq("profile_id", profile.id)
          .eq("status", "APPROVED"),
        supabase
          .from("attendance_app")
          .select("server_ts")
          .eq("profile_id", profile.id)
          .eq("synced_late", true)
          .gte("server_ts", monthStartUtc),
      ]);

      if (days.data) setMonthDays(days.data as DayRecord[]);
      if (punches.data) setTodayPunches(punches.data as PunchRecord[]);
      if (adv.data) setAdvances(adv.data as AdvanceRecord[]);
      if (bal.data) setAdvancePaid(bal.data.reduce((s, r) => s + Number(r.amount), 0));
      if (lateSync.data) {
        setLateSyncDates(
          new Set(
            lateSync.data.map((r) =>
              new Date(r.server_ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
            ),
          ),
        );
      }
    } catch {
      // offline — keep whatever we already have
    }
    setPending(pendingCount());
  }, [profile.id]);

  useEffect(() => {
    drain().then(reload);
  }, [reload]);

  useEffect(() => {
    registerForPush(profile.id);
  }, [profile.id]);

  useEffect(() => {
    if (!shift && profile.shift_id) {
      supabase
        .from("shifts")
        .select("name, start_time, end_time")
        .eq("id", profile.shift_id)
        .single()
        .then(({ data }) => setShift(data));
    }
  }, [profile.shift_id, shift]);

  const shared: SharedData = {
    monthDays, todayPunches, advances, advancePaid, lateSyncDates, shift, pending, reload,
  };

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {tab === "home" && <HomeTab profile={profile} branch={branch} data={shared} />}
        {tab === "attendance" && <AttendanceTab data={shared} />}
        {tab === "money" && <MoneyTab profile={profile} data={shared} />}
      </View>

      <View style={[styles.tabBar, shadow.card]}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tabItem}
              onPress={() => setTab(t.key)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={active ? t.iconOn : t.icon}
                size={22}
                color={active ? colors.accent : colors.ink3}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 10,
    paddingBottom: 22,
  },
  tabItem: { flex: 1, alignItems: "center", gap: 4 },
  tabLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.ink3 },
  tabLabelActive: { color: colors.accent },
});
