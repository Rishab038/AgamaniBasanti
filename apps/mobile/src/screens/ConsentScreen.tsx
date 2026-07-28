// Shown once, before a worker's first check-in.
//
// India's DPDP Act requires that people are told, in plain language
// they actually understand, what personal data is collected and why —
// before it is collected. So this is deliberately short, concrete and
// free of legal boilerplate, and the acknowledgement is recorded
// against the profile rather than assumed.
//
// The check-in photo is back, so this screen has to say so — it
// previously promised "the app never takes your picture", and leaving
// that in place while quietly shipping a camera would be exactly the
// kind of thing the Act exists to prevent. The wording below states
// what is taken, why, and that it is deleted after two days.

import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Profile, supabase } from "../lib/supabase";
import { colors, fonts, radius, shadow } from "../lib/theme";

const POINTS = [
  {
    icon: "📍",
    title: "Your location when you punch",
    body: "Only at that moment, to confirm you are at the shop. The app does not follow you at any other time.",
  },
  {
    icon: "🕒",
    title: "The time of each entry",
    body: "Your check-in, lunch break and check-out — nothing else.",
  },
  {
    icon: "📷",
    title: "A photo when you check in",
    body: "Only at check-in, and only to show you were at the shop if the location check is unclear. It is deleted after 2 days. You can check in without it.",
  },
  {
    icon: "👤",
    title: "Who can see it",
    body: "Only the shop owner. Other staff can never see your attendance, salary or advances.",
  },
];

export default function ConsentScreen({
  profile,
  onAccepted,
}: {
  profile: Profile;
  onAccepted: (p: Profile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("fn_record_consent");
    if (err) {
      setError("Could not save. Please check your internet and try again.");
      setBusy(false);
      return;
    }
    const { data } = await supabase
      .from("profiles").select("*").eq("id", profile.id).single();
    setBusy(false);
    if (data) onAccepted(data as Profile);
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Before you start</Text>
        <Text style={styles.sub}>
          Namaste {profile.full_name.split(" ")[0]} — here is exactly what this app records.
        </Text>

        <View style={[styles.card, shadow.card]}>
          {POINTS.map((p, i) => (
            <View key={i} style={[styles.row, i > 0 && styles.rowDivider]}>
              <Text style={styles.icon}>{p.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{p.title}</Text>
                <Text style={styles.rowBody}>{p.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.why}>
          This is what proves your attendance fairly — for you as much as for the shop.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={accept} disabled={busy}>
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>I understand — continue</Text>}
        </Pressable>

        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text style={styles.logout}>Not now, log out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingTop: 64, paddingBottom: 30 },
  title: { fontFamily: fonts.black, fontSize: 27, color: colors.ink, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.semi, fontSize: 14.5, color: colors.ink2, marginTop: 6, lineHeight: 21 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 6,
    marginTop: 20,
  },
  row: { flexDirection: "row", gap: 14, padding: 16, alignItems: "flex-start" },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  icon: { fontSize: 24, marginTop: 1 },
  rowTitle: { fontFamily: fonts.extra, fontSize: 15.5, color: colors.ink },
  rowBody: { fontFamily: fonts.semi, fontSize: 13.5, color: colors.ink2, marginTop: 3, lineHeight: 19 },
  why: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.ink2,
    textAlign: "center",
    marginTop: 20,
    paddingHorizontal: 10,
    lineHeight: 20,
  },
  error: { fontFamily: fonts.bold, color: colors.serious, fontSize: 13.5, textAlign: "center", marginTop: 14 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 22,
  },
  buttonDisabled: { backgroundColor: colors.line2 },
  buttonText: { fontFamily: fonts.extra, color: "#fff", fontSize: 16 },
  logout: {
    fontFamily: fonts.bold,
    textAlign: "center",
    color: colors.ink3,
    fontSize: 13.5,
    padding: 18,
  },
});
