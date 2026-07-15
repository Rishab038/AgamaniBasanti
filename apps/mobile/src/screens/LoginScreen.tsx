// One-time login: employee code + 6-digit PIN in familiar PIN boxes
// (auto-submits on the 6th digit, shakes on a wrong PIN). Code+PIN
// map to a Supabase email/password; the session persists so workers
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
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";
import { colors, fonts, radius, shadow } from "../lib/theme";

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
    Animated.timing(rise, { toValue: 1, duration: 450, useNativeDriver: true }).start();
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
          ? "That code and PIN don't match. Try again, or ask the owner."
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
    <View style={styles.root}>
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
                { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) },
                { translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-8, 8] }) },
              ],
            },
          ]}
        >
          <View style={[styles.mark, shadow.button]}>
            <Text style={styles.markText}>অ</Text>
          </View>
          <Text style={styles.title}>Agamani Basanti</Text>
          <Text style={styles.sub}>Your attendance and salary, in your pocket</Text>

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

            <Text style={[styles.label, { marginTop: 20 }]}>PIN</Text>
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
            <TextInput
              ref={pinRef}
              style={styles.hiddenInput}
              keyboardType="number-pad"
              value={pin}
              onChangeText={onPinChange}
              maxLength={6}
            />

            {busy && <ActivityIndicator color={colors.accent} style={{ marginTop: 18 }} />}
            {error && <Text style={styles.error}>{error}</Text>}
          </View>

          <Text style={styles.help}>No code yet? Ask the shop owner to add you.</Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  inner: { flex: 1, justifyContent: "center", padding: 26 },
  mark: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 16,
  },
  markText: { fontSize: 34, color: "#fff", fontFamily: fonts.black },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontFamily: fonts.black,
    textAlign: "center",
    letterSpacing: -0.5,
  },
  sub: {
    color: colors.ink3,
    fontSize: 14.5,
    fontFamily: fonts.semi,
    textAlign: "center",
    marginTop: 5,
    marginBottom: 28,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 24,
  },
  label: { color: colors.ink3, fontSize: 11.5, fontFamily: fonts.extra, letterSpacing: 1.2 },
  codeInput: {
    marginTop: 8,
    borderWidth: 1.5,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    padding: 14,
    fontSize: 20,
    fontFamily: fonts.extra,
    letterSpacing: 2,
    color: colors.ink,
  },
  pinRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  pinBox: {
    flex: 1,
    height: 54,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.line2,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pinBoxActive: { borderColor: colors.accent },
  pinBoxFilled: { borderColor: colors.accentDeep, backgroundColor: colors.accentSoft },
  pinDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent },
  hiddenInput: { position: "absolute", opacity: 0, height: 1, width: 1 },
  error: {
    color: colors.serious,
    fontSize: 14,
    fontFamily: fonts.bold,
    marginTop: 16,
    textAlign: "center",
    lineHeight: 20,
  },
  help: {
    color: colors.ink3,
    fontSize: 13,
    fontFamily: fonts.semi,
    textAlign: "center",
    marginTop: 20,
  },
});
