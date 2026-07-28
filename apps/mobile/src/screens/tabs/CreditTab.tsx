// Credit sales — goods taken on due, recorded at the billing counter.
//
// Only visible to staff the owner has given the billing permission to
// (profiles.can_bill), and the database enforces the same rule, so a
// worker who somehow reaches this screen still cannot file anything.
//
// The bill photo is required: it is the evidence behind the debt, and a
// name and a number typed by hand are too easy to get wrong. Everything
// here is written once and cannot be edited afterwards — the owner is
// the only one who can change or settle an entry.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons } from "@expo/vector-icons";
import { Branch, CreditSale, Profile, supabase } from "../../lib/supabase";
import PhotoCapture from "../../components/PhotoCapture";
import { colors, fonts, radius, shadow } from "../../lib/theme";

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;

const fmtDay = (ts: string) =>
  new Date(ts).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", timeZone: "Asia/Kolkata",
  });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type PayMethod = "CASH" | "UPI" | "CARD" | "BANK" | "OTHER";

const METHODS: { key: PayMethod; label: string }[] = [
  { key: "CASH", label: "Cash" },
  { key: "UPI", label: "UPI" },
  { key: "CARD", label: "Card" },
  { key: "BANK", label: "Bank" },
];

/** what "reference" means depends on how they paid */
const REF_HINT: Record<PayMethod, string> = {
  CASH: "Receipt number, or who witnessed it",
  UPI: "UPI transaction ID",
  CARD: "Last 4 digits / approval code",
  BANK: "Cheque or transfer reference",
  OTHER: "Any reference",
};

const EMPTY = {
  customer_name: "",
  customer_phone: "",
  bill_no: "",
  bill_amount: "",
  due_amount: "",
  note: "",
};

export default function CreditTab({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [form, setForm] = useState(EMPTY);
  const [photo, setPhoto] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [mine, setMine] = useState<CreditSale[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // Two jobs at this counter: booking a new debt, and taking money
  // against an old one. Taking money is the more frequent of the two
  // once the shop has been running a while, so it opens first.
  const [mode, setMode] = useState<"collect" | "new">("collect");
  const [search, setSearch] = useState("");
  const [payFor, setPayFor] = useState<CreditSale | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PayMethod>("CASH");
  const [payRef, setPayRef] = useState("");
  const [payProof, setPayProof] = useState<string | null>(null);
  const [proofCamera, setProofCamera] = useState(false);

  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Everything still owed at this shop, not only what this person
  // filed: the customer comes back on whatever day they come back, and
  // whoever is on the counter has to be able to find them.
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("credit_sales")
      .select("id, customer_name, customer_phone, bill_no, bill_amount, due_amount, paid_amount, note, settled_at, created_at")
      .eq("branch_id", branch.id)
      .order("created_at", { ascending: false })
      .limit(200);
    setMine((data as CreditSale[]) ?? []);
  }, [branch.id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Digits only, and no leading zeros creeping in from a stray tap.
  const money = (raw: string) => raw.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");

  const billAmt = Number(form.bill_amount || 0);
  const dueAmt = Number(form.due_amount || 0);
  const ready =
    form.customer_name.trim().length > 1 &&
    billAmt > 0 &&
    dueAmt > 0 &&
    dueAmt <= billAmt &&
    photo !== null;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const path = `${branch.id}/${now.toISOString().slice(0, 7)}/${now.getTime()}.jpg`;

      const { error: upErr } = await supabase.storage
        .from("bills")
        .upload(path, base64ToBytes(photo!).buffer as ArrayBuffer, {
          contentType: "image/jpeg",
          upsert: false,
        });
      if (upErr) throw upErr;

      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        photo!,
      );

      const { error: insErr } = await supabase.from("credit_sales").insert({
        branch_id: branch.id,
        recorded_by: profile.id,
        customer_name: form.customer_name.trim(),
        customer_phone: form.customer_phone.trim() || null,
        bill_no: form.bill_no.trim() || null,
        bill_amount: billAmt,
        due_amount: dueAmt,
        note: form.note.trim() || null,
        bill_path: path,
        bill_sha256: hash,
      });
      if (insErr) throw insErr;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(`${form.customer_name.trim()} · ${rupees(dueAmt)} due recorded`);
      setForm(EMPTY);
      setPhoto(null);
      await load();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setError(
        msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")
          ? "No internet. Nothing was saved — please try again when you are back online."
          : "Could not save this. Please check the details and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const balanceOf = (c: CreditSale) => Number(c.due_amount) - Number(c.paid_amount);

  const openSales = mine.filter((c) => !c.settled_at);
  const q = search.trim().toLowerCase();
  const matches = openSales.filter(
    (c) =>
      !q ||
      c.customer_name.toLowerCase().includes(q) ||
      (c.customer_phone ?? "").includes(q) ||
      (c.bill_no ?? "").toLowerCase().includes(q),
  );

  // A UPI payment lives as a screenshot in the gallery, not in front of
  // the camera, so proof can come from either place.
  //
  // expo-image-picker is loaded on demand rather than imported at the
  // top: it is a native module, so an app build made before it was
  // added does not contain it, and a top-level import would take the
  // whole screen down on those phones instead of just this one button.
  const pickProof = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ImagePicker = require("expo-image-picker");
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Allow photo access to attach a screenshot, or use the camera instead.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.7,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      // Shrink here too: a modern phone screenshot is several megabytes
      // and shop wifi is not fast.
      const out = await ImageManipulator.manipulateAsync(
        res.assets[0].uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (out.base64) setPayProof(out.base64);
    } catch {
      setError(
        "Choosing from photos needs the newer app version. Use Photo to take a " +
        "picture of the payment, or type the reference number.",
      );
    }
  };

  const resetPaySheet = () => {
    setPayFor(null);
    setPayAmount("");
    setPayMethod("CASH");
    setPayRef("");
    setPayProof(null);
  };

  const takePayment = async () => {
    if (!payFor || busy) return;
    const amount = Number(payAmount || 0);
    const balance = balanceOf(payFor);
    if (amount <= 0 || amount > balance) return;
    if (!payProof && !payRef.trim()) return;   // the database refuses this too

    setBusy(true);
    setError(null);
    try {
      let proofPath: string | null = null;
      let proofHash: string | null = null;

      if (payProof) {
        const now = new Date();
        proofPath = `${branch.id}/${now.toISOString().slice(0, 7)}/${now.getTime()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from("payment-proofs")
          .upload(proofPath, base64ToBytes(payProof).buffer as ArrayBuffer, {
            contentType: "image/jpeg",
            upsert: false,
          });
        if (upErr) throw upErr;
        proofHash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          payProof,
        );
      }

      const { error: err } = await supabase.from("credit_payments").insert({
        sale_id: payFor.id,
        amount,
        received_by: profile.id,
        method: payMethod,
        reference: payRef.trim() || null,
        proof_path: proofPath,
        proof_sha256: proofHash,
      });
      if (err) throw err;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const cleared = amount >= balance;
      setDone(
        cleared
          ? `${payFor.customer_name} has paid in full — ${rupees(amount)} received`
          : `${rupees(amount)} received from ${payFor.customer_name}. ${rupees(balance - amount)} still due.`,
      );
      resetPaySheet();
      await load();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setError(
        msg.includes("needs proof")
          ? "Attach a screenshot or photo, or enter a reference number."
          : msg.includes("more than the")
          // the database refused it — someone else took money first
          ? "That is more than is still owed. Pull down to refresh and check the amount."
          : msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")
          ? "No internet. Nothing was saved — please try again when you are back online."
          : "Could not record this payment. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // The owner can withdraw the permission at any time; if that happens
  // while the app is open, say so plainly rather than failing at submit.
  if (!profile.can_bill) {
    return (
      <View style={styles.denied}>
        <Ionicons name="lock-closed-outline" size={40} color={colors.ink3} />
        <Text style={styles.deniedTitle}>Not switched on for you</Text>
        <Text style={styles.deniedBody}>
          Recording credit customers is turned on by the owner for whoever is on
          the billing counter. Ask the owner if this should be you.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        <Text style={styles.h1}>Credit</Text>
        <Text style={styles.sub}>
          {mode === "collect"
            ? "Take money from a customer who owes"
            : "Record a customer taking clothes on due"}
        </Text>

        <View style={styles.segment}>
          <TouchableOpacity
            style={[styles.segBtn, mode === "collect" && styles.segOn]}
            onPress={() => setMode("collect")}
          >
            <Text style={[styles.segText, mode === "collect" && styles.segTextOn]}>
              Take payment{openSales.length > 0 ? ` (${openSales.length})` : ""}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, mode === "new" && styles.segOn]}
            onPress={() => setMode("new")}
          >
            <Text style={[styles.segText, mode === "new" && styles.segTextOn]}>
              New credit
            </Text>
          </TouchableOpacity>
        </View>

        {error && (
          <TouchableOpacity style={styles.err} onPress={() => setError(null)}>
            <Text style={styles.errText}>{error}</Text>
          </TouchableOpacity>
        )}
        {done && (
          <TouchableOpacity style={styles.ok} onPress={() => setDone(null)}>
            <Text style={styles.okText}>{done}</Text>
          </TouchableOpacity>
        )}

        {mode === "collect" ? (
          <>
            <TextInput
              style={styles.search}
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, phone or bill number"
              placeholderTextColor={colors.ink3}
            />

            {matches.length === 0 && (
              <View style={[styles.card, shadow.card]}>
                <Text style={styles.emptyText}>
                  {openSales.length === 0
                    ? "Nobody owes anything right now."
                    : "No customer matches that search."}
                </Text>
              </View>
            )}

            {matches.map((c) => {
              const balance = balanceOf(c);
              const part = Number(c.paid_amount) > 0;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.entry, shadow.card]}
                  onPress={() => {
                    setPayFor(c);
                    setPayAmount(String(balance));   // usually they clear it
                    setError(null);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.entryName}>{c.customer_name}</Text>
                    <Text style={styles.entryMeta}>
                      {fmtDay(c.created_at)}
                      {c.customer_phone ? ` · ${c.customer_phone}` : ""}
                      {c.bill_no ? ` · bill ${c.bill_no}` : ""}
                    </Text>
                    {part && (
                      <Text style={styles.entryPart}>
                        {rupees(Number(c.paid_amount))} of {rupees(Number(c.due_amount))} paid
                      </Text>
                    )}
                  </View>
                  <View style={styles.entryRight}>
                    <Text style={styles.entryDue}>{rupees(balance)}</Text>
                    <Text style={styles.entryState}>owed</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        ) : (
        <View style={[styles.card, shadow.card]}>
          <Text style={styles.label}>Customer name</Text>
          <TextInput
            style={styles.input}
            value={form.customer_name}
            onChangeText={set("customer_name")}
            placeholder="Full name"
            placeholderTextColor={colors.ink3}
          />

          <Text style={styles.label}>Phone number</Text>
          <TextInput
            style={styles.input}
            value={form.customer_phone}
            onChangeText={(v) => set("customer_phone")(v.replace(/[^0-9]/g, ""))}
            placeholder="10-digit number"
            placeholderTextColor={colors.ink3}
            keyboardType="number-pad"
            maxLength={10}
          />

          <Text style={styles.label}>Bill number (optional)</Text>
          <TextInput
            style={styles.input}
            value={form.bill_no}
            onChangeText={set("bill_no")}
            placeholder="As printed on the bill"
            placeholderTextColor={colors.ink3}
          />

          <View style={styles.row}>
            <View style={styles.half}>
              <Text style={styles.label}>Bill total (₹)</Text>
              <TextInput
                style={styles.input}
                value={form.bill_amount}
                onChangeText={(v) => set("bill_amount")(money(v))}
                placeholder="0"
                placeholderTextColor={colors.ink3}
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.half}>
              <Text style={styles.label}>Taken on due (₹)</Text>
              <TextInput
                style={styles.input}
                value={form.due_amount}
                onChangeText={(v) => set("due_amount")(money(v))}
                placeholder="0"
                placeholderTextColor={colors.ink3}
                keyboardType="number-pad"
              />
            </View>
          </View>
          {billAmt > 0 && dueAmt > billAmt && (
            <Text style={styles.warn}>
              The due amount cannot be more than the bill total.
            </Text>
          )}
          {billAmt > 0 && dueAmt > 0 && dueAmt <= billAmt && dueAmt < billAmt && (
            <Text style={styles.hint}>
              Paid now: {rupees(billAmt - dueAmt)}
            </Text>
          )}

          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={form.note}
            onChangeText={set("note")}
            placeholder="Anything the owner should know"
            placeholderTextColor={colors.ink3}
            multiline
          />

          <TouchableOpacity
            style={[styles.photoBtn, photo && styles.photoBtnDone]}
            onPress={() => setCamera(true)}
          >
            <Ionicons
              name={photo ? "checkmark-circle" : "camera-outline"}
              size={20}
              color={photo ? colors.good : colors.accent}
            />
            <Text style={[styles.photoText, photo && styles.photoTextDone]}>
              {photo ? "Bill photo taken — tap to retake" : "Take a photo of the bill"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.submit, !ready && styles.submitOff]}
            onPress={submit}
            disabled={!ready || busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>Save credit entry</Text>
            )}
          </TouchableOpacity>
          {!ready && !busy && (
            <Text style={styles.needs}>
              Name, both amounts and a photo of the bill are needed.
            </Text>
          )}
        </View>
        )}
      </ScrollView>

      {/* Taking the money. Deliberately a small, deliberate step of its
          own rather than a button on the row — this is cash changing
          hands, and the amount should be looked at before it is booked. */}
      {payFor && (
        <View style={styles.sheetWrap}>
          <TouchableOpacity
            style={styles.sheetBackdrop}
            activeOpacity={1}
            onPress={resetPaySheet}
          />
          <ScrollView
            style={[styles.sheet, shadow.card]}
            contentContainerStyle={styles.sheetInner}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.sheetName}>{payFor.customer_name}</Text>
            <Text style={styles.sheetMeta}>
              {rupees(balanceOf(payFor))} still owed
              {Number(payFor.paid_amount) > 0
                ? ` · ${rupees(Number(payFor.paid_amount))} already paid`
                : ""}
            </Text>

            <Text style={styles.label}>Amount received (₹)</Text>
            <TextInput
              style={styles.input}
              value={payAmount}
              onChangeText={(v) => setPayAmount(money(v))}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={colors.ink3}
            />
            {Number(payAmount || 0) > balanceOf(payFor) && (
              <Text style={styles.warn}>
                That is more than the {rupees(balanceOf(payFor))} still owed.
              </Text>
            )}
            {Number(payAmount || 0) > 0 &&
              Number(payAmount) < balanceOf(payFor) && (
                <Text style={styles.hint}>
                  {rupees(balanceOf(payFor) - Number(payAmount))} will still be due.
                </Text>
              )}

            <Text style={styles.label}>How did they pay?</Text>
            <View style={styles.methods}>
              {METHODS.map((m) => (
                <TouchableOpacity
                  key={m.key}
                  style={[styles.method, payMethod === m.key && styles.methodOn]}
                  onPress={() => setPayMethod(m.key)}
                >
                  <Text
                    style={[styles.methodText, payMethod === m.key && styles.methodTextOn]}
                  >
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Reference</Text>
            <TextInput
              style={styles.input}
              value={payRef}
              onChangeText={setPayRef}
              placeholder={REF_HINT[payMethod]}
              placeholderTextColor={colors.ink3}
              autoCapitalize="characters"
            />

            {/* Proof of the money, not of the goods. A UPI payment is a
                screenshot already on the phone; cash is a photo of the
                signed receipt. Either satisfies the rule, and so does a
                written reference on its own. */}
            <View style={styles.proofRow}>
              <TouchableOpacity style={styles.proofBtn} onPress={pickProof}>
                <Ionicons name="images-outline" size={18} color={colors.accent} />
                <Text style={styles.proofText}>Screenshot</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.proofBtn}
                onPress={() => setProofCamera(true)}
              >
                <Ionicons name="camera-outline" size={18} color={colors.accent} />
                <Text style={styles.proofText}>Photo</Text>
              </TouchableOpacity>
            </View>

            {payProof && (
              <View style={styles.proofDone}>
                <Ionicons name="checkmark-circle" size={18} color={colors.good} />
                <Text style={styles.proofDoneText}>Proof attached</Text>
                <TouchableOpacity onPress={() => setPayProof(null)}>
                  <Text style={styles.proofRemove}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}

            {!payProof && !payRef.trim() && (
              <Text style={styles.needs}>
                Attach a screenshot or photo, or type a reference number.
              </Text>
            )}

            <TouchableOpacity
              style={[
                styles.submit,
                (Number(payAmount || 0) <= 0 ||
                  Number(payAmount) > balanceOf(payFor) ||
                  (!payProof && !payRef.trim())) && styles.submitOff,
              ]}
              onPress={takePayment}
              disabled={
                busy ||
                Number(payAmount || 0) <= 0 ||
                Number(payAmount) > balanceOf(payFor) ||
                (!payProof && !payRef.trim())
              }
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>
                  {Number(payAmount || 0) >= balanceOf(payFor)
                    ? "Received in full"
                    : "Record payment"}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={resetPaySheet}
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      <PhotoCapture
        visible={proofCamera}
        facing="back"
        hint="Fit the receipt or screen in the frame"
        askTitle="Photo as proof of payment"
        askBody="A photo of the receipt, or of the payment on the customer's phone, so the owner can check what came in."
        allowSkip={false}
        width={1080}
        onDone={(b64) => {
          setProofCamera(false);
          if (b64) setPayProof(b64);
        }}
        onCancel={() => setProofCamera(false)}
      />

      <PhotoCapture
        visible={camera}
        facing="back"
        hint="Fit the whole bill in the frame"
        askTitle="Photo of the bill"
        askBody="The bill photo is the proof of what the customer owes. It is kept until the owner marks the amount paid."
        allowSkip={false}
        width={1280}
        onDone={(b64) => {
          setCamera(false);
          if (b64) setPhoto(b64);
        }}
        onCancel={() => setCamera(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, paddingTop: 58, paddingBottom: 40 },
  h1: { fontFamily: fonts.extra, fontSize: 26, color: colors.ink },
  sub: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink2, marginTop: 2, marginBottom: 16 },
  h2: { fontFamily: fonts.extra, fontSize: 17, color: colors.ink, marginTop: 26, marginBottom: 10 },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 18, gap: 4 },
  label: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink2, marginTop: 12 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: fonts.regular, fontSize: 16, color: colors.ink,
    marginTop: 5,
  },
  multiline: { minHeight: 68, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 12 },
  half: { flex: 1 },
  warn: { fontFamily: fonts.bold, fontSize: 13, color: colors.serious, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2, marginTop: 8 },

  photoBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1.5, borderColor: colors.accent, borderStyle: "dashed",
    borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 14,
    marginTop: 18,
  },
  photoBtnDone: { borderColor: colors.good, borderStyle: "solid" },
  photoText: { fontFamily: fonts.bold, fontSize: 15, color: colors.accent, flex: 1 },
  photoTextDone: { color: colors.good },

  submit: {
    backgroundColor: colors.accent, borderRadius: radius.md,
    paddingVertical: 16, alignItems: "center", marginTop: 18,
  },
  submitOff: { opacity: 0.45 },
  submitText: { fontFamily: fonts.extra, fontSize: 17, color: "#fff" },
  needs: {
    fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink3,
    textAlign: "center", marginTop: 8,
  },

  entry: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 14, marginBottom: 8,
  },
  segment: {
    flexDirection: "row", gap: 8, marginBottom: 16,
    backgroundColor: colors.surface, borderRadius: radius.md, padding: 4,
    borderWidth: 1, borderColor: colors.line,
  },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: "center" },
  segOn: { backgroundColor: colors.accent },
  segText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink2 },
  segTextOn: { color: "#fff" },

  search: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: fonts.regular, fontSize: 15, color: colors.ink,
    marginBottom: 12,
  },
  emptyText: {
    fontFamily: fonts.regular, fontSize: 15, color: colors.ink2,
    textAlign: "center", paddingVertical: 10,
  },
  entryPart: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.good, marginTop: 3 },

  sheetWrap: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: "flex-end",
  },
  sheetBackdrop: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: 22, paddingBottom: 34, gap: 2,
  },
  sheetInner: { paddingBottom: 8 },
  methods: { flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" },
  method: {
    paddingVertical: 9, paddingHorizontal: 16,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line2,
    backgroundColor: colors.bg,
  },
  methodOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  methodText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink2 },
  methodTextOn: { color: "#fff" },

  proofRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  proofBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 13,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.accent,
    borderStyle: "dashed",
  },
  proofText: { fontFamily: fonts.bold, fontSize: 14, color: colors.accent },
  proofDone: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12,
    backgroundColor: colors.goodBg, borderRadius: radius.md, padding: 12,
  },
  proofDoneText: { fontFamily: fonts.bold, fontSize: 14, color: colors.good, flex: 1 },
  proofRemove: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink3 },

  sheetName: { fontFamily: fonts.extra, fontSize: 20, color: colors.ink },
  sheetMeta: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink2, marginTop: 2 },
  sheetCancel: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  sheetCancelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.ink3 },

  entryName: { fontFamily: fonts.bold, fontSize: 15, color: colors.ink },
  entryMeta: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink3, marginTop: 2 },
  entryRight: { alignItems: "flex-end" },
  entryDue: { fontFamily: fonts.extra, fontSize: 16, color: colors.ink },
  entryState: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent, marginTop: 2 },
  entryPaid: { color: colors.good },

  err: {
    backgroundColor: colors.seriousBg, borderRadius: radius.md, padding: 14, marginBottom: 12,
  },
  errText: { fontFamily: fonts.bold, fontSize: 14, color: colors.serious },
  ok: {
    backgroundColor: colors.goodBg, borderRadius: radius.md, padding: 14, marginBottom: 12,
  },
  okText: { fontFamily: fonts.bold, fontSize: 14, color: colors.good },

  denied: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: 32, gap: 10,
  },
  deniedTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink },
  deniedBody: {
    fontFamily: fonts.regular, fontSize: 15, lineHeight: 21,
    color: colors.ink2, textAlign: "center",
  },
});
