// One-time login: employee code + 6-digit PIN. The owner creates
// each account; under the hood code+PIN map to a Supabase
// email/password (no SMS OTP — that would cost money). The session
// persists, so workers see this screen exactly once.

import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";

// employee_code "W07" -> w07@staff.agamani.app
const codeToEmail = (code: string) =>
  `${code.trim().toLowerCase()}@staff.agamani.app`;

export default function LoginScreen() {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: codeToEmail(code),
      password: pin,
    });
    if (err) setError("Wrong code or PIN. Please ask the owner for help.");
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title}>Agamani Basanti</Text>
      <Text style={styles.subtitle}>Staff Attendance</Text>

      <TextInput
        style={styles.input}
        placeholder="Employee Code (e.g. W07)"
        autoCapitalize="characters"
        autoCorrect={false}
        value={code}
        onChangeText={setCode}
      />
      <TextInput
        style={styles.input}
        placeholder="6-digit PIN"
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
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>LOG IN</Text>
        )}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 32, fontWeight: "700", textAlign: "center", color: "#1a1a2e" },
  subtitle: { fontSize: 18, textAlign: "center", color: "#666", marginBottom: 40 },
  input: {
    borderWidth: 2,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 18,
    fontSize: 20,
    marginBottom: 16,
  },
  error: { color: "#c0392b", fontSize: 16, textAlign: "center", marginBottom: 12 },
  button: {
    backgroundColor: "#16a085",
    borderRadius: 16,
    padding: 22,
    alignItems: "center",
  },
  buttonDisabled: { backgroundColor: "#aaa" },
  buttonText: { color: "#fff", fontSize: 22, fontWeight: "700" },
});
