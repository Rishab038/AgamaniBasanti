import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { useFonts } from "expo-font";
import type { Session } from "@supabase/supabase-js";
import { Branch, Profile, supabase } from "./src/lib/supabase";
import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import PendingScreen from "./src/screens/PendingScreen";
import ConsentScreen from "./src/screens/ConsentScreen";

export default function App() {
  // Required file-by-file rather than imported from the package root.
  // `@expo-google-fonts/inter`'s index.js has a top-level require() for
  // all eighteen weights, italics included, so importing three of them
  // still shipped every one — about 6 MB of font for 1 MB of use. Metro
  // cannot drop them: a require() of an asset is a side effect.
  const [fontsLoaded] = useFonts({
    Inter_400Regular: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
    Inter_500Medium: require("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
    Inter_600SemiBold: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
  });
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  // Apply a new app version on launch instead of the launch after.
  //
  // expo-updates downloads on start but, by default, only swaps the
  // bundle in on the NEXT start. So a worker granted billing access
  // opened the app, saw no Credit tab, and had no way of knowing the
  // answer was "close it and open it again". Checking and reloading
  // here makes one open enough. Runs once per session and stays silent
  // on failure — a missing update must never stop someone checking in.
  const updateChecked = useRef(false);
  useEffect(() => {
    if (__DEV__ || updateChecked.current) return;
    updateChecked.current = true;
    (async () => {
      try {
        const res = await Updates.checkForUpdateAsync();
        if (res.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch {
        // offline, or the update server is unreachable — carry on
      }
    })();
  }, []);
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

  // Keep the profile current while the app is open. The owner granting
  // billing-counter access, changing a shift or approving a pending
  // worker all land here, so none of them need a reinstall to take
  // effect. RLS limits this subscription to the signed-in worker's own
  // row (see migration 0035).
  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel(`me:${session.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${session.user.id}`,
        },
        (payload) => setProfile(payload.new as Profile),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
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
      {session && profile && !profile.active ? (
        <PendingScreen profile={profile} onApproved={setProfile} />
      ) : session && profile && profile.role === "worker" && !profile.consent_at ? (
        <ConsentScreen profile={profile} onAccepted={setProfile} />
      ) : session && profile && branch ? (
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
  warn: { marginTop: 16, fontSize: 15, color: "#6b5a4c", textAlign: "center" },
});
