// Money tab — advances only.
//
// Salary figures are deliberately absent from the worker app. A running
// estimate computed from attendance will rarely match the owner's final
// payslip (leave policy, adjustments, rounding), and a worker who has
// watched a number climb all month will treat any difference as a
// shortfall. The owner remains the single source of truth on pay; the
// app's job is to be honest about attendance and advances.

import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Profile, supabase } from "../../lib/supabase";
import { colors, fonts, radius, shadow } from "../../lib/theme";
import { groupInr } from "../../lib/fmt";
import type { SharedData } from "../MainScreen";

// advances are shown to the nearest rupee
const rupees = (n: number) => `₹${groupInr(Math.round(n))}`;

export default function MoneyTab({ profile, data }: { profile: Profile; data: SharedData }) {
  const [askOpen, setAskOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const absent = data.monthDays.filter((d) => d.status === "ABSENT").length;

  const submitAsk = async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return;
    setBusy(true);
    const { error } = await supabase.from("advances").insert({
      profile_id: profile.id,
      amount: amt,
      reason: reason.trim() || null,
      status: "PENDING",
    });
    setBusy(false);
    if (error) {
      setNotice("Could not send the request. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNotice("Request sent — the owner will see it right away.");
      setAskOpen(false);
      setAmount("");
      setReason("");
      await data.reload();
    }
  };

  const pillFor = (status: string) =>
    status === "APPROVED"
      ? { bg: colors.goodBg, fg: colors.good, label: "Approved" }
      : status === "REJECTED"
        ? { bg: colors.roseBg, fg: colors.rose, label: "Not approved" }
        : { bg: colors.amberBg, fg: colors.amber, label: "Waiting" };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>My money</Text>
      <Text style={styles.sub}>
        {new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
      </Text>

      {notice && (
        <Pressable style={styles.noticeBanner} onPress={() => setNotice(null)}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      )}

      {/* advance */}
      <View style={[styles.card, shadow.card]}>
        <Text style={styles.cardLabel}>ADVANCE PAID</Text>
        <Text style={[styles.bigMoney, data.advancePaid > 0 && { color: colors.accent }]}>
          {rupees(data.advancePaid)}
        </Text>
        <Text style={styles.cardHint}>
          {data.advancePaid > 0
            ? "Total advance the shop has given you so far."
            : "You have not taken any advance yet."}
        </Text>

        {!askOpen ? (
          <Pressable style={styles.askButton} onPress={() => setAskOpen(true)}>
            <Text style={styles.askButtonText}>Ask for advance</Text>
          </Pressable>
        ) : (
          <View style={styles.askForm}>
            <Text style={styles.fieldLabel}>How much do you need?</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 1500"
              placeholderTextColor={colors.ink3}
              keyboardType="number-pad"
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/\D/g, ""))}
            />
            <Text style={styles.fieldLabel}>What is it for? (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. school fees"
              placeholderTextColor={colors.ink3}
              value={reason}
              onChangeText={setReason}
            />
            <View style={styles.askActions}>
              <Pressable
                style={[styles.askButton, { flex: 1 }, (!amount || busy) && { opacity: 0.5 }]}
                onPress={submitAsk}
                disabled={!amount || busy}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.askButtonText}>Send request</Text>
                )}
              </Pressable>
              <Pressable style={styles.cancelBtn} onPress={() => setAskOpen(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* request history */}
      {data.advances.length > 0 && (
        <View style={[styles.card, shadow.card]}>
          <Text style={styles.cardLabel}>MY REQUESTS</Text>
          {data.advances.map((a) => {
            const pill = pillFor(a.status);
            return (
              <View key={a.id} style={styles.requestRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.requestAmount}>{rupees(a.amount)}</Text>
                  <Text style={styles.requestMeta}>
                    {a.reason ? `${a.reason} · ` : ""}
                    {new Date(a.created_at).toLocaleDateString("en-IN", {
                      day: "numeric", month: "short",
                    })}
                  </Text>
                </View>
                <View style={[styles.pill, { backgroundColor: pill.bg }]}>
                  <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* attendance summary — the numbers that decide pay, without the pay */}
      <View style={[styles.card, shadow.card]}>
        <Text style={styles.cardLabel}>THIS MONTH</Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Days present</Text>
          <Text style={[styles.summaryValue, { color: colors.good }]}>{worked}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Days absent</Text>
          <Text style={[styles.summaryValue, absent > 0 && { color: colors.rose }]}>{absent}</Text>
        </View>
        <Text style={styles.cardHint}>
          For anything about your salary, please speak to the shop owner.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 22, paddingTop: 62, paddingBottom: 26 },
  title: { fontFamily: fonts.black, fontSize: 26, color: colors.ink, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.semi, fontSize: 14, color: colors.ink3, marginTop: 2, marginBottom: 14 },

  noticeBanner: {
    backgroundColor: colors.goodBg,
    borderRadius: radius.md,
    padding: 13,
    marginBottom: 12,
  },
  noticeText: { fontFamily: fonts.bold, color: colors.good, fontSize: 13.5, textAlign: "center" },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 20,
    marginBottom: 14,
  },
  cardLabel: {
    fontFamily: fonts.extra,
    fontSize: 11,
    color: colors.ink3,
    letterSpacing: 1,
    marginBottom: 6,
  },
  bigMoney: { fontFamily: fonts.black, fontSize: 32, color: colors.ink, letterSpacing: -0.5 },
  cardHint: { fontFamily: fonts.semi, fontSize: 13, color: colors.ink3, marginTop: 6, lineHeight: 19 },

  askButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 16,
  },
  askButtonText: { fontFamily: fonts.extra, color: "#fff", fontSize: 15 },
  askForm: { marginTop: 14 },
  fieldLabel: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink2, marginTop: 10, marginBottom: 6 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    padding: 13,
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  askActions: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  cancelBtn: { paddingVertical: 13, paddingHorizontal: 10, marginTop: 16 },
  cancelText: { fontFamily: fonts.bold, color: colors.ink3, fontSize: 14 },

  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 4,
  },
  requestAmount: { fontFamily: fonts.extra, fontSize: 15.5, color: colors.ink },
  requestMeta: { fontFamily: fonts.semi, fontSize: 12.5, color: colors.ink3, marginTop: 1 },
  pill: { borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  pillText: { fontFamily: fonts.extra, fontSize: 12 },

  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 4,
  },
  summaryLabel: { fontFamily: fonts.bold, fontSize: 15, color: colors.ink2 },
  summaryValue: { fontFamily: fonts.black, fontSize: 20, color: colors.ink },
});
