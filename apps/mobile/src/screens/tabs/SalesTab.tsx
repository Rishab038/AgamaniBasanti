// What I sold today.
//
// Oriel already prints a barcode onto every product and already knows
// what each one costs. The only thing it does not record is who made
// the sale, so that is the only thing this asks for: point the camera at
// the label, and the item joins your day.
//
// The camera fires onBarcodeScanned many times a second while a code is
// in frame. Left alone that turns one shirt into thirty sales, so a scan
// is followed by a short confirmation during which nothing is read. The
// pause doubles as the feedback — you see what you just added — and it
// still lets you scan a second identical item straight after, which is
// how quantity is counted here.
//
// A code nobody has named yet stops the camera and asks for a name and
// a price, once. Every later scan of that code anywhere in either shop
// is instant.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { Branch, Profile, supabase } from "../../lib/supabase";
import { colors, fonts, radius, shadow } from "../../lib/theme";

type Line = {
  id: string;
  barcode: string;
  qty: number;
  unit_price: number;
  amount: number;
  created_at: string;
  products: { name: string } | null;
};

/** the label formats a garment shop actually meets */
const BARCODE_TYPES = [
  "ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93", "itf14", "codabar",
] as const;

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtTime = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", {
    hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  });

/** a price as typed: digits only, no leading zeros */
const money = (s: string) => s.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");

export default function SalesTab({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  /** what was just added, held on screen while the camera stays deaf */
  const [flash, setFlash] = useState<string | null>(null);
  const cooling = useRef(false);

  /** a code with no name yet, or one typed by hand */
  const [naming, setNaming] = useState<
    { barcode: string; name: string; price: string; qty: string; known: boolean } | null
  >(null);
  const [typing, setTyping] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("sale_lines")
      .select("id, barcode, qty, unit_price, amount, created_at, products(name)")
      .eq("profile_id", profile.id)
      .eq("sold_on", istToday())
      .order("created_at", { ascending: false });
    if (err) setError(err.message);
    setLines((data as unknown as Line[]) ?? []);
    setLoading(false);
  }, [profile.id]);

  useEffect(() => { load(); }, [load]);

  const items = lines.reduce((t, l) => t + l.qty, 0);
  const value = lines.reduce((t, l) => t + Number(l.amount), 0);

  /** put one line in the book; the caller has already resolved the price */
  const addLine = async (
    barcode: string, productId: string | null, unitPrice: number, qty: number, name: string,
  ) => {
    const { data, error: err } = await supabase
      .from("sale_lines")
      .insert({
        branch_id: branch.id,
        profile_id: profile.id,
        product_id: productId,
        barcode,
        qty,
        unit_price: unitPrice,
        recorded_by: profile.id,
      })
      .select("id");

    // an insert refused by RLS comes back as success with no rows, so
    // the row coming back is the only proof it landed
    if (err || !data || data.length === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err?.message ?? "That sale was not saved. Pull down to refresh and try again.");
      return false;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setFlash(`${name} · ${rupees(unitPrice * qty)}`);
    await load();
    return true;
  };

  /** a barcode has arrived, from the camera or from the keyboard */
  const resolve = async (raw: string) => {
    const barcode = raw.trim();
    if (!barcode) return;

    const { data: p, error: err } = await supabase
      .from("products")
      .select("id, name, price")
      .eq("barcode", barcode)
      .maybeSingle();

    if (err) { setError(err.message); return; }

    // known, and priced: straight into the book without a keystroke
    if (p && p.price != null) {
      await addLine(barcode, p.id, Number(p.price), 1, p.name);
      return;
    }

    // known but never priced, or not known at all — ask, once
    setScanning(false);
    setNaming({
      barcode,
      name: p?.name ?? "",
      price: "",
      qty: "1",
      known: !!p,
    });
  };

  const onScanned = ({ data }: { data: string }) => {
    if (cooling.current || busy) return;
    cooling.current = true;
    setBusy(true);
    resolve(data).finally(() => {
      setBusy(false);
      // long enough that one label cannot fire twice, short enough that
      // a second identical garment is only a moment behind
      setTimeout(() => { cooling.current = false; setFlash(null); }, 1400);
    });
  };

  /** finish naming a code, then log the sale against it */
  const saveNaming = async () => {
    if (!naming || busy) return;
    const name = naming.name.trim();
    const price = Number(naming.price || 0);
    const qty = Math.max(1, Number(naming.qty || 1));
    if (!name) { setError("Give the item a name so it is recognised next time."); return; }
    setBusy(true);
    setError(null);
    try {
      let productId: string | null = null;

      if (naming.known) {
        // it already exists but carries no price; only the owner may set
        // one, so the price rides on this sale alone
        const { data } = await supabase
          .from("products").select("id").eq("barcode", naming.barcode).maybeSingle();
        productId = data?.id ?? null;
      } else {
        const { data, error: cErr } = await supabase
          .from("products")
          .insert({
            barcode: naming.barcode,
            name,
            price,
            created_by: profile.id,
          })
          .select("id")
          .single();
        // somebody else may have named the same code a second earlier
        if (cErr) {
          const { data: again } = await supabase
            .from("products").select("id").eq("barcode", naming.barcode).maybeSingle();
          if (!again) { setError(cErr.message); return; }
          productId = again.id;
        } else {
          productId = data.id;
        }
      }

      if (await addLine(naming.barcode, productId, price, qty, name)) setNaming(null);
    } finally {
      setBusy(false);
    }
  };

  const removeLine = async (l: Line) => {
    const { data, error: err } = await supabase
      .from("sale_lines").delete().eq("id", l.id).select("id");
    if (err || !data || data.length === 0) {
      setError(err?.message ?? "That line could not be removed.");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await load();
  };

  // ---------- the scanner ----------
  if (scanning) {
    if (!permission?.granted) {
      return (
        <View style={styles.askWrap}>
          <Ionicons name="barcode-outline" size={44} color={colors.accent} />
          <Text style={styles.askTitle}>Camera needed to read barcodes</Text>
          <Text style={styles.askBody}>
            The camera only reads the code on the label. Nothing is photographed
            and nothing is stored.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={async () => {
              const res = await requestPermission();
              if (!res.granted) setScanning(false);
            }}
          >
            <Text style={styles.primaryText}>Allow camera</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setScanning(false)}>
            <Text style={styles.linkText}>Type the code instead</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.camRoot}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
          onBarcodeScanned={onScanned}
        />
        <View style={styles.camTop}>
          <Text style={styles.camHint}>Point at the barcode on the label</Text>
          <Text style={styles.camCount}>
            {items} item{items === 1 ? "" : "s"} · {rupees(value)} today
          </Text>
        </View>

        <View style={styles.reticle} />

        {flash && (
          <View style={styles.flash}>
            <Ionicons name="checkmark-circle" size={20} color="#fff" />
            <Text style={styles.flashText}>{flash}</Text>
          </View>
        )}

        <View style={styles.camBottom}>
          <TouchableOpacity style={styles.camBtn} onPress={() => setTyping("")}>
            <Ionicons name="keypad-outline" size={18} color={colors.ink} />
            <Text style={styles.camBtnText}>Type code</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.camBtn, styles.camDone]}
            onPress={() => { setScanning(false); setFlash(null); }}
          >
            <Text style={styles.camDoneText}>Done</Text>
          </TouchableOpacity>
        </View>

        {typing !== null && (
          <TypeCode
            value={typing}
            onChange={setTyping}
            onCancel={() => setTyping(null)}
            onSubmit={async () => { const c = typing; setTyping(null); await resolve(c); }}
          />
        )}
      </View>
    );
  }

  // ---------- the day ----------
  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      >
        <Text style={styles.h1}>My sales today</Text>

        <View style={[styles.totals, shadow.card]}>
          <View style={styles.totalHalf}>
            <Text style={styles.totalValue}>{items}</Text>
            <Text style={styles.totalLabel}>item{items === 1 ? "" : "s"}</Text>
          </View>
          <View style={styles.totalDivider} />
          <View style={styles.totalHalf}>
            <Text style={styles.totalValue}>{rupees(value)}</Text>
            <Text style={styles.totalLabel}>sold</Text>
          </View>
        </View>

        {error && (
          <TouchableOpacity style={styles.error} onPress={() => setError(null)}>
            <Text style={styles.errorText}>{error}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.scanBtn, shadow.button]}
          onPress={() => { setError(null); setScanning(true); }}
          activeOpacity={0.85}
        >
          <Ionicons name="barcode-outline" size={26} color="#fff" />
          <Text style={styles.scanText}>Scan a barcode</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.typeLink} onPress={() => setTyping("")}>
          <Text style={styles.linkText}>Label torn? Type the code</Text>
        </TouchableOpacity>

        {lines.length === 0 && !loading && (
          <Text style={styles.empty}>
            Nothing logged yet today. Scan each item as it goes out and it lands here.
          </Text>
        )}

        {lines.map((l) => (
          <View key={l.id} style={styles.line}>
            <View style={styles.lineWho}>
              <Text style={styles.lineName} numberOfLines={1}>
                {l.products?.name ?? l.barcode}
              </Text>
              <Text style={styles.lineSub}>
                {fmtTime(l.created_at)}
                {l.qty > 1 ? ` · ${l.qty} × ${rupees(l.unit_price)}` : ""}
              </Text>
            </View>
            <Text style={styles.lineAmt}>{rupees(Number(l.amount))}</Text>
            <TouchableOpacity style={styles.lineDel} onPress={() => removeLine(l)}>
              <Ionicons name="close" size={17} color={colors.ink3} />
            </TouchableOpacity>
          </View>
        ))}

        {lines.length > 0 && (
          <Text style={styles.foot}>
            A mistake can be removed today. After tonight it is the owner's to correct.
          </Text>
        )}
      </ScrollView>

      {typing !== null && !scanning && (
        <TypeCode
          value={typing}
          onChange={setTyping}
          onCancel={() => setTyping(null)}
          onSubmit={async () => { const c = typing; setTyping(null); await resolve(c); }}
        />
      )}

      {naming && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setNaming(null)}>
          <KeyboardAvoidingView
            style={styles.backdrop}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>
                {naming.known ? "What does this cost?" : "New item"}
              </Text>
              <Text style={styles.sheetCode}>{naming.barcode}</Text>
              <Text style={styles.sheetBody}>
                {naming.known
                  ? "This code has a name but no price yet. What it sells for today:"
                  : "Nobody has named this code yet. Name it once and every later scan, in either shop, is instant."}
              </Text>

              {!naming.known && (
                <TextInput
                  style={styles.input}
                  placeholder="Item name"
                  placeholderTextColor={colors.ink3}
                  value={naming.name}
                  onChangeText={(t) => setNaming({ ...naming, name: t })}
                  autoFocus
                />
              )}
              <TextInput
                style={styles.input}
                placeholder="Price (₹)"
                placeholderTextColor={colors.ink3}
                keyboardType="number-pad"
                value={naming.price}
                onChangeText={(t) => setNaming({ ...naming, price: money(t) })}
                autoFocus={naming.known}
              />
              <TextInput
                style={styles.input}
                placeholder="How many"
                placeholderTextColor={colors.ink3}
                keyboardType="number-pad"
                value={naming.qty}
                onChangeText={(t) => setNaming({ ...naming, qty: t.replace(/[^0-9]/g, "") })}
              />

              <TouchableOpacity
                style={[styles.primaryBtn, busy && styles.btnOff]}
                disabled={busy}
                onPress={saveNaming}
              >
                {busy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.primaryText}>Add to my sales</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setNaming(null)} disabled={busy}>
                <Text style={styles.linkText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}
    </View>
  );
}

/** the fallback for a label that will not read */
function TypeCode({
  value, onChange, onCancel, onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Type the code</Text>
          <Text style={styles.sheetBody}>
            The long number printed under the bars on the label.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Barcode"
            placeholderTextColor={colors.ink3}
            keyboardType="number-pad"
            autoFocus
            value={value}
            onChangeText={onChange}
          />
          <TouchableOpacity
            style={[styles.primaryBtn, !value.trim() && styles.btnOff]}
            disabled={!value.trim()}
            onPress={onSubmit}
          >
            <Text style={styles.primaryText}>Look it up</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCancel}>
            <Text style={styles.linkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, paddingBottom: 40, gap: 12 },
  h1: { fontFamily: fonts.extra, fontSize: 22, color: colors.ink },

  totals: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 16,
  },
  totalHalf: { flex: 1, alignItems: "center", gap: 2 },
  totalDivider: { width: 1, backgroundColor: colors.line, marginVertical: 6 },
  totalValue: { fontFamily: fonts.extra, fontSize: 26, color: colors.accent },
  totalLabel: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.ink2 },

  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 18,
    marginTop: 4,
  },
  scanText: { fontFamily: fonts.extra, fontSize: 17, color: "#fff" },
  typeLink: { alignItems: "center", paddingVertical: 4 },

  empty: {
    fontFamily: fonts.regular, fontSize: 14, color: colors.ink3,
    textAlign: "center", marginTop: 18, lineHeight: 21, paddingHorizontal: 10,
  },
  foot: {
    fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink3,
    marginTop: 6, lineHeight: 18,
  },

  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 8,
  },
  lineWho: { flex: 1, gap: 2 },
  lineName: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink },
  lineSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.ink3 },
  lineAmt: { fontFamily: fonts.extra, fontSize: 15, color: colors.accent },
  lineDel: { padding: 8 },

  error: { backgroundColor: colors.seriousBg, borderRadius: radius.sm, padding: 12 },
  errorText: { fontFamily: fonts.bold, fontSize: 13, color: colors.serious, lineHeight: 19 },

  // ---- camera ----
  camRoot: { flex: 1, backgroundColor: "#000" },
  camTop: { position: "absolute", top: 60, left: 0, right: 0, alignItems: "center", gap: 4 },
  camHint: { fontFamily: fonts.bold, fontSize: 15, color: "#fff" },
  camCount: { fontFamily: fonts.regular, fontSize: 13, color: "#e6dcd2" },
  reticle: {
    position: "absolute",
    top: "34%", left: "12%", right: "12%", height: 150,
    borderWidth: 2, borderColor: "#ffffffaa", borderRadius: 14,
  },
  flash: {
    position: "absolute", top: "58%", left: 24, right: 24,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.good, borderRadius: radius.pill, paddingVertical: 11, paddingHorizontal: 16,
  },
  flashText: { fontFamily: fonts.bold, fontSize: 14, color: "#fff", flexShrink: 1 },
  camBottom: {
    position: "absolute", bottom: 44, left: 20, right: 20,
    flexDirection: "row", justifyContent: "space-between", gap: 12,
  },
  camBtn: {
    flexDirection: "row", alignItems: "center", gap: 7,
    backgroundColor: colors.surface, borderRadius: radius.pill,
    paddingVertical: 12, paddingHorizontal: 18,
  },
  camBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink },
  camDone: { backgroundColor: colors.accent },
  camDoneText: { fontFamily: fonts.extra, fontSize: 14, color: "#fff" },

  // ---- sheets ----
  askWrap: {
    flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center",
    padding: 30, gap: 12,
  },
  askTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink, textAlign: "center" },
  askBody: {
    fontFamily: fonts.regular, fontSize: 14, color: colors.ink2,
    textAlign: "center", lineHeight: 21, marginBottom: 6,
  },
  backdrop: {
    flex: 1, backgroundColor: "#1c1612bb", justifyContent: "center", padding: 22,
  },
  sheet: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: 22, gap: 12,
  },
  sheetTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink },
  sheetCode: {
    fontFamily: fonts.bold, fontSize: 13, color: colors.accent,
    backgroundColor: colors.accentSoft, borderRadius: 6,
    paddingVertical: 4, paddingHorizontal: 9, alignSelf: "flex-start",
  },
  sheetBody: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.ink2, lineHeight: 20 },
  input: {
    backgroundColor: colors.bg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line2,
    paddingVertical: 12, paddingHorizontal: 14,
    fontFamily: fonts.bold, fontSize: 15, color: colors.ink,
  },
  primaryBtn: {
    backgroundColor: colors.accent, borderRadius: radius.sm,
    paddingVertical: 14, alignItems: "center", marginTop: 2,
  },
  primaryText: { fontFamily: fonts.extra, fontSize: 15, color: "#fff" },
  btnOff: { opacity: 0.5 },
  linkText: {
    fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink2,
    textAlign: "center", paddingVertical: 8,
  },
});
