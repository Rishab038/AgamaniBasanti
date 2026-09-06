// Me — what the shop holds about this person, and the way out.
//
// Read-only by design. Wage, shop and shift are the owner's to set, and
// a worker editing any of them here would be editing the thing their
// pay is calculated from. So this screen answers questions rather than
// taking answers: what am I paid, where do I punch, when is my shift,
// what number does the OTP go to.
//
// It exists mostly to get sign-out off the Home screen, where it sat
// directly under the one control that screen is for.

import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Branch, Profile, supabase } from "../../lib/supabase";
import { colors, fonts, radius } from "../../lib/theme";
import type { SharedData } from "../MainScreen";

const fmtShiftTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "am" : "pm";
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};

export default function ProfileTab({
  profile,
  branch,
  data,
}: {
  profile: Profile;
  branch: Branch;
  data: SharedData;
}) {
  const initials = profile.full_name.trim()[0]?.toUpperCase() ?? "?";

  const shift =
    profile.shift_start
      ? `${fmtShiftTime(profile.shift_start)} – ${fmtShiftTime(profile.shift_end ?? "")}`
      : "Not set";

  // Salary is deliberately absent. The worker app never shows a pay
  // figure — there is no payslip context around it here, and a number
  // without its deductions starts arguments the app cannot settle.
  const rows: { label: string; help: string; value: string }[] = [
    { label: "Phone", help: "Where the login code is sent", value: profile.phone ?? "—" },
    { label: "Shop", help: "Where you punch", value: branch.name },
    { label: "Shift", help: "Set by the owner", value: shift },
    {
      label: "Advance taken",
      help: "Recovered from your pay, oldest first",
      value: `₹${data.advancePaid.toLocaleString("en-IN")}`,
    },
  ];

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{profile.full_name}</Text>
        <Text style={styles.meta}>{branch.name}</Text>
      </View>

      <View style={styles.card}>
        {rows.map((r, i) => (
          <View key={r.label} style={[styles.row, i > 0 && styles.rowEdge]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              {!!r.help && <Text style={styles.rowHelp}>{r.help}</Text>}
            </View>
            <Text style={styles.rowValue}>{r.value}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity
        style={styles.signOut}
        activeOpacity={0.8}
        onPress={() => supabase.auth.signOut()}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, paddingTop: 22 },

  head: { alignItems: "center", gap: 14, paddingVertical: 20, paddingBottom: 26 },
  avatar: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: colors.accentSoft,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.extra, fontSize: 34, color: colors.accentLight },
  name: {
    fontFamily: fonts.semi, fontSize: 26, lineHeight: 29,
    letterSpacing: -0.8, color: colors.ink, textAlign: "center",
  },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink3 },

  card: {
    borderRadius: radius.lg, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line, paddingHorizontal: 20,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 17, minHeight: 62 },
  rowEdge: { borderTopWidth: 1, borderTopColor: colors.line },
  rowLabel: { fontFamily: fonts.semi, fontSize: 14.5, lineHeight: 18, color: colors.ink },
  rowHelp: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 5 },
  rowValue: { fontFamily: fonts.extra, fontSize: 14, color: colors.ink2 },

  signOut: {
    marginTop: 12, minHeight: 56, borderRadius: radius.md,
    backgroundColor: colors.track,
    alignItems: "center", justifyContent: "center",
  },
  signOutText: { fontFamily: fonts.extra, fontSize: 14.5, color: colors.ink2 },
});
