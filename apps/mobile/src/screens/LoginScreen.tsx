// Two doors:
//  Log in  — mobile number + PIN boxes (auto-submit, shake on error)
//  Join    — new staff self-register with the shop code the owner
//            shared; account waits for owner approval.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";
import { colors, fonts, radius, shadow } from "../lib/theme";

const phoneToEmail = (phone: string) => `${phone}@staff.agamani.app`;

export default function LoginScreen() {
  const [mode, setMode] = useState<"login" | "join">("login");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // join-only fields
  const [name, setName] = useState("");
  const [machineNo, setMachineNo] = useState("");
  const [joinCode, setJoinCode] = useState("");

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
      email: phoneToEmail(phone),
      password: fullPin,
    });
    if (err) {
      setPin("");
      setError(
        err.message.includes("Invalid")
          ? "That number and PIN don't match. Try again, or ask the owner."
          : `Could not log in: ${err.message}`,
      );
      runShake();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setBusy(false);
  };

  const join = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    Keyboard.dismiss();
    try {
      const { data, error: err } = await supabase.functions.invoke("self-register", {
        body: {
          full_name: name.trim(),
          phone,
          pin,
          machine_no: machineNo ? Number(machineNo) : null,
          join_code: joinCode,
        },
      });
      if (err) {
        let msg = err.message;
        try {
          const ctx = await (err as { context?: Response }).context?.json();
          if (ctx?.error) msg = ctx.error;
        } catch { /* keep original */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      // registered — sign straight in; the app shows the waiting screen
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await supabase.auth.signInWithPassword({
        email: phoneToEmail(phone),
        password: pin,
      });
    } catch (e) {
      setError((e as Error).message);
      runShake();
    } finally {
      setBusy(false);
    }
  };

  const onPinChange = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setPin(digits);
    if (mode !== "login") return;
    // auto-submit is a convenience; the Log in button below is the failsafe
    if (digits.length === 6 && phone.length === 10) login(digits);
    else if (digits.length === 6 && phone.length !== 10) {
      setError("Please type your 10-digit mobile number first, then the PIN.");
    }
  };

  const joinReady =
    name.trim().length >= 2 && phone.length === 10 && pin.length === 6 && joinCode.length >= 4;

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Animated.View
            style={{
              opacity: rise,
              transform: [
                { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) },
                { translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-8, 8] }) },
              ],
            }}
          >
            <Image
              source={require("../../assets/logo-wide.png")}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.sub}>Your attendance and salary, in your pocket</Text>

            {/* mode switch */}
            <View style={styles.tabs}>
              <Pressable
                style={[styles.tab, mode === "login" && styles.tabActive]}
                onPress={() => { setMode("login"); setError(null); }}
              >
                <Text style={[styles.tabText, mode === "login" && styles.tabTextActive]}>
                  Log in
                </Text>
              </Pressable>
              <Pressable
                style={[styles.tab, mode === "join" && styles.tabActive]}
                onPress={() => { setMode("join"); setError(null); }}
              >
                <Text style={[styles.tabText, mode === "join" && styles.tabTextActive]}>
                  New staff? Join
                </Text>
              </Pressable>
            </View>

            <View style={[styles.card, shadow.card]}>
              {mode === "join" && (
                <>
                  <Text style={styles.label}>YOUR FULL NAME</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="As the owner knows you"
                    placeholderTextColor={colors.ink3}
                    value={name}
                    onChangeText={setName}
                  />
                  <Text style={[styles.label, styles.gap]}>SHOP CODE</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Ask the owner"
                    placeholderTextColor={colors.ink3}
                    keyboardType="number-pad"
                    maxLength={6}
                    value={joinCode}
                    onChangeText={(v) => setJoinCode(v.replace(/\D/g, ""))}
                  />
                  <Text style={[styles.label, styles.gap]}>
                    MACHINE NUMBER (IF YOU KNOW IT)
                  </Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Your number on the fingerprint machine"
                    placeholderTextColor={colors.ink3}
                    keyboardType="number-pad"
                    maxLength={4}
                    value={machineNo}
                    onChangeText={(v) => setMachineNo(v.replace(/\D/g, ""))}
                  />
                </>
              )}

              <Text style={[styles.label, mode === "join" && styles.gap]}>MOBILE NUMBER</Text>
              <TextInput
                style={styles.input}
                placeholder="10-digit number"
                placeholderTextColor={colors.ink3}
                keyboardType="phone-pad"
                maxLength={10}
                value={phone}
                onChangeText={(v) => setPhone(v.replace(/\D/g, "").slice(0, 10))}
                returnKeyType="next"
                onSubmitEditing={() => pinRef.current?.focus()}
              />

              <Text style={[styles.label, styles.gap]}>
                {mode === "join" ? "CHOOSE A 6-DIGIT PIN" : "PIN"}
              </Text>
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

              {error && <Text style={styles.error}>{error}</Text>}

              <Pressable
                style={[
                  styles.loginBtn,
                  (busy ||
                    (mode === "login"
                      ? phone.length !== 10 || pin.length < 6
                      : !joinReady)) && styles.loginBtnDisabled,
                ]}
                disabled={
                  busy ||
                  (mode === "login" ? phone.length !== 10 || pin.length < 6 : !joinReady)
                }
                onPress={() => (mode === "login" ? login(pin) : join())}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.loginBtnText}>
                    {mode === "login" ? "Log in" : "Join the shop"}
                  </Text>
                )}
              </Pressable>
            </View>

            <Text style={styles.help}>
              {mode === "login"
                ? "First time here? Tap \"New staff? Join\" above."
                : "Remember your PIN — you'll use it every time you change phones."}
            </Text>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 26, paddingVertical: 50 },
  logo: {
    width: "86%",
    height: 110,
    alignSelf: "center",
    marginBottom: 6,
  },
  sub: {
    color: colors.ink3,
    fontSize: 14.5,
    fontFamily: fonts.semi,
    textAlign: "center",
    marginTop: 5,
    marginBottom: 22,
  },
  tabs: {
    flexDirection: "row",
    backgroundColor: "#f3ece1",
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: 14,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.pill,
    alignItems: "center",
  },
  tabActive: { backgroundColor: colors.surface, ...shadow.card },
  tabText: { fontFamily: fonts.extra, fontSize: 14, color: colors.ink3 },
  tabTextActive: { color: colors.accent },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 24,
  },
  label: { color: colors.ink3, fontSize: 11.5, fontFamily: fonts.extra, letterSpacing: 1.2 },
  gap: { marginTop: 18 },
  input: {
    marginTop: 8,
    borderWidth: 1.5,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    padding: 14,
    fontSize: 17,
    fontFamily: fonts.bold,
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
  loginBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
  loginBtnDisabled: { backgroundColor: colors.line2 },
  loginBtnText: { fontFamily: fonts.extra, color: "#fff", fontSize: 16 },
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
