// Shown to any inactive account. Two very different situations:
//   approved_at null -> newly joined, waiting for the owner's approval
//   approved_at set  -> previously approved, since deactivated
// Telling an ex-employee "your request has reached the owner" would be
// misleading, so the copy branches.

import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Profile, supabase } from "../lib/supabase";
import { colors, fonts, radius, shadow } from "../lib/theme";

export default function PendingScreen({
  profile,
  onApproved,
}: {
  profile: Profile;
  onApproved: (p: Profile) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [stillWaiting, setStillWaiting] = useState(false);
  const deactivated = profile.approved_at !== null;

  const recheck = async () => {
    setChecking(true);
    setStillWaiting(false);
    const { data } = await supabase
      .from("profiles").select("*").eq("id", profile.id).single();
    setChecking(false);
    if (data?.active) onApproved(data as Profile);
    else setStillWaiting(true);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.card, shadow.card]}>
        <View style={[styles.clockCircle, deactivated && styles.pausedCircle]}>
          <Text style={styles.clockGlyph}>{deactivated ? "🔒" : "⏳"}</Text>
        </View>
        <Text style={styles.title}>Namaste, {profile.full_name.split(" ")[0]}!</Text>
        <Text style={styles.body}>
          {deactivated
            ? "Your attendance account is paused right now. Please speak to the shop owner."
            : "Your request has reached the owner. Once they approve it, you can start marking your attendance here."}
        </Text>
        <Pressable style={styles.button} onPress={recheck} disabled={checking}>
          {checking
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Check again</Text>}
        </Pressable>
        {stillWaiting && (
          <Text style={styles.waiting}>
            {deactivated
              ? "Still paused — please check with the owner."
              : "Not approved yet — try again in a while."}
          </Text>
        )}
      </View>
      <Pressable onPress={() => supabase.auth.signOut()}>
        <Text style={styles.logout}>Log out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: 26 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 30,
    alignItems: "center",
  },
  clockCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: colors.amberBg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  pausedCircle: { backgroundColor: colors.roseBg },
  clockGlyph: { fontSize: 34 },
  title: { fontFamily: fonts.black, fontSize: 23, color: colors.ink, textAlign: "center" },
  body: {
    fontFamily: fonts.semi,
    fontSize: 14.5,
    color: colors.ink2,
    textAlign: "center",
    lineHeight: 21,
    marginTop: 8,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    paddingHorizontal: 34,
    marginTop: 20,
  },
  buttonText: { fontFamily: fonts.extra, color: "#fff", fontSize: 15 },
  waiting: { fontFamily: fonts.bold, color: colors.amber, fontSize: 13, marginTop: 12 },
  logout: {
    fontFamily: fonts.bold,
    textAlign: "center",
    color: colors.ink3,
    fontSize: 13.5,
    padding: 16,
  },
});
