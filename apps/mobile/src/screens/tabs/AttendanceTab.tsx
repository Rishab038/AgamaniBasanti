// Month — this month's attendance, in the same three colours the owner
// sees on the dashboard. That is the whole point of the screen: there
// is nothing to argue about later if both sides have been reading the
// same marks all along.
//
// Mint = worked. Amber = late, on leave, or the owner ruled on it.
// Grey = shop closed or not worked. A day still to come is left blank
// rather than marked, because "no record yet" is not an absence.
//
// The mark is an underline, not a dot: at 3px tall under the number it
// reads at a glance across a whole grid without crowding the digits.

import { StyleSheet, ScrollView, Text, View } from "react-native";
import { colors, fonts, radius } from "../../lib/theme";
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

/** The colour of a day's underline, or null for a day with nothing to say. */
function markFor(status: string | undefined, late: number): string | null {
  if (!status) return null;
  if (status === "ABSENT") return colors.mute;
  if (["LEAVE_PAID", "LEAVE_UNPAID"].includes(status)) return colors.amber;
  if (["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(status)) {
    return late > 0 ? colors.amber : colors.good;
  }
  return colors.mute; // HOLIDAY / OFF_DAY — shop closed
}

export default function AttendanceTab({ data }: { data: SharedData }) {
  const byDate = new Map(data.monthDays.map((d) => [d.work_date, d]));
  const cells = monthGrid();
  const today = new Date().getDate();
  const monthName = new Date()
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" })
    .toUpperCase();

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const late = data.monthDays.filter((d) => d.late_minutes > 0).length;
  const absent = data.monthDays.filter((d) => d.status === "ABSENT").length;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scroll}>
      <View style={styles.head}>
        <Text style={styles.kicker}>{monthName}</Text>
        <Text style={styles.title}>My month</Text>
      </View>

      <View style={styles.tiles}>
        <View style={styles.tile}>
          <Text style={styles.tileValue}>{worked}</Text>
          <Text style={styles.tileLabel}>Present</Text>
        </View>
        <View style={[styles.tile, styles.tileWarn]}>
          <Text style={[styles.tileValue, styles.tileValueWarn]}>{late}</Text>
          <Text style={styles.tileLabel}>Late</Text>
        </View>
        <View style={styles.tile}>
          <Text style={styles.tileValue}>{absent}</Text>
          <Text style={styles.tileLabel}>Absent</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.grid}>
          {WEEKDAYS.map((w, i) => (
            <View key={`w${i}`} style={styles.cell}>
              <Text style={styles.weekday}>{w}</Text>
            </View>
          ))}
          {cells.map((cell, i) => {
            if (!cell) return <View key={i} style={[styles.cell, styles.cellDay]} />;
            const rec = byDate.get(cell.date);
            const mark = cell.day <= today ? markFor(rec?.status, rec?.late_minutes ?? 0) : null;
            const lateSync = data.lateSyncDates.has(cell.date);
            const isToday = cell.day === today;
            return (
              <View key={i} style={[styles.cell, styles.cellDay]}>
                <View style={[styles.day, isToday && styles.dayToday]}>
                  <Text style={[styles.dayText, isToday && styles.dayTextToday]}>{cell.day}</Text>
                  <View
                    style={[
                      styles.mark,
                      mark ? { backgroundColor: mark } : styles.markNone,
                      // a day that reached the server late still counts;
                      // the hollow mark just says why its time looks odd
                      lateSync && styles.markLate,
                    ]}
                  />
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.legend}>
        {[
          { color: colors.good, label: "Worked the full day" },
          { color: colors.amber, label: "Late, on leave, or the owner ruled on it" },
          { color: colors.mute, label: "Shop closed, or not worked" },
        ].map((l) => (
          <View key={l.label} style={styles.legendRow}>
            <View style={[styles.legendMark, { backgroundColor: l.color }]} />
            <Text style={styles.legendText}>{l.label}</Text>
          </View>
        ))}
        <View style={styles.legendRow}>
          <View style={[styles.legendMark, styles.markLate, { backgroundColor: colors.good }]} />
          <Text style={styles.legendText}>Sent late — there was no internet at the time</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, paddingTop: 22, paddingBottom: 24 },

  head: { paddingHorizontal: 6, paddingBottom: 20 },
  kicker: { fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.5, color: colors.ink3 },
  title: {
    fontFamily: fonts.semi, fontSize: 34, lineHeight: 36,
    letterSpacing: -1.2, color: colors.ink, marginTop: 10,
  },

  tiles: { flexDirection: "row", gap: 8 },
  tile: {
    flex: 1, borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    paddingVertical: 18, paddingHorizontal: 16,
  },
  tileWarn: { backgroundColor: colors.amberBg, borderColor: "rgba(229,165,82,0.22)" },
  tileValue: { fontFamily: fonts.extra, fontSize: 32, letterSpacing: -1.1, color: colors.ink },
  tileValueWarn: { color: colors.amber },
  tileLabel: { fontFamily: fonts.semi, fontSize: 11, color: colors.ink3, marginTop: 9 },

  card: {
    borderRadius: radius.lg, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: 12, paddingTop: 14, paddingBottom: 10, marginTop: 12,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, paddingHorizontal: 2, paddingBottom: 4 },
  cellDay: { paddingBottom: 4 },
  weekday: {
    textAlign: "center", fontFamily: fonts.semi, fontSize: 10.5,
    letterSpacing: 0.6, color: colors.mute, paddingBottom: 8,
  },
  day: {
    aspectRatio: 1, borderRadius: 10,
    alignItems: "center", justifyContent: "center", gap: 5,
  },
  dayToday: { backgroundColor: colors.accentSoft },
  dayText: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2 },
  dayTextToday: { fontFamily: fonts.extra, color: colors.accentLight },
  mark: { width: 14, height: 3, borderRadius: 2 },
  markNone: { backgroundColor: "transparent" },
  markLate: { width: 14, height: 3, borderRadius: 2, opacity: 0.45 },

  legend: {
    borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: 18, paddingVertical: 6, marginTop: 12,
  },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  legendMark: { width: 20, height: 3, borderRadius: 2 },
  legendText: { flex: 1, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.ink2 },
});
