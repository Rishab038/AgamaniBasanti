// One-time login: employee code + 6-digit PIN. The owner creates
// each account; code+PIN map to a Supabase email/password under the
// hood. The session persists — workers see this screen exactly once.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { supabase } from "../lib/supabase";
import { colors, radius, shadow } from "../lib/theme";

const codeToEmail = (code: string) =>
  `${code.trim().toLowerCase()}@staff.agamani.app`;

export default function LoginScreen() {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, { toValue: 1, duration: 450, useNativeDriver: true }).start();
  }, [rise]);

  const login = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: codeToEmail(code),
      password: pin,
    });
    if (err) setError(`Could not log in: ${err.message}`);
    setBusy(false);
  };

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[colors.brandDeep, colors.brandDark, colors.brand]}
        style={styles.hero}
      >
        <Text style={styles.heroMark}>অ</Text>
        <Text style={styles.heroTitle}>Agamani Basanti</Text>
        <Text style={styles.heroSub}>Staff attendance</Text>
      </LinearGradient>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Animated.View
          style={[
            styles.card,
            shadow.card,
            {
              opacity: rise,
              transform: [{
                translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }),
              }],
            },
          ]}
        >
          <Text style={styles.label}>Employee code</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. W07"
            placeholderTextColor={colors.ink3}
            autoCapitalize="characters"
            autoCorrect={false}
            value={code}
            onChangeText={setCode}
          />
          <Text style={styles.label}>PIN</Text>
          <TextInput
            style={styles.input}
            placeholder="6 digits"
            placeholderTextColor={colors.ink3}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            value={pin}
            onChangeText={setPin}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity
            style={[styles.button, (busy || !code || pin.length < 6) && styles.buttonDisabled]}
            onPress={login}
            disabled={busy || !code || pin.length < 6}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Log in</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.help}>
            Don't have a code? Ask the shop owner.
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hero: {
    paddingTop: 90,
    paddingBottom: 64,
    alignItems: "center",
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  heroMark: {
    fontSize: 40,
    color: "#fff",
    fontWeight: "800",
    width: 76,
    height: 76,
    lineHeight: 74,
    textAlign: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: 22,
    overflow: "hidden",
    marginBottom: 14,
  },
  heroTitle: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  heroSub: { color: "rgba(255,255,255,0.75)", fontSize: 15, marginTop: 2 },
  body: { flex: 1, padding: 20, marginTop: -36 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: { fontSize: 13, fontWeight: "600", color: colors.ink2, marginBottom: 6, marginTop: 10 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 15,
    fontSize: 18,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  error: { color: colors.serious, fontSize: 14, marginTop: 12, textAlign: "center" },
  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    padding: 17,
    alignItems: "center",
    marginTop: 20,
  },
  buttonDisabled: { backgroundColor: "#b9c4cc" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  help: { textAlign: "center", color: colors.ink3, fontSize: 13, marginTop: 16 },
});
