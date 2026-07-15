// Attendance tab — this month as a calendar. Green = present,
// amber = late or leave, rose = absent, ring = synced late (was
// saved offline). A legend explains every mark.

import { StyleSheet, ScrollView, Text, View } from "react-native";
import { colors, fonts, radius, shadow } from "../../lib/theme";
import type { SharedData } from "../MainScreen";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

type DayCell = { day: number; date: string } | null;

function monthGrid(): DayCell[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const cells: DayCell[] = Array(first).fill(null);
  for (let d = 1; d <= count; d++) {
    cells.push({
      day: d,
      date: `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    });
  }
  return cells;
}

function dotFor(status: string | undefined, late: number): string | null {
  if (!status) return null;
  if (status === "ABSENT") return colors.rose;
  if (["LEAVE_PAID", "LEAVE_UNPAID"].includes(status)) return colors.amber;
  if (["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(status)) {
    return late > 0 ? colors.amber : colors.good;
  }
  return null; // HOLIDAY / OFF_DAY — no dot, day stays quiet
}

export default function AttendanceTab({ data }: { data: SharedData }) {
  const byDate = new Map(data.monthDays.map((d) => [d.work_date, d]));
  const cells = monthGrid();
  const today = new Date().getDate();
  const monthName = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const late = data.monthDays.filter((d) => d.late_minutes > 0).length;
  const absent = data.monthDays.filter((d) => d.status === "ABSENT").length;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>My attendance</Text>
      <Text style={styles.sub}>{monthName}</Text>

      <View style={[styles.card, shadow.card]}>
        <View style={styles.weekRow}>
          {WEEKDAYS.map((w, i) => (
            <Text key={i} style={styles.weekday}>{w}</Text>
          ))}
        </View>
        <View style={styles.grid}>
          {cells.map((cell, i) => {
            if (!cell) return <View key={i} style={styles.cell} />;
            const rec = byDate.get(cell.date);
            const dot = dotFor(rec?.status, rec?.late_minutes ?? 0);
            const lateSync = data.lateSyncDates.has(cell.date);
            return (
              <View key={i} style={styles.cell}>
                <View style={[styles.dayWrap, cell.day === today && styles.todayWrap]}>
                  <Text style={[styles.dayText, cell.day === today && styles.todayText]}>
                    {cell.day}
                  </Text>
                </View>
                <View style={styles.markRow}>
                  {dot ? (
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: dot },
                        lateSync && styles.dotRinged,
                      ]}
                    />
                  ) : (
                    <View style={styles.dotEmpty} />
                  )}
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View style={[styles.card, shadow.card]}>
        <Text style={styles.legendTitle}>WHAT THE DOTS MEAN</Text>
        <View style={styles.legendRow}>
          <View style={[styles.dot, { backgroundColor: colors.good }]} />
          <Text style={styles.legendText}>Present</Text>
        </View>
        <View style={styles.legendRow}>
          <View style={[styles.dot, { backgroundColor: colors.amber }]} />
          <Text style={styles.legendText}>Late or on leave</Text>
        </View>
        <View style={styles.legendRow}>
          <View style={[styles.dot, { backgroundColor: colors.rose }]} />
          <Text style={styles.legendText}>Absent</Text>
        </View>
        <View style={styles.legendRow}>
          <View style={[styles.dot, { backgroundColor: colors.good }, styles.dotRinged]} />
          <Text style={styles.legendText}>Sent late (no internet at the time)</Text>
        </View>
      </View>

      <View style={styles.tiles}>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, { color: colors.good }]}>{worked}</Text>
          <Text style={styles.tileLabel}>present</Text>
        </View>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, { color: colors.amber }]}>{late}</Text>
          <Text style={styles.tileLabel}>late</Text>
        </View>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, { color: colors.rose }]}>{absent}</Text>
          <Text style={styles.tileLabel}>absent</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 22, paddingTop: 62, paddingBottom: 26 },
  title: { fontFamily: fonts.black, fontSize: 26, color: colors.ink, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.semi, fontSize: 14, color: colors.ink3, marginTop: 2, marginBottom: 14 },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 16,
    marginBottom: 14,
  },
  weekRow: { flexDirection: "row", marginBottom: 6 },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontFamily: fonts.extra,
    fontSize: 12,
    color: colors.ink3,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 5 },
  dayWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  todayWrap: { backgroundColor: colors.accentSoft },
  dayText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink2 },
  todayText: { color: colors.accent, fontFamily: fonts.black },
  markRow: { height: 12, justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotRinged: {
    borderWidth: 2,
    borderColor: colors.amber,
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotEmpty: { width: 8, height: 8 },

  legendTitle: {
    fontFamily: fonts.extra,
    fontSize: 11,
    color: colors.ink3,
    letterSpacing: 1,
    marginBottom: 10,
  },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  legendText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink2 },

  tiles: { flexDirection: "row", gap: 10 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  tileValue: { fontFamily: fonts.black, fontSize: 21 },
  tileLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.ink3, marginTop: 2 },
});
