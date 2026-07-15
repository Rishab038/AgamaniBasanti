import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  useFonts,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
  Nunito_900Black,
} from "@expo-google-fonts/nunito";
import type { Session } from "@supabase/supabase-js";
import { Branch, Profile, supabase } from "./src/lib/supabase";
import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";

export default function App() {
  const [fontsLoaded] = useFonts({
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    Nunito_900Black,
  });
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) {
        setProfile(null);
        setBranch(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const { data: p } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", session.user.id)
        .single();
      setProfile(p);
      if (p?.branch_id) {
        const { data: b } = await supabase
          .from("branches")
          .select("*")
          .eq("id", p.branch_id)
          .single();
        setBranch(b);
      }
    })();
  }, [session]);

  if (!fontsLoaded || !ready || (session && (!profile || !branch))) {
    return (
      <View style={styles.loading}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color="#d96f4e" />
        {session && profile && !branch && (
          <Text style={styles.warn}>
            Your profile has no shop assigned yet. Please ask the owner.
          </Text>
        )}
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {session && profile && branch ? (
        <MainScreen profile={profile} branch={branch} />
      ) : (
        <LoginScreen />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "#faf6f0",
  },
  warn: { marginTop: 16, fontSize: 16, color: "#6b5a4c", textAlign: "center" },
});
