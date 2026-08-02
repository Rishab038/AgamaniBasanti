// The credit book at the counter — the same khata the owner reads on
// the dashboard, in the hands of whoever is serving.
//
// Organised around the customer rather than the bill, because that is
// how the question arrives: "Sujata is here, what does she owe?" A
// person's page holds every bill they have taken and every rupee they
// have paid, and the balance at the top is the answer.
//
// Money can be taken against one bill or against the account as a
// whole. Paying with nothing owed is not an error — it is an advance,
// and the balance simply goes the other way.
//
// Only staff the owner has switched on (profiles.can_bill) see this,
// and the database enforces the same rule independently.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
// Deep import, not the barrel: `from "@expo/vector-icons"` makes
// Metro bundle the font file of EVERY icon family — thirteen of
// them, ~4.4 MB — when this app draws Ionicons and nothing else.
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  Branch, CreditSale, CustomerBalance, Profile, supabase,
} from "../../lib/supabase";
import PhotoCapture from "../../components/PhotoCapture";
import { colors, fonts, radius, rowEdge, shadow } from "../../lib/theme";
import { fmtDay, groupInr } from "../../lib/fmt";

type PayMethod = "CASH" | "UPI" | "CARD" | "BANK" | "OTHER";

type Payment = {
  id: string;
  sale_id: string | null;
  amount: number;
  method: string | null;
  reference: string | null;
  created_at: string;
};

const METHODS: { key: PayMethod; label: string }[] = [
  { key: "CASH", label: "Cash" },
  { key: "UPI", label: "UPI" },
  { key: "CARD", label: "Card" },
  { key: "BANK", label: "Bank" },
];

const REF_HINT: Record<PayMethod, string> = {
  CASH: "Receipt number, or who witnessed it",
  UPI: "UPI transaction ID",
  CARD: "Last 4 digits / approval code",
  BANK: "Cheque or transfer reference",
  OTHER: "Any reference",
};

// the khata shows magnitudes; direction is carried by the words
const rupees = (n: number) => `₹${groupInr(Math.abs(Number(n)))}`;
const digits = (s: string) => s.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");

/** "7 days ago", "4 weeks ago" — how long since anything happened */
const ago = (ts: string | null): string => {
  if (!ts) return "no activity";
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return `${w} week${w === 1 ? "" : "s"} ago`; }
  const m = Math.floor(days / 30);
  return `${m} month${m === 1 ? "" : "s"} ago`;
};

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const lastActivity = (c: CustomerBalance) => {
  const a = c.last_bill_at, b = c.last_payment_at;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
};

/**
 * One line of the customer list.
 *
 * Pulled out and memoised because this list is long and sits under a
 * search box: every keystroke re-rendered all sixty-odd rows, on a phone
 * that cannot afford it. Now a keystroke re-renders only the rows whose
 * customer actually changed, which is none of them — the list just gets
 * shorter.
 */
const CustomerRow = memo(function CustomerRow({
  c,
  onOpen,
}: {
  c: CustomerBalance;
  onOpen: (c: CustomerBalance) => void;
}) {
  const bal = Number(c.balance);
  return (
    <TouchableOpacity
      style={[styles.row, rowEdge]}
      onPress={() => onOpen(c)}
      activeOpacity={0.7}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initialsOf(c.name)}</Text>
      </View>
      <View style={styles.rowWho}>
        <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
        <Text style={styles.rowAgo}>{ago(lastActivity(c))}</Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[
          styles.rowAmt,
          bal > 0 && styles.owed,
          bal < 0 && styles.advance,
          bal === 0 && styles.clear,
        ]}>
          {bal === 0 ? "₹0" : rupees(bal)}
        </Text>
        <Text style={styles.rowDir}>
          {bal > 0 ? "you will get" : bal < 0 ? "you will give" : "settled"}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

const EMPTY_BILL = {
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
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [sales, setSales] = useState<CreditSale[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [mode, setMode] = useState<"khata" | "bill" | "advance">("khata");

  // Staff advances logged at the counter. Cash for these leaves the till
  // here, so the person who knows it happened is whoever is serving —
  // not the colleague who took the money and walked off.
  const [colleagues, setColleagues] = useState<{ id: string; full_name: string }[]>([]);
  const [advFor, setAdvFor] = useState<string>("");
  const [advAmount, setAdvAmount] = useState("");
  const [advReason, setAdvReason] = useState("");
  const [advPicker, setAdvPicker] = useState(false);
  const [advSearch, setAdvSearch] = useState("");
  const [myLogged, setMyLogged] = useState<
    { id: string; amount: number; status: string; created_at: string;
      profiles: { full_name: string } | null }[]
  >([]);
  const [search, setSearch] = useState("");

  // the customer whose page is open
  const [openCustomer, setOpenCustomer] = useState<CustomerBalance | null>(null);

  // money-in sheet
  const [takingMoney, setTakingMoney] = useState(false);
  const [amount, setAmount] = useState("");
  const [againstSale, setAgainstSale] = useState<string>("");
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [reference, setReference] = useState("");
  const [proof, setProof] = useState<string | null>(null);
  const [proofCamera, setProofCamera] = useState(false);

  // new bill
  const [bill, setBill] = useState(EMPTY_BILL);
  const [billPhoto, setBillPhoto] = useState<string | null>(null);
  const [billCamera, setBillCamera] = useState(false);

  const load = useCallback(async () => {
    const [{ data: cust }, { data: s }, { data: p }] = await Promise.all([
      supabase.from("customer_balances").select("*").eq("branch_id", branch.id),
      supabase
        .from("credit_sales")
        .select("id, customer_id, customer_name, customer_phone, bill_no, bill_amount, due_amount, paid_amount, note, settled_at, created_at")
        .eq("branch_id", branch.id)
        .order("created_at", { ascending: false })
        .limit(400),
      supabase
        .from("credit_payments")
        .select("id, customer_id, sale_id, amount, method, reference, created_at")
        .order("created_at", { ascending: false })
        .limit(400),
    ]);
    setCustomers((cust as CustomerBalance[]) ?? []);
    setSales((s as CreditSale[]) ?? []);
    setPayments((p as unknown as (Payment & { customer_id: string })[]) ?? []);

    // colleagues at this shop, and what this person has already logged
    // for them — without the second list a counter worker cannot tell a
    // saved entry from a lost one, and files it twice
    const [{ data: mates }, { data: logged }] = await Promise.all([
      // Through an RPC, not a table read: profiles is owner-only for
      // SELECT, and widening it would expose salaries to the counter.
      supabase.rpc("fn_branch_colleagues"),
      supabase
        .from("advances")
        .select("id, amount, status, created_at, profiles!advances_profile_id_fkey(full_name)")
        .eq("recorded_by", profile.id)
        .neq("profile_id", profile.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    // already excludes the caller and comes back sorted by name
    setColleagues((mates as { id: string; full_name: string }[]) ?? []);
    setMyLogged((logged as never) ?? []);
  }, [branch.id, profile.id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      customers
        .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone ?? "").includes(q))
        // biggest balances first — that is what gets chased
        .sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance))),
    [customers, q],
  );

  const owedTotal = customers.reduce(
    (t, c) => t + (Number(c.balance) > 0 ? Number(c.balance) : 0), 0,
  );
  const giveTotal = customers.reduce(
    (t, c) => t + (Number(c.balance) < 0 ? -Number(c.balance) : 0), 0,
  );

  // Stable identity, so CustomerRow's memo actually holds. Without it
  // every row gets a new onPress on each keystroke in the search box and
  // the memo never skips anything.
  const openCustomerPage = useCallback((c: CustomerBalance) => {
    setOpenCustomer(c);
    setAgainstSale("");
  }, []);

  const mySales = (cid: string) => sales.filter((s) => s.customer_id === cid);
  const myPayments = (cid: string) =>
    payments.filter((p) => (p as Payment & { customer_id: string }).customer_id === cid);
  const openBills = (cid: string) => mySales(cid).filter((s) => !s.settled_at);

  // ---------- money in ----------
  const pickProof = async () => {
    try {
      // loaded on demand: an app build made before expo-image-picker was
      // added does not contain it, and a top-level import would take the
      // whole screen down on those phones rather than just this button
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ImagePicker = require("expo-image-picker");
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Allow photo access to attach a screenshot, or use the camera.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], quality: 0.7,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      const out = await ImageManipulator.manipulateAsync(
        res.assets[0].uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (out.base64) setProof(out.base64);
    } catch {
      setError(
        "Choosing from photos needs the newer app version. Use Photo instead, " +
        "or type the reference number.",
      );
    }
  };

  const resetMoney = () => {
    setTakingMoney(false);
    setAmount("");
    setAgainstSale("");
    setMethod("CASH");
    setReference("");
    setProof(null);
  };

  const saveMoney = async () => {
    if (!openCustomer || busy) return;
    const amt = Number(amount || 0);
    if (amt <= 0) return;

    setBusy(true);
    setError(null);
    try {
      let proofPath: string | null = null;
      let proofHash: string | null = null;
      if (proof) {
        const now = new Date();
        proofPath = `${branch.id}/${now.toISOString().slice(0, 7)}/${now.getTime()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from("payment-proofs")
          .upload(proofPath, base64ToBytes(proof).buffer as ArrayBuffer, {
            contentType: "image/jpeg", upsert: false,
          });
        if (upErr) throw upErr;
        proofHash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256, proof,
        );
      }

      const { error: err } = await supabase.from("credit_payments").insert({
        customer_id: openCustomer.id,
        // blank = against the account as a whole, which is what makes an
        // advance possible when nothing is owed
        sale_id: againstSale || null,
        amount: amt,
        received_by: profile.id,
        method,
        reference: reference.trim() || null,
        proof_path: proofPath,
        proof_sha256: proofHash,
      });
      if (err) throw err;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const after = Number(openCustomer.balance) - amt;
      setDone(
        after < 0
          ? `${rupees(amt)} taken — ${rupees(after)} now held as advance for ${openCustomer.name}`
          : after === 0
          ? `${openCustomer.name} is fully settled`
          : `${rupees(amt)} taken — ${rupees(after)} still owed by ${openCustomer.name}`,
      );
      resetMoney();
      setOpenCustomer(null);
      await load();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setError(
        msg.includes("more than the")
          ? "That is more than is left on this bill. Pull down to refresh and check."
          : msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")
          ? "No internet. Nothing was saved — try again when you are back online."
          : "Could not record this. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // ---------- staff advance, logged for a colleague ----------
  const advReady = advFor !== "" && Number(advAmount || 0) > 0;

  const saveAdvance = async () => {
    if (!advReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.from("advances").insert({
        profile_id: advFor,
        amount: Number(advAmount),
        reason: advReason.trim() || null,
        // filed, not granted — the owner still decides, and nothing
        // reaches payroll until they do
        status: "PENDING",
        recorded_by: profile.id,
      });
      if (err) throw err;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const who = colleagues.find((c) => c.id === advFor)?.full_name ?? "Staff";
      setDone(`${rupees(Number(advAmount))} advance for ${who} sent to the owner for approval`);
      setAdvFor("");
      setAdvAmount("");
      setAdvReason("");
      setAdvSearch("");
      await load();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setError(
        // Do not name a cause the error does not actually prove. This
        // message used to assert a branch mismatch for ANY policy
        // failure, and said exactly that while the real fault was
        // elsewhere — which is worse than saying nothing.
        msg.toLowerCase().includes("row-level security") || msg.toLowerCase().includes("policy")
          ? "This was refused. Check they still work at this shop, then tell the owner if it keeps happening."
          : msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")
          ? "No internet. Nothing was saved — try again when you are back online."
          : "Could not save this advance. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // ---------- new bill ----------
  const billTotal = Number(bill.bill_amount || 0);
  const billDue = Number(bill.due_amount || 0);
  const billReady =
    bill.customer_name.trim().length > 1 &&
    billTotal > 0 && billDue > 0 && billDue <= billTotal &&
    billPhoto !== null;

  // Suggest people already in the book so the same person does not end
  // up with two pages spelled slightly differently.
  const nameMatches = useMemo(() => {
    const t = bill.customer_name.trim().toLowerCase();
    if (t.length < 2) return [];
    return customers
      .filter((c) => c.name.toLowerCase().includes(t) && c.name.toLowerCase() !== t)
      .slice(0, 4);
  }, [bill.customer_name, customers]);

  const saveBill = async () => {
    if (!billReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      const name = bill.customer_name.trim();
      const phone = bill.customer_phone.trim() || null;

      // one page per person: reuse the existing row when the name
      // matches, otherwise open a new page
      let customerId = customers.find(
        (c) => c.name.trim().toLowerCase() === name.toLowerCase(),
      )?.id;

      if (!customerId) {
        const { data: created, error: cErr } = await supabase
          .from("customers")
          .insert({ branch_id: branch.id, name, phone })
          .select("id")
          .single();
        if (cErr) throw cErr;
        customerId = created.id;
      }

      const now = new Date();
      const path = `${branch.id}/${now.toISOString().slice(0, 7)}/${now.getTime()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("bills")
        .upload(path, base64ToBytes(billPhoto!).buffer as ArrayBuffer, {
          contentType: "image/jpeg", upsert: false,
        });
      if (upErr) throw upErr;

      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256, billPhoto!,
      );

      const { error: insErr } = await supabase.from("credit_sales").insert({
        branch_id: branch.id,
        recorded_by: profile.id,
        customer_id: customerId,
        customer_name: name,
        customer_phone: phone,
        bill_no: bill.bill_no.trim() || null,
        bill_amount: billTotal,
        due_amount: billDue,
        note: bill.note.trim() || null,
        bill_path: path,
        bill_sha256: hash,
      });
      if (insErr) throw insErr;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(`${name} · ${rupees(billDue)} added to their khata`);
      setBill(EMPTY_BILL);
      setBillPhoto(null);
      setMode("khata");
      await load();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setError(
        msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")
          ? "No internet. Nothing was saved — try again when you are back online."
          : "Could not save this bill. Please check the details and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!profile.can_bill) {
    return (
      <View style={styles.denied}>
        <Ionicons name="lock-closed-outline" size={40} color={colors.ink3} />
        <Text style={styles.deniedTitle}>Not switched on for you</Text>
        <Text style={styles.deniedBody}>
          The credit book is turned on by the owner for whoever is on the billing
          counter. Ask the owner if this should be you.
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
        <Text style={styles.h1}>Credit book</Text>

        {/* The same two figures the owner sees on the website, so the
            counter and the office are reading one number each way. */}
        <View style={[styles.summary, shadow.card]}>
          <View style={styles.sumHalf}>
            <Text style={styles.sumLabel}>You will give</Text>
            <Text style={styles.sumGive}>{giveTotal === 0 ? "₹0" : rupees(giveTotal)}</Text>
          </View>
          <View style={styles.sumDivider} />
          <View style={styles.sumHalf}>
            <Text style={styles.sumLabel}>You will get</Text>
            <Text style={styles.sumGet}>{owedTotal === 0 ? "₹0" : rupees(owedTotal)}</Text>
          </View>
        </View>

        <View style={styles.segment}>
          <TouchableOpacity
            style={[styles.segBtn, mode === "khata" && styles.segOn]}
            onPress={() => setMode("khata")}
          >
            <Text style={[styles.segText, mode === "khata" && styles.segTextOn]}>
              Customers ({customers.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, mode === "bill" && styles.segOn]}
            onPress={() => setMode("bill")}
          >
            <Text style={[styles.segText, mode === "bill" && styles.segTextOn]}>
              New bill
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, mode === "advance" && styles.segOn]}
            onPress={() => setMode("advance")}
          >
            <Text style={[styles.segText, mode === "advance" && styles.segTextOn]}>
              Staff advance
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

        {mode === "khata" ? (
          <>
            <TextInput
              style={styles.search}
              value={search}
              onChangeText={setSearch}
              placeholder="Search customer name or phone"
              placeholderTextColor={colors.ink3}
            />

            {shown.length === 0 && (
              <View style={[styles.card, shadow.card]}>
                <Text style={styles.emptyText}>
                  {customers.length === 0
                    ? "No customers in the book yet. Add a bill to start one."
                    : "No customer matches that search."}
                </Text>
              </View>
            )}

            {/* Name and amount only — everything else is on their page */}
            {shown.map((c) => (
              <CustomerRow key={c.id} c={c} onOpen={openCustomerPage} />
            ))}
          </>
        ) : mode === "advance" ? (
          <>
            <View style={[styles.card, shadow.card]}>
              <Text style={styles.advIntro}>
                Log money given to a colleague from the till. The owner approves
                it before it affects anyone's salary.
              </Text>

              <Text style={styles.label}>Who took the advance?</Text>
              {/* A field that opens a list, not a text box. Names here
                  are typed inconsistently across the roster, so making
                  someone spell one correctly is a bad way to ask. */}
              <TouchableOpacity
                style={[styles.picker, advFor !== "" && styles.pickerChosen]}
                onPress={() => { setAdvPicker(true); setAdvSearch(""); }}
              >
                <Text style={advFor ? styles.pickerValue : styles.pickerPlaceholder}>
                  {advFor
                    ? colleagues.find((c) => c.id === advFor)?.full_name
                    : colleagues.length === 0
                    ? "No other staff at this shop"
                    : `Choose from ${colleagues.length} staff`}
                </Text>
                <Ionicons
                  name={advFor ? "checkmark-circle" : "chevron-down"}
                  size={18}
                  color={advFor ? colors.good : colors.ink3}
                />
              </TouchableOpacity>

              <Text style={styles.label}>Amount given (₹)</Text>
              <TextInput
                style={styles.input}
                value={advAmount}
                onChangeText={(v) => setAdvAmount(digits(v))}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.ink3}
              />

              <Text style={styles.label}>Reason (optional)</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={advReason}
                onChangeText={setAdvReason}
                placeholder="What they said it was for"
                placeholderTextColor={colors.ink3}
                multiline
              />

              <TouchableOpacity
                style={[styles.submit, !advReady && styles.submitOff]}
                onPress={saveAdvance}
                disabled={!advReady || busy}
              >
                {busy ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitText}>Send to owner for approval</Text>}
              </TouchableOpacity>
              {!advReady && !busy && (
                <Text style={styles.needs}>Choose the person and enter an amount.</Text>
              )}
            </View>

            {myLogged.length > 0 && (
              <>
                <Text style={styles.sectionHead}>Logged by you</Text>
                {myLogged.map((a) => (
                  <View key={a.id} style={[styles.row, rowEdge]}>
                    <View style={styles.rowWho}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {a.profiles?.full_name ?? "Staff"}
                      </Text>
                      <Text style={styles.rowAgo}>{fmtDay(a.created_at)}</Text>
                    </View>
                    <View style={styles.rowRight}>
                      <Text style={[styles.rowAmt, styles.owed]}>{rupees(a.amount)}</Text>
                      <Text style={[
                        styles.advStatus,
                        a.status === "APPROVED" && styles.advOk,
                        a.status === "REJECTED" && styles.advNo,
                      ]}>
                        {a.status === "PENDING" ? "waiting"
                          : a.status === "APPROVED" ? "approved" : "rejected"}
                      </Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </>
        ) : (
          <View style={[styles.card, shadow.card]}>
            <Text style={styles.label}>Customer name</Text>
            <TextInput
              style={styles.input}
              value={bill.customer_name}
              onChangeText={(v) => setBill((b) => ({ ...b, customer_name: v }))}
              placeholder="Full name"
              placeholderTextColor={colors.ink3}
            />
            {nameMatches.length > 0 && (
              <View style={styles.suggest}>
                <Text style={styles.suggestHead}>Already in the book — tap to use</Text>
                {nameMatches.map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.suggestItem}
                    onPress={() =>
                      setBill((b) => ({
                        ...b,
                        customer_name: c.name,
                        customer_phone: c.phone ?? b.customer_phone,
                      }))
                    }
                  >
                    <Text style={styles.suggestName}>{c.name}</Text>
                    <Text style={styles.suggestBal}>
                      {Number(c.balance) > 0 ? `${rupees(c.balance)} owed` : "settled"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <Text style={styles.label}>Phone number</Text>
            <TextInput
              style={styles.input}
              value={bill.customer_phone}
              onChangeText={(v) => setBill((b) => ({ ...b, customer_phone: digits(v) }))}
              placeholder="10-digit number"
              placeholderTextColor={colors.ink3}
              keyboardType="number-pad"
              maxLength={10}
            />

            <Text style={styles.label}>Bill number (optional)</Text>
            <TextInput
              style={styles.input}
              value={bill.bill_no}
              onChangeText={(v) => setBill((b) => ({ ...b, bill_no: v }))}
              placeholder="As printed on the bill"
              placeholderTextColor={colors.ink3}
            />

            <View style={styles.two}>
              <View style={styles.half}>
                <Text style={styles.label}>Bill total (₹)</Text>
                <TextInput
                  style={styles.input}
                  value={bill.bill_amount}
                  onChangeText={(v) => setBill((b) => ({ ...b, bill_amount: digits(v) }))}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={colors.ink3}
                />
              </View>
              <View style={styles.half}>
                <Text style={styles.label}>Taken on due (₹)</Text>
                <TextInput
                  style={styles.input}
                  value={bill.due_amount}
                  onChangeText={(v) => setBill((b) => ({ ...b, due_amount: digits(v) }))}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={colors.ink3}
                />
              </View>
            </View>
            {billTotal > 0 && billDue > billTotal && (
              <Text style={styles.warn}>The due amount cannot be more than the bill total.</Text>
            )}
            {billTotal > 0 && billDue > 0 && billDue < billTotal && (
              <Text style={styles.hint}>Paid now: {rupees(billTotal - billDue)}</Text>
            )}

            <Text style={styles.label}>Note (optional)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={bill.note}
              onChangeText={(v) => setBill((b) => ({ ...b, note: v }))}
              placeholder="Anything the owner should know"
              placeholderTextColor={colors.ink3}
              multiline
            />

            <TouchableOpacity
              style={[styles.photoBtn, billPhoto && styles.photoBtnDone]}
              onPress={() => setBillCamera(true)}
            >
              <Ionicons
                name={billPhoto ? "checkmark-circle" : "camera-outline"}
                size={20}
                color={billPhoto ? colors.good : colors.accent}
              />
              <Text style={[styles.photoText, billPhoto && styles.photoTextDone]}>
                {billPhoto ? "Bill photo taken — tap to retake" : "Take a photo of the bill"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.submit, !billReady && styles.submitOff]}
              onPress={saveBill}
              disabled={!billReady || busy}
            >
              {busy ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>Add to khata</Text>}
            </TouchableOpacity>
            {!billReady && !busy && (
              <Text style={styles.needs}>
                Name, both amounts and a photo of the bill are needed.
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      {/* ---------- a customer's page ---------- */}
      {openCustomer && !takingMoney && (
        <View style={styles.sheetWrap}>
          <TouchableOpacity
            style={styles.sheetBackdrop}
            activeOpacity={1}
            onPress={() => setOpenCustomer(null)}
          />
          <ScrollView style={[styles.sheet, shadow.card]} contentContainerStyle={styles.sheetInner}>
            <Text style={styles.sheetName}>{openCustomer.name}</Text>
            <Text style={styles.sheetMeta}>
              {openCustomer.phone ?? "no phone"}
              {" · "}
              {Number(openCustomer.balance) > 0
                ? `${rupees(openCustomer.balance)} owed`
                : Number(openCustomer.balance) < 0
                ? `${rupees(openCustomer.balance)} advance held`
                : "settled"}
            </Text>

            <TouchableOpacity
              style={styles.submit}
              onPress={() => {
                setTakingMoney(true);
                const bal = Number(openCustomer.balance);
                setAmount(bal > 0 ? String(bal) : "");
              }}
            >
              <Text style={styles.submitText}>Take money</Text>
            </TouchableOpacity>

            <Text style={styles.sectionHead}>Bills taken</Text>
            {mySales(openCustomer.id).length === 0 && (
              <Text style={styles.muted}>No bills recorded.</Text>
            )}
            {mySales(openCustomer.id).map((s) => (
              <View style={styles.histLine} key={s.id}>
                <Text style={styles.histDate}>{fmtDay(s.created_at)}</Text>
                <Text style={[styles.histAmt, styles.owed]}>{rupees(s.due_amount)}</Text>
                <Text style={styles.histMeta} numberOfLines={1}>
                  {s.bill_no ? `bill ${s.bill_no}` : "no bill no."}
                  {s.settled_at ? " · paid" : ""}
                </Text>
              </View>
            ))}

            <Text style={styles.sectionHead}>Money received</Text>
            {myPayments(openCustomer.id).length === 0 && (
              <Text style={styles.muted}>Nothing paid yet.</Text>
            )}
            {myPayments(openCustomer.id).map((p) => (
              <View style={styles.histLine} key={p.id}>
                <Text style={styles.histDate}>{fmtDay(p.created_at)}</Text>
                <Text style={[styles.histAmt, styles.advance]}>{rupees(p.amount)}</Text>
                <Text style={styles.histMeta} numberOfLines={1}>
                  {p.method ?? ""}{p.sale_id ? "" : " · on account"}
                </Text>
              </View>
            ))}

            <TouchableOpacity style={styles.sheetCancel} onPress={() => setOpenCustomer(null)}>
              <Text style={styles.sheetCancelText}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* ---------- taking money ---------- */}
      {openCustomer && takingMoney && (
        <View style={styles.sheetWrap}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={resetMoney} />
          <ScrollView style={[styles.sheet, shadow.card]} contentContainerStyle={styles.sheetInner}>
            <Text style={styles.sheetName}>{openCustomer.name}</Text>
            <Text style={styles.sheetMeta}>
              {Number(openCustomer.balance) > 0
                ? `${rupees(openCustomer.balance)} owed`
                : "Nothing owed — this will be kept as an advance"}
            </Text>

            <Text style={styles.label}>Amount received (₹)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={(v) => setAmount(digits(v))}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={colors.ink3}
            />
            {Number(amount || 0) > 0 && Number(amount) > Number(openCustomer.balance) && (
              <Text style={styles.hint}>
                {rupees(Number(amount) - Number(openCustomer.balance))} of this will be held
                as an advance.
              </Text>
            )}

            <Text style={styles.label}>Against</Text>
            <View style={styles.chips}>
              <TouchableOpacity
                style={[styles.chip, againstSale === "" && styles.chipOn]}
                onPress={() => setAgainstSale("")}
              >
                <Text style={[styles.chipText, againstSale === "" && styles.chipTextOn]}>
                  Whole account
                </Text>
              </TouchableOpacity>
              {openBills(openCustomer.id).map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.chip, againstSale === s.id && styles.chipOn]}
                  onPress={() => setAgainstSale(s.id)}
                >
                  <Text style={[styles.chipText, againstSale === s.id && styles.chipTextOn]}>
                    {fmtDay(s.created_at)} · {rupees(Number(s.due_amount) - Number(s.paid_amount))}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>How did they pay?</Text>
            <View style={styles.chips}>
              {METHODS.map((m) => (
                <TouchableOpacity
                  key={m.key}
                  style={[styles.chip, method === m.key && styles.chipOn]}
                  onPress={() => setMethod(m.key)}
                >
                  <Text style={[styles.chipText, method === m.key && styles.chipTextOn]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Reference</Text>
            <TextInput
              style={styles.input}
              value={reference}
              onChangeText={setReference}
              placeholder={REF_HINT[method]}
              placeholderTextColor={colors.ink3}
              autoCapitalize="characters"
            />

            <View style={styles.proofRow}>
              <TouchableOpacity style={styles.proofBtn} onPress={pickProof}>
                <Ionicons name="images-outline" size={18} color={colors.accent} />
                <Text style={styles.proofText}>Screenshot</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.proofBtn} onPress={() => setProofCamera(true)}>
                <Ionicons name="camera-outline" size={18} color={colors.accent} />
                <Text style={styles.proofText}>Photo</Text>
              </TouchableOpacity>
            </View>

            {proof && (
              <View style={styles.proofDone}>
                <Ionicons name="checkmark-circle" size={18} color={colors.good} />
                <Text style={styles.proofDoneText}>Proof attached</Text>
                <TouchableOpacity onPress={() => setProof(null)}>
                  <Text style={styles.proofRemove}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
            {!proof && !reference.trim() && (
              // Encouraged, never required: at a counter taking cash there
              // is often no screenshot to attach and no reference to type,
              // and refusing the entry would leave money unrecorded.
              <Text style={styles.needs}>
                Proof is optional — attach one if you have it, so the owner can
                check this later.
              </Text>
            )}

            <TouchableOpacity
              style={[styles.submit, Number(amount || 0) <= 0 && styles.submitOff]}
              onPress={saveMoney}
              disabled={busy || Number(amount || 0) <= 0}
            >
              {busy ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>Record</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetCancel} onPress={resetMoney}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* choose a colleague */}
      {advPicker && (
        <View style={styles.sheetWrap}>
          <TouchableOpacity
            style={styles.sheetBackdrop}
            activeOpacity={1}
            onPress={() => setAdvPicker(false)}
          />
          <View style={[styles.sheet, shadow.card]}>
            <View style={styles.pickerHead}>
              <Text style={styles.sheetName}>Who took the advance?</Text>
              <TextInput
                style={styles.search}
                value={advSearch}
                onChangeText={setAdvSearch}
                placeholder="Search by name"
                placeholderTextColor={colors.ink3}
                autoCorrect={false}
              />
            </View>
            <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
              {colleagues
                .filter((c) =>
                  c.full_name.toLowerCase().includes(advSearch.trim().toLowerCase()))
                .map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.pickerRow}
                    onPress={() => { setAdvFor(c.id); setAdvPicker(false); setAdvSearch(""); }}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{initialsOf(c.full_name)}</Text>
                    </View>
                    <Text style={styles.pickerRowName} numberOfLines={1}>{c.full_name}</Text>
                    {advFor === c.id && (
                      <Ionicons name="checkmark" size={18} color={colors.good} />
                    )}
                  </TouchableOpacity>
                ))}
              {colleagues.filter((c) =>
                c.full_name.toLowerCase().includes(advSearch.trim().toLowerCase())).length === 0 && (
                <Text style={styles.muted}>
                  {colleagues.length === 0
                    ? "No other active staff at this shop."
                    : "Nobody matches that name."}
                </Text>
              )}
            </ScrollView>
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setAdvPicker(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
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
        onDone={(b64) => { setProofCamera(false); if (b64) setProof(b64); }}
        onCancel={() => setProofCamera(false)}
      />

      <PhotoCapture
        visible={billCamera}
        facing="back"
        hint="Fit the whole bill in the frame"
        askTitle="Photo of the bill"
        askBody="The bill photo is the proof of what the customer owes. It is kept until the owner marks the amount paid."
        allowSkip={false}
        width={1280}
        onDone={(b64) => { setBillCamera(false); if (b64) setBillPhoto(b64); }}
        onCancel={() => setBillCamera(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, paddingTop: 58, paddingBottom: 40 },
  h1: { fontFamily: fonts.extra, fontSize: 26, color: colors.ink },
  sub: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink2, marginTop: 2, marginBottom: 16 },

  segment: {
    flexDirection: "row", gap: 8, marginBottom: 14,
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
    fontFamily: fonts.regular, fontSize: 15, color: colors.ink, marginBottom: 12,
  },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    paddingVertical: 15, paddingHorizontal: 16, marginBottom: 8,
  },
  summary: {
    flexDirection: "row", alignItems: "stretch",
    backgroundColor: colors.surface, borderRadius: radius.md,
    marginTop: 12, marginBottom: 16, overflow: "hidden",
  },
  sumHalf: { flex: 1, padding: 16, gap: 2 },
  sumDivider: { width: 1, backgroundColor: colors.line, marginVertical: 12 },
  sumLabel: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink2 },
  sumGive: { fontFamily: fonts.extra, fontSize: 22, color: colors.good, fontVariant: ["tabular-nums"] },
  sumGet: { fontFamily: fonts.extra, fontSize: 22, color: colors.accent, fontVariant: ["tabular-nums"] },

  avatar: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line,
  },
  avatarText: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink2 },
  rowWho: { flex: 1, gap: 1 },
  rowAgo: { fontFamily: fonts.regular, fontSize: 12, color: colors.ink3 },
  rowDir: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.ink3, marginTop: 1 },
  rowName: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.ink },
  rowRight: { alignItems: "flex-end" },
  rowAmt: { fontFamily: fonts.extra, fontSize: 16, fontVariant: ["tabular-nums"] },
  owed: { color: colors.accent },
  advance: { color: colors.good },
  clear: { color: colors.ink3 },
  advTag: {
    fontFamily: fonts.bold, fontSize: 10, color: colors.good,
    textTransform: "uppercase", letterSpacing: 0.5, marginTop: 1,
  },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 18, gap: 4 },
  label: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink2, marginTop: 12 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: fonts.regular, fontSize: 16, color: colors.ink, marginTop: 5,
  },
  multiline: { minHeight: 68, textAlignVertical: "top" },
  two: { flexDirection: "row", gap: 12 },
  half: { flex: 1 },
  warn: { fontFamily: fonts.bold, fontSize: 13, color: colors.serious, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2, marginTop: 8 },
  muted: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.ink3, marginTop: 4 },
  emptyText: {
    fontFamily: fonts.regular, fontSize: 15, color: colors.ink2,
    textAlign: "center", paddingVertical: 10,
  },

  suggest: {
    backgroundColor: colors.bg, borderRadius: radius.md, padding: 10, marginTop: 8,
    borderWidth: 1, borderColor: colors.line,
  },
  suggestHead: { fontFamily: fonts.bold, fontSize: 12, color: colors.ink3, marginBottom: 6 },
  picker: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.bg,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 14, marginTop: 5,
  },
  pickerChosen: { borderColor: colors.good, backgroundColor: colors.goodBg },
  pickerValue: { fontFamily: fonts.bold, fontSize: 16, color: colors.ink, flex: 1 },
  pickerPlaceholder: { fontFamily: fonts.regular, fontSize: 16, color: colors.ink3, flex: 1 },
  pickerHead: { padding: 22, paddingBottom: 8 },
  pickerList: { maxHeight: 380, paddingHorizontal: 14 },
  pickerRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  pickerRowName: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.ink, flex: 1 },
  advIntro: {
    fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19,
    color: colors.ink2, marginBottom: 4,
  },
  advChosen: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8,
    backgroundColor: colors.goodBg, borderRadius: radius.md, padding: 12,
  },
  advChosenText: { fontFamily: fonts.bold, fontSize: 15, color: colors.good, flex: 1 },
  advChange: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink3 },
  advStatus: { fontFamily: fonts.bold, fontSize: 11, color: colors.amber, marginTop: 1 },
  advOk: { color: colors.good },
  advNo: { color: colors.serious },
  suggestItem: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 8,
  },
  suggestName: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink, flex: 1 },
  suggestBal: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2 },

  photoBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1.5, borderColor: colors.accent, borderStyle: "dashed",
    borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 14, marginTop: 18,
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

  chips: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 6 },
  chip: {
    paddingVertical: 9, paddingHorizontal: 14,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line2,
    backgroundColor: colors.bg,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink2 },
  chipTextOn: { color: "#fff" },

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
    maxHeight: "86%",
  },
  sheetInner: { padding: 22, paddingBottom: 34 },
  sheetName: { fontFamily: fonts.extra, fontSize: 20, color: colors.ink },
  sheetMeta: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink2, marginTop: 2 },
  sheetCancel: { paddingVertical: 14, alignItems: "center", marginTop: 4 },
  sheetCancelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.ink3 },

  sectionHead: {
    fontFamily: fonts.bold, fontSize: 12, color: colors.ink3,
    textTransform: "uppercase", letterSpacing: 0.6, marginTop: 22, marginBottom: 6,
  },
  histLine: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  histDate: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2, width: 66 },
  histAmt: { fontFamily: fonts.bold, fontSize: 14.5, width: 92, fontVariant: ["tabular-nums"] },
  histMeta: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink3, flex: 1 },

  err: { backgroundColor: colors.seriousBg, borderRadius: radius.md, padding: 14, marginBottom: 12 },
  errText: { fontFamily: fonts.bold, fontSize: 14, color: colors.serious },
  ok: { backgroundColor: colors.goodBg, borderRadius: radius.md, padding: 14, marginBottom: 12 },
  okText: { fontFamily: fonts.bold, fontSize: 14, color: colors.good },

  denied: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  deniedTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink },
  deniedBody: {
    fontFamily: fonts.regular, fontSize: 15, lineHeight: 21,
    color: colors.ink2, textAlign: "center",
  },
});
