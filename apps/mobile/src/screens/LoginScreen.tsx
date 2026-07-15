// One-time login: employee code + 6-digit PIN entered into PIN
// boxes (auto-submits on the 6th digit). Code+PIN map to a Supabase
// email/password under the hood; the session persists so workers
// see this screen exactly once.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";
import { colors, gradients, radius, shadow } from "../lib/theme";

const codeToEmail = (code: string) =>
  `${code.trim().toLowerCase()}@staff.agamani.app`;

export default function LoginScreen() {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<TextInput>(null);
  const rise = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [rise]);

  const runShake = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const login = async (fullPin: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    Keyboard.dismiss();
    const { error: err } = await supabase.auth.signInWithPassword({
      email: codeToEmail(code),
      password: fullPin,
    });
    if (err) {
      setPin("");
      setError(
        err.message.includes("Invalid")
          ? "That code and PIN don't match. Try again or ask the owner."
          : `Could not log in: ${err.message}`,
      );
      runShake();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setBusy(false);
  };

  const onPinChange = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setPin(digits);
    if (digits.length === 6 && code.trim()) login(digits);
  };

  return (
    <LinearGradient colors={gradients.screen} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Animated.View
          style={[
            styles.inner,
            {
              opacity: rise,
              transform: [
                { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) },
                { translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-8, 8] }) },
              ],
            },
          ]}
        >
          <View style={[styles.mark, shadow.glowTeal]}>
            <Text style={styles.markText}>অ</Text>
          </View>
          <Text style={styles.title}>Agamani Basanti</Text>
          <Text style={styles.sub}>Your attendance, your salary — in your pocket</Text>

          <View style={[styles.card, shadow.card]}>
            <Text style={styles.label}>EMPLOYEE CODE</Text>
            <TextInput
              style={styles.codeInput}
              placeholder="W07"
              placeholderTextColor={colors.ink3}
              autoCapitalize="characters"
              autoCorrect={false}
              value={code}
              onChangeText={(v) => setCode(v.toUpperCase())}
              returnKeyType="next"
              onSubmitEditing={() => pinRef.current?.focus()}
            />

            <Text style={[styles.label, { marginTop: 22 }]}>PIN</Text>
            <Pressable onPress={() => pinRef.current?.focus()} style={styles.pinRow}>
              {Array.from({ length: 6 }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.pinBox,
                    pin.length === i && styles.pinBoxActive,
                    pin.length > i && styles.pinBoxFilled,
                  ]}
                >
                  {pin.length > i && <View style={styles.pinDot} />}
                </View>
              ))}
            </Pressable>
            {/* hidden real input drives the boxes */}
            <TextInput
              ref={pinRef}
              style={styles.hiddenInput}
              keyboardType="number-pad"
              value={pin}
              onChangeText={onPinChange}
              maxLength={6}
            />

            {busy && <ActivityIndicator color={colors.brand} style={{ marginTop: 18 }} />}
            {error && <Text style={styles.error}>{error}</Text>}
          </View>

          <Text style={styles.help}>No code yet? Ask the shop owner to add you.</Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  inner: { flex: 1, justifyContent: "center", padding: 26 },
  mark: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: colors.brandDeep,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 18,
  },
  markText: { fontSize: 34, color: "#fff", fontWeight: "800" },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  sub: { color: colors.ink2, fontSize: 14.5, textAlign: "center", marginTop: 6, marginBottom: 30 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.lg,
    padding: 24,
  },
  label: { color: colors.ink3, fontSize: 12, fontWeight: "700", letterSpacing: 1.2 },
  codeInput: {
    marginTop: 8,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.04)",
    padding: 15,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
    color: colors.ink,
  },
  pinRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  pinBox: {
    flex: 1,
    height: 56,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  pinBoxActive: { borderColor: colors.brand },
  pinBoxFilled: { borderColor: colors.brandDeep },
  pinDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand },
  hiddenInput: { position: "absolute", opacity: 0, height: 1, width: 1 },
  error: { color: colors.serious, fontSize: 14, marginTop: 18, textAlign: "center", lineHeight: 20 },
  help: { color: colors.ink3, fontSize: 13, textAlign: "center", marginTop: 22 },
});
