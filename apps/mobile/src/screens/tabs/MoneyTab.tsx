// Money tab — what every worker actually wants to know: how much
// have I earned so far, how much advance do I owe, and how do I ask
// for a new advance. Payslips appear here after payday.

import { useEffect, useState } from "react";
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
import type { SharedData } from "../MainScreen";

type Payslip = {
  id: string;
  gross: number;
  deductions: number;
  advance_cut: number;
  net: number;
  data: Record<string, number | string | boolean>;
  payroll_runs: { month: string } | null;
};

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export default function MoneyTab({ profile, data }: { profile: Profile; data: SharedData }) {
  const [askOpen, setAskOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [payslips, setPayslips] = useState<Payslip[]>([]);

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const salarySoFar = (profile.base_salary / daysInMonth) * worked;

  const [openSlip, setOpenSlip] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("payslips")
      .select("id, gross, deductions, advance_cut, net, data, payroll_runs(month)")
      .eq("profile_id", profile.id)
      .then(({ data: rows }) => setPayslips((rows as unknown as Payslip[]) ?? []));
  }, [profile.id]);

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

      {/* salary estimate */}
      <View style={[styles.card, shadow.card]}>
        <Text style={styles.cardLabel}>SALARY SO FAR (ESTIMATE)</Text>
        <Text style={styles.bigMoney}>{rupees(salarySoFar)}</Text>
        <Text style={styles.cardHint}>
          Based on {worked} day{worked === 1 ? "" : "s"} worked this month. The final
          amount comes with your payslip on payday.
        </Text>
      </View>

      {/* advance */}
      <View style={[styles.card, shadow.card]}>
        <Text style={styles.cardLabel}>ADVANCE TO REPAY</Text>
        <Text style={[styles.bigMoney, data.advanceBalance > 0 && { color: colors.accent }]}>
          {rupees(data.advanceBalance)}
        </Text>
        {data.advanceBalance > 0 && (
          <Text style={styles.cardHint}>Repaid bit by bit from each month's salary.</Text>
        )}

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

      {/* payslips */}
      <View style={[styles.card, shadow.card]}>
        <Text style={styles.cardLabel}>PAYSLIPS</Text>
        {payslips.length === 0 ? (
          <Text style={styles.cardHint}>
            Your payslips will appear here after the owner runs each month's salary.
          </Text>
        ) : (
          payslips.map((p) => (
            <View key={p.id}>
              <Pressable
                style={styles.requestRow}
                onPress={() => setOpenSlip(openSlip === p.id ? null : p.id)}
              >
                <Text style={styles.requestAmount}>
                  {p.payroll_runs
                    ? new Date(p.payroll_runs.month).toLocaleDateString("en-IN", {
                        month: "long", year: "numeric",
                      })
                    : "—"}
                </Text>
                <Text style={[styles.requestAmount, { color: colors.good }]}>{rupees(p.net)}</Text>
              </Pressable>
              {openSlip === p.id && (
                <View style={styles.slipDetail}>
                  <View style={styles.slipRow}>
                    <Text style={styles.slipLabel}>
                      Salary for {String(p.data.eligible_days ?? "")} days
                    </Text>
                    <Text style={styles.slipValue}>{rupees(p.gross)}</Text>
                  </View>
                  {Number(p.deductions) > 0 && (
                    <View style={styles.slipRow}>
                      <Text style={styles.slipLabel}>
                        {String(p.data.unpaid_days_total ?? 0)} unpaid day(s)
                      </Text>
                      <Text style={[styles.slipValue, { color: colors.serious }]}>
                        − {rupees(p.deductions)}
                      </Text>
                    </View>
                  )}
                  {Number(p.advance_cut) > 0 && (
                    <View style={styles.slipRow}>
                      <Text style={styles.slipLabel}>Advance repayment</Text>
                      <Text style={[styles.slipValue, { color: colors.accent }]}>
                        − {rupees(p.advance_cut)}
                      </Text>
                    </View>
                  )}
                  <View style={[styles.slipRow, styles.slipTotal]}>
                    <Text style={[styles.slipLabel, { color: colors.ink }]}>You receive</Text>
                    <Text style={[styles.slipValue, { color: colors.good }]}>{rupees(p.net)}</Text>
                  </View>
                </View>
              )}
            </View>
          ))
        )}
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

  slipDetail: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: 14,
    marginBottom: 8,
  },
  slipRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  slipTotal: { borderTopWidth: 1, borderTopColor: colors.line2, marginTop: 6, paddingTop: 10 },
  slipLabel: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink2 },
  slipValue: { fontFamily: fonts.extra, fontSize: 14.5, color: colors.ink },
});
