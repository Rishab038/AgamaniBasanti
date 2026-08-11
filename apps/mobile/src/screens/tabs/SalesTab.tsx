// What I sold today.
//
// A scan is a claim on a barcode and nothing else. No name to type, no
// price to enter, no product list to have been loaded first — Oriel
// already knows what every code is worth, and the barcode is the only
// thing this shop has that Oriel cannot supply for itself: who was
// holding it.
//
// So the whole screen is: point, scan, done. Everything a staff member
// sees afterwards — the item's name, what it came to, whether it counted
// — comes back from the matched bill line once the day's sales arrive
// from Oriel. Nobody here states what their own sale was worth, which is
// exactly why the figure can be trusted.
//
// Two details that are load-bearing:
//
//  * The camera fires onBarcodeScanned many times a second while a code
//    is in frame. Left alone that turns one garment into thirty sales,
//    so a scan is followed by a short deaf period. The pause doubles as
//    the confirmation.
//  * Every code is one physical garment, so scanning the same label
//    twice is a mistake rather than a second sale. The database refuses
//    it and this screen says so plainly.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
// Deep import, not the barrel: `from "@expo/vector-icons"` makes Metro
// bundle the font of EVERY icon family when this app draws Ionicons.
import Ionicons from "@expo/vector-icons/Ionicons";
import { Branch, Profile, supabase } from "../../lib/supabase";
import { colors, fonts, radius, rowEdge, shadow } from "../../lib/theme";
import { fmtClock as fmtTime, groupInr, istToday } from "../../lib/fmt";

type State = "CONFIRMED" | "NOT_FOUND" | "UNDONE" | "AWAITING_IMPORT" | "VOIDED";

type Scan = {
  id: string;
  barcode: string;
  created_at: string;
  item_desc: string | null;
  oriel_amount: number | null;
  state: State;
};

/** the label formats a garment shop actually meets */
const BARCODE_TYPES = [
  "ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93", "itf14", "codabar",
] as const;

// Worded for the person who did the scanning, not for the owner. "Not on
// any bill" is a fact they can act on; anything sharper would be an
// accusation made by a spreadsheet.
const SAY: Record<State, { label: string; tone: "good" | "wait" | "warn" | "bad" }> = {
  CONFIRMED:       { label: "Counted",        tone: "good" },
  AWAITING_IMPORT: { label: "Checking tonight", tone: "wait" },
  UNDONE:          { label: "Returned",       tone: "warn" },
  NOT_FOUND:       { label: "Not on any bill", tone: "bad" },
  VOIDED:          { label: "Removed",        tone: "wait" },
};

const rupees = (n: number) => `₹${groupInr(Number(n))}`;

export default function SalesTab({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  /** what was just added, held on screen while the camera stays deaf */
  const [flash, setFlash] = useState<string | null>(null);
  const cooling = useRef(false);
  const [typing, setTyping] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("sale_verification")
      .select("id, barcode, created_at, item_desc, oriel_amount, state")
      .eq("profile_id", profile.id)
      .eq("sold_on", istToday())
      .order("created_at", { ascending: false });
    if (err) setError(err.message);
    setScans((data as unknown as Scan[]) ?? []);
    setLoading(false);
  }, [profile.id]);

  useEffect(() => { load(); }, [load]);

  const counted = scans.filter((s) => s.state === "CONFIRMED");
  const value = counted.reduce((t, s) => t + Number(s.oriel_amount ?? 0), 0);

  /** the whole write: a barcode, and who was holding it */
  const claim = async (raw: string) => {
    const barcode = raw.trim();
    if (!barcode) return;

    const { data, error: err } = await supabase
      .from("sale_lines")
      .insert({
        branch_id: branch.id,
        profile_id: profile.id,
        barcode,
        qty: 1,
        recorded_by: profile.id,
      })
      .select("id");

    // One code is one garment, so a clash means this exact piece is
    // already claimed — by this person a moment ago, or by a colleague.
    if (err && (err.code === "23505" || /duplicate key/i.test(err.message ?? ""))) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setFlash("Already counted");
      return;
    }
    // an insert refused by RLS returns success with no rows, so the row
    // coming back is the only proof it landed
    if (err || !data || data.length === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err?.message ?? "That did not save. Pull down to refresh and try again.");
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setFlash(barcode);
    await load();
  };

  const onScanned = ({ data }: { data: string }) => {
    if (cooling.current || busy) return;
    cooling.current = true;
    setBusy(true);
    claim(data).finally(() => {
      setBusy(false);
      // long enough that one label cannot fire twice, short enough that
      // the next garment is only a moment behind
      setTimeout(() => { cooling.current = false; setFlash(null); }, 1200);
    });
  };

  const remove = async (s: Scan) => {
    const { data, error: err } = await supabase
      .from("sale_lines").delete().eq("id", s.id).select("id");
    if (err || !data || data.length === 0) {
      setError(err?.message ?? "That could not be removed.");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await load();
  };

  // ---------- the camera ----------
  if (scanning) {
    if (!permission?.granted) {
      return (
        <View style={styles.askWrap}>
          <Ionicons name="barcode-outline" size={44} color={colors.accent} />
          <Text style={styles.askTitle}>Camera needed to read barcodes</Text>
          <Text style={styles.askBody}>
            It only reads the number on the label. Nothing is photographed and
            nothing is stored.
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
            <Text style={styles.linkText}>Go back</Text>
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
          <Text style={styles.camHint}>Point at the barcode on the tag</Text>
          <Text style={styles.camCount}>
            {scans.length} scanned today
          </Text>
        </View>

        <View style={styles.reticle} />

        {flash && (
          <View style={[styles.flash, flash === "Already counted" && styles.flashWarn]}>
            <Ionicons
              name={flash === "Already counted" ? "alert-circle" : "checkmark-circle"}
              size={20}
              color="#fff"
            />
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
            onSubmit={async () => { const c = typing; setTyping(null); await claim(c); }}
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
            <Text style={styles.totalValue}>{scans.length}</Text>
            <Text style={styles.totalLabel}>scanned</Text>
          </View>
          <View style={styles.totalDivider} />
          <View style={styles.totalHalf}>
            <Text style={styles.totalValue}>
              {counted.length > 0 ? rupees(value) : "—"}
            </Text>
            <Text style={styles.totalLabel}>
              {counted.length} counted
            </Text>
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
          <Text style={styles.scanText}>Scan a tag</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.typeLink} onPress={() => setTyping("")}>
          <Text style={styles.linkText}>Tag torn? Type the code</Text>
        </TouchableOpacity>

        {scans.length === 0 && !loading && (
          <Text style={styles.empty}>
            Nothing scanned yet today. Scan each tag as the garment goes out and
            it lands here.
          </Text>
        )}

        {scans.map((s) => {
          const say = SAY[s.state];
          return (
            <View key={s.id} style={[styles.line, rowEdge]}>
              <View style={styles.lineWho}>
                <Text style={styles.lineName} numberOfLines={1}>
                  {s.item_desc ?? s.barcode}
                </Text>
                <Text style={styles.lineSub}>
                  {fmtTime(s.created_at)}
                  {s.item_desc ? ` · ${s.barcode}` : ""}
                </Text>
              </View>
              <View style={styles.lineRight}>
                {s.oriel_amount != null && (
                  <Text style={styles.lineAmt}>{rupees(s.oriel_amount)}</Text>
                )}
                <Text style={[styles.chip, styles[`chip_${say.tone}`]]}>
                  {say.label}
                </Text>
              </View>
              {s.state === "AWAITING_IMPORT" && (
                <TouchableOpacity style={styles.lineDel} onPress={() => remove(s)}>
                  <Ionicons name="close" size={17} color={colors.ink3} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        {scans.length > 0 && (
          <Text style={styles.foot}>
            Tonight the shop's own bills are checked against what you scanned.
            Anything that does not match will say so — tell the owner if it
            looks wrong.
          </Text>
        )}
      </ScrollView>

      {typing !== null && !scanning && (
        <TypeCode
          value={typing}
          onChange={setTyping}
          onCancel={() => setTyping(null)}
          onSubmit={async () => { const c = typing; setTyping(null); await claim(c); }}
        />
      )}
    </View>
  );
}

/** the fallback for a tag that will not read */
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
            The long number printed under the bars on the tag.
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
            <Text style={styles.primaryText}>Add it</Text>
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
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 8,
  },
  lineWho: { flex: 1, gap: 2 },
  lineName: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink },
  lineSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.ink3 },
  lineRight: { alignItems: "flex-end", gap: 3 },
  lineAmt: { fontFamily: fonts.extra, fontSize: 15, color: colors.ink },
  lineDel: { padding: 6 },

  chip: {
    fontFamily: fonts.bold, fontSize: 11,
    paddingVertical: 2, paddingHorizontal: 8, borderRadius: radius.pill,
    overflow: "hidden",
  },
  chip_good: { backgroundColor: colors.goodBg, color: colors.good },
  chip_wait: { backgroundColor: colors.bg, color: colors.ink3 },
  chip_warn: { backgroundColor: colors.amberBg, color: colors.amber },
  chip_bad:  { backgroundColor: colors.seriousBg, color: colors.serious },

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
    backgroundColor: colors.good, borderRadius: radius.pill,
    paddingVertical: 11, paddingHorizontal: 16,
  },
  flashWarn: { backgroundColor: colors.amber },
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
  backdrop: { flex: 1, backgroundColor: "#1c1612bb", justifyContent: "center", padding: 22 },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 22, gap: 12 },
  sheetTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink },
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
