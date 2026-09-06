// The app shell: three tabs (Home · Attendance · Money) and the
// shared data every tab needs — this month's attendance, today's
// punches, and advances.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Updates from "expo-updates";
// Deep import, not the barrel: `from "@expo/vector-icons"` makes
// Metro bundle the font file of EVERY icon family — thirteen of
// them, ~4.4 MB — when this app draws Ionicons and nothing else.
import Ionicons from "@expo/vector-icons/Ionicons";
import { Branch, Profile, supabase } from "../lib/supabase";
import { drain, pendingCount, stuckCount } from "../lib/queue";
import { registerForPush } from "../lib/push";
import { colors, fonts, radius } from "../lib/theme";
import HomeTab from "./tabs/HomeTab";
import AttendanceTab from "./tabs/AttendanceTab";
import MoneyTab from "./tabs/MoneyTab";
import CreditTab from "./tabs/CreditTab";
import ProfileTab from "./tabs/ProfileTab";
import SalesTab from "./tabs/SalesTab";

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
export type SharedData = {
  monthDays: DayRecord[];
  todayPunches: PunchRecord[];
  advances: AdvanceRecord[];
  /** total advance money actually handed to this worker (approved requests) */
  advancePaid: number;
  lateSyncDates: Set<string>;
  pending: number;
  /** punches the server kept refusing — not a network problem */
  stuck: number;
  reload: () => Promise<void>;
};

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const TABS = [
  { key: "home", label: "Today", icon: "ellipse-outline", iconOn: "ellipse" },
  { key: "attendance", label: "Month", icon: "grid-outline", iconOn: "grid" },
  { key: "money", label: "Money", icon: "cash-outline", iconOn: "cash" },
  // Only for whoever the owner has put on the billing counter — see
  // the filter below. A fourth tab on every worker's phone would be a
  // permanent locked door for the 34 people who cannot use it.
  { key: "credit", label: "Credit", icon: "receipt-outline", iconOn: "receipt" },

  // Off for everyone until the owner switches it on, the same way the
  // credit book is. The feature has never carried a real row, so it goes
  // to two or three phones first rather than to ninety-four.
  { key: "sales", label: "Sales", icon: "barcode-outline", iconOn: "barcode" },

  // Last, and always present. Everything the worker can look up about
  // themselves but not change — wage, shop, phone — plus the way out.
  // Sign-out used to hang off the bottom of Home, under the one control
  // the screen exists for.
  { key: "profile", label: "Me", icon: "person-outline", iconOn: "person" },
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
  // which tabs have ever been opened — see the render, below
  const [visited, setVisited] = useState<Partial<Record<TabKey, true>>>({ home: true });
  const openTab = useCallback((k: TabKey) => {
    setVisited((v) => (v[k] ? v : { ...v, [k]: true }));
    setTab(k);
  }, []);
  const [monthDays, setMonthDays] = useState<DayRecord[]>([]);
  const [todayPunches, setTodayPunches] = useState<PunchRecord[]>([]);
  const [advances, setAdvances] = useState<AdvanceRecord[]>([]);
  const [advancePaid, setAdvancePaid] = useState(0);
  const [lateSyncDates, setLateSyncDates] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [stuck, setStuck] = useState(0);

  // Every tab reads `shared`, so a reload that fetched identical rows used
  // to re-render all of them anyway: `setMonthDays(days.data)` always
  // hands React a brand-new array, and a new array is never `===` the old
  // one. With Realtime watching four tables, a burst of unrelated writes
  // meant repeated full re-renders that changed not one pixel. Comparing
  // the serialised rows costs microseconds on lists this size and lets
  // React bail out of the whole subtree.
  const lastSeen = useRef<Record<string, string>>({});
  const setIfChanged = useCallback(<T,>(key: string, value: T, apply: (v: T) => void) => {
    const json = JSON.stringify(value);
    if (lastSeen.current[key] === json) return;
    lastSeen.current[key] = json;
    apply(value);
  }, []);

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

      if (days.data) setIfChanged("days", days.data as DayRecord[], setMonthDays);
      if (punches.data) setIfChanged("punches", punches.data as PunchRecord[], setTodayPunches);
      if (adv.data) setIfChanged("adv", adv.data as AdvanceRecord[], setAdvances);
      if (bal.data) setAdvancePaid(bal.data.reduce((s, r) => s + Number(r.amount), 0));
      if (lateSync.data) {
        const dates = lateSync.data.map((r) =>
          new Date(r.server_ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
        );
        setIfChanged("lateSync", dates, (d) => setLateSyncDates(new Set(d)));
      }
    } catch {
      // offline — keep whatever we already have
    }
    setPending(pendingCount());
    setStuck(stuckCount());
  }, [profile.id, setIfChanged]);

  useEffect(() => {
    drain().then(reload);
  }, [reload]);

  useEffect(() => {
    registerForPush(profile.id);
  }, [profile.id]);

  // Live updates while the app is open. Without this the app only
  // refreshed when brought back to the foreground, so a change made
  // while the worker was watching the screen — an advance approved, a
  // day finalized, a notification sent — didn't appear until they
  // relaunched. One channel, scoped by RLS to this worker's own rows,
  // covers every table the tabs read; a short debounce collapses a
  // burst of related changes into a single reload.
  useEffect(() => {
    const filter = `profile_id=eq.${profile.id}`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        reload();
      }, 400);
    };

    const channel = supabase
      .channel(`worker:${profile.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_app", filter }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_days", filter }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "advances", filter }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter }, bump)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [profile.id, reload]);

  // Android suspends the JS engine while the app is backgrounded (this
  // is correct — an attendance app should not run in the background).
  // The bug was that nothing refreshed on the way back: reopening from
  // the recents list showed stale data until a full relaunch. Now every
  // return to the foreground drains the offline queue, reloads, and
  // quietly checks for a newer app version — no manual restart.
  const lastForeground = useRef(Date.now());
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const idleMs = Date.now() - lastForeground.current;
      lastForeground.current = Date.now();

      drain().then(reload);

      // Only look for an OTA update after a real gap, so flicking
      // between apps does not hammer the update server. Was 60s, which
      // made a freshly shipped change feel like it had not arrived;
      // 15s still filters out app-switching but reaches someone who
      // put the phone down for a moment.
      if (idleMs > 15_000 && !__DEV__) {
        try {
          const res = await Updates.checkForUpdateAsync();
          if (res.isAvailable) {
            await Updates.fetchUpdateAsync();
            await Updates.reloadAsync();
          }
        } catch {
          // offline or no update — ignore
        }
      }
    });
    return () => sub.remove();
  }, [reload]);

  // A fresh object here meant every tab saw a new `data` prop on every
  // render of this screen — including ones that changed nothing it uses
  // — and re-rendered its whole list. Now the identity only changes when
  // the contents do.
  const shared: SharedData = useMemo(
    () => ({ monthDays, todayPunches, advances, advancePaid, lateSyncDates, pending, stuck, reload }),
    [monthDays, todayPunches, advances, advancePaid, lateSyncDates, pending, stuck, reload],
  );

  const visibleTabs = TABS.filter((t) =>
    (t.key !== "credit" || profile.can_bill) &&
    (t.key !== "sales" || profile.can_log_sales));

  // If the owner withdraws billing access while the app is open, the tab
  // vanishes from under whatever is on screen — send them somewhere real
  // rather than leaving an empty body behind.
  useEffect(() => {
    if (tab === "credit" && !profile.can_bill) openTab("home");
    if (tab === "sales" && !profile.can_log_sales) openTab("home");
  }, [tab, profile.can_bill, profile.can_log_sales, openTab]);

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {/* Kept mounted once opened, hidden rather than destroyed.
            Unmounting looked tidy and was the single worst thing this
            screen did on a cheap phone: every switch back to Home tore
            down the geofence and started the location watch again, so
            the check-in button sat disabled saying "Finding your
            location…" while the GPS took its first fix — the app looking
            broken at the exact moment it is needed. Credit re-ran two
            400-row queries per visit for the same reason. A tab never
            opened still costs nothing. */}
        {visited.home && (
          <View style={tab === "home" ? styles.page : styles.pageHidden}>
            <HomeTab profile={profile} branch={branch} data={shared} active={tab === "home"} />
          </View>
        )}
        {visited.attendance && (
          <View style={tab === "attendance" ? styles.page : styles.pageHidden}>
            <AttendanceTab data={shared} />
          </View>
        )}
        {visited.money && (
          <View style={tab === "money" ? styles.page : styles.pageHidden}>
            <MoneyTab profile={profile} data={shared} />
          </View>
        )}
        {visited.sales && (
          <View style={tab === "sales" ? styles.page : styles.pageHidden}>
            <SalesTab profile={profile} branch={branch} active={tab === "sales"} />
          </View>
        )}
        {visited.credit && (
          <View style={tab === "credit" ? styles.page : styles.pageHidden}>
            <CreditTab profile={profile} branch={branch} active={tab === "credit"} />
          </View>
        )}
        {visited.profile && (
          <View style={tab === "profile" ? styles.page : styles.pageHidden}>
            <ProfileTab profile={profile} branch={branch} data={shared} />
          </View>
        )}
      </View>

      {/* One pill, the active tab filled with the accent. A floating
          pill rather than a bar because the ground runs behind it — the
          shell has no edges anywhere else either. */}
      <View style={styles.navWrap}>
        <View style={styles.nav}>
          {visibleTabs.map((t) => {
            const on = tab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.navItem, on && styles.navItemOn]}
                onPress={() => openTab(t.key)}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={on ? t.iconOn : t.icon}
                  size={17}
                  color={on ? colors.accentInk : colors.ink3}
                />
                <Text numberOfLines={1} style={[styles.navLabel, on && styles.navLabelOn]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  page: { flex: 1 },
  // `display: none` keeps the tree mounted but out of layout, so a
  // hidden tab draws nothing and measures nothing
  pageHidden: { display: "none" },
  navWrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  nav: {
    flexDirection: "row",
    gap: 4,
    padding: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  navItem: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 2,
  },
  navItemOn: { backgroundColor: colors.accent },
  navLabel: { fontFamily: fonts.semi, fontSize: 10.5, color: colors.ink3 },
  navLabelOn: { color: colors.accentInk },
});
