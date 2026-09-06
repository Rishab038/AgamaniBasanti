// Money — advances only.
//
// Salary figures are deliberately absent from the worker app. A running
// estimate computed from attendance will rarely match the owner's final
// payslip (leave policy, adjustments, rounding), and a worker who has
// watched a number climb all month will treat any difference as a
// shortfall. The owner remains the single source of truth on pay; the
// app's job is to be honest about attendance and advances.
//
// Asking is four taps: open, amount, reason, send. The amount is still
// typeable for anything the four presets do not cover — the presets are
// a shortcut, not a menu.

import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Profile, supabase } from "../../lib/supabase";
import { colors, fonts, radius } from "../../lib/theme";
import { groupInr } from "../../lib/fmt";
import type { SharedData } from "../MainScreen";

const rupees = (n: number) => `₹${groupInr(Math.round(n))}`;

const PRESETS = [500, 1000, 1500, 3000];
const REASONS = ["School fees", "Medicine", "Festival", "Family"];

export default function MoneyTab({ profile, data }: { profile: Profile; data: SharedData }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const amt = Number(amount) || 0;

  const submitAsk = async () => {
    if (amt <= 0 || busy) return;
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
      setSheetOpen(false);
      setAmount("");
      setReason("");
      await data.reload();
    }
  };

  const pillFor = (status: string) =>
    status === "APPROVED"
      ? { bg: colors.goodBg, fg: colors.good, label: "Approved" }
      : status === "REJECTED"
        ? { bg: "transparent", fg: colors.ink3, label: "Declined", ring: true }
        : { bg: colors.amberBg, fg: colors.amber, label: "Waiting" };

  return (
    <View style={styles.root}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Text style={styles.kicker}>ADVANCES ONLY · PAY COMES FROM THE OWNER</Text>
          <Text style={styles.title}>My money</Text>
        </View>

        {notice && (
          <Pressable style={styles.notice} onPress={() => setNotice(null)}>
            <Text style={styles.noticeText}>{notice}</Text>
          </Pressable>
        )}

        {/* the one number this screen is about */}
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>ADVANCE TAKEN SO FAR</Text>
          <Text style={styles.heroValue}>{rupees(data.advancePaid)}</Text>
          <Text style={styles.heroHint}>
            {data.advancePaid > 0
              ? "Recovered from your pay a little at a time, oldest first."
              : "You have not taken any advance yet."}
          </Text>
        </View>

        <Text style={styles.section}>My requests</Text>
        {data.advances.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Nothing asked for yet.</Text>
          </View>
        ) : (
          data.advances.map((a) => {
            const pill = pillFor(a.status);
            return (
              <View key={a.id} style={styles.request}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.requestAmount}>{rupees(a.amount)}</Text>
                  <Text style={styles.requestMeta}>
                    {a.reason ? `${a.reason} · ` : ""}
                    {new Date(a.created_at).toLocaleDateString("en-IN", {
                      day: "numeric", month: "short",
                    })}
                  </Text>
                </View>
                <View
                  style={[
                    styles.pill,
                    { backgroundColor: pill.bg },
                    pill.ring && { borderWidth: 1, borderColor: colors.ink3 },
                  ]}
                >
                  <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Pinned, like the slab on Home: the one thing to do here should
          not need scrolling to find. */}
      <View style={styles.askWrap}>
        <TouchableOpacity style={styles.ask} activeOpacity={0.85} onPress={() => setSheetOpen(true)}>
          <Text style={styles.askTitle}>Ask for an advance</Text>
          <Text style={styles.askSub}>The owner answers on their phone</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={{ flex: 1 }} onPress={() => setSheetOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>How much{"\n"}do you need?</Text>
              <TouchableOpacity style={styles.close} onPress={() => setSheetOpen(false)}>
                <Text style={styles.closeText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.amountRow}>
              <Text style={styles.rupee}>₹</Text>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={(v) => setAmount(v.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.mute}
              />
            </View>

            <View style={styles.chips}>
              {PRESETS.map((v) => {
                const on = amt === v;
                return (
                  <TouchableOpacity
                    key={v}
                    style={[styles.chip, { flex: 1 }, on && styles.chipOn]}
                    activeOpacity={0.85}
                    onPress={() => setAmount(String(v))}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {v.toLocaleString("en-IN")}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>WHAT IS IT FOR?</Text>
            <View style={styles.chipsWrap}>
              {REASONS.map((r) => {
                const on = reason === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.chip, styles.chipPill, on && styles.chipOn]}
                    activeOpacity={0.85}
                    onPress={() => setReason(on ? "" : r)}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{r}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={[styles.send, amt <= 0 && styles.sendOff]}
              activeOpacity={0.85}
              disabled={amt <= 0 || busy}
              onPress={submitAsk}
            >
              {busy ? (
                <ActivityIndicator color={colors.accentInk} />
              ) : (
                <Text style={[styles.sendText, amt <= 0 && styles.sendTextOff]}>
                  {amt > 0 ? `Send ${rupees(amt)} request` : "Choose an amount"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, paddingTop: 22, paddingBottom: 12 },

  head: { paddingHorizontal: 6, paddingBottom: 20 },
  kicker: { fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.4, color: colors.ink3 },
  title: {
    fontFamily: fonts.semi, fontSize: 34, lineHeight: 36,
    letterSpacing: -1.2, color: colors.ink, marginTop: 10,
  },

  notice: {
    borderRadius: radius.md, backgroundColor: colors.goodBg,
    borderWidth: 1, borderColor: "rgba(127,201,166,0.24)",
    padding: 14, marginBottom: 12,
  },
  noticeText: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.good },

  // Flat, not a gradient. expo-linear-gradient was removed when the app
  // was slimmed, and one solid accent-deep panel reads the same at this
  // size without adding a native module back.
  hero: { borderRadius: radius.lg, backgroundColor: colors.accentDeep, padding: 24, paddingVertical: 24 },
  heroLabel: { fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.5, color: "#d2cefd" },
  heroValue: {
    fontFamily: fonts.extra, fontSize: 56, lineHeight: 58,
    letterSpacing: -2.4, color: "#f5f4ff", marginTop: 12,
  },
  heroHint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: "#d2cefd", marginTop: 10 },

  section: {
    fontFamily: fonts.extra, fontSize: 14.5, letterSpacing: -0.2,
    color: colors.ink, paddingHorizontal: 6, paddingTop: 28, paddingBottom: 12,
  },
  empty: {
    borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line, padding: 18,
  },
  emptyText: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink3 },

  request: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingVertical: 17, paddingHorizontal: 18, marginBottom: 8,
    borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
  },
  requestAmount: { fontFamily: fonts.extra, fontSize: 21, letterSpacing: -0.6, color: colors.ink },
  requestMeta: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink3, marginTop: 6 },
  pill: { paddingVertical: 7, paddingHorizontal: 11, borderRadius: radius.pill },
  pillText: { fontFamily: fonts.extra, fontSize: 11, letterSpacing: 0.4 },

  askWrap: { paddingHorizontal: 16, paddingBottom: 6 },
  ask: { borderRadius: radius.lg, backgroundColor: colors.accent, paddingVertical: 20, paddingHorizontal: 22 },
  askTitle: { fontFamily: fonts.extra, fontSize: 22, letterSpacing: -0.6, color: colors.accentInk },
  askSub: {
    fontFamily: fonts.semi, fontSize: 11.5, letterSpacing: 0.6,
    color: colors.accentInk, opacity: 0.72, marginTop: 9,
  },

  backdrop: { flex: 1, backgroundColor: "rgba(9,10,18,0.62)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 20, paddingTop: 14, paddingBottom: 28,
  },
  grabber: {
    width: 38, height: 4, borderRadius: 2,
    backgroundColor: colors.line2, alignSelf: "center", marginBottom: 18,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
  sheetTitle: {
    flex: 1, fontFamily: fonts.semi, fontSize: 26, lineHeight: 28,
    letterSpacing: -0.9, color: colors.ink,
  },
  close: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: colors.track,
    alignItems: "center", justifyContent: "center",
  },
  closeText: { fontFamily: fonts.semi, fontSize: 16, color: colors.ink },

  amountRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22 },
  rupee: { fontFamily: fonts.semi, fontSize: 34, color: colors.ink3 },
  amountInput: {
    flex: 1, padding: 0,
    fontFamily: fonts.extra, fontSize: 54, lineHeight: 60,
    letterSpacing: -2.2, color: colors.ink,
  },

  chips: { flexDirection: "row", gap: 8, marginTop: 18 },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 52, borderRadius: radius.sm, backgroundColor: colors.track,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 18,
  },
  chipPill: { minHeight: 46, borderRadius: radius.pill, paddingHorizontal: 18 },
  chipOn: { backgroundColor: colors.accent },
  chipText: { fontFamily: fonts.extra, fontSize: 14, color: colors.ink },
  chipTextOn: { color: colors.accentInk },

  sheetLabel: {
    fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.5,
    color: colors.ink3, marginTop: 24, marginBottom: 10,
  },

  send: {
    minHeight: 68, borderRadius: 18, backgroundColor: colors.accent,
    marginTop: 26, alignItems: "center", justifyContent: "center", paddingHorizontal: 22,
  },
  sendOff: { backgroundColor: colors.track },
  sendText: { fontFamily: fonts.extra, fontSize: 21, letterSpacing: -0.6, color: colors.accentInk },
  sendTextOff: { color: colors.ink3 },
});
