// Push registration.
//
// The token is stored on the worker's profile so the server can reach
// their phone. Registration is best-effort: a worker who declines
// notifications must still be able to check in, so every failure here
// is swallowed rather than surfaced.

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { supabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPush(profileId: string): Promise<void> {
  try {
    if (!Device.isDevice) return;   // simulators cannot receive push

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Shift reminders",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const asked = await Notifications.requestPermissionsAsync();
      status = asked.status;
    }
    if (status !== "granted") return;

    const projectId = "8c206c4b-970e-47b7-90f7-bfdb5e0783c0";
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;

    await supabase.from("profiles").update({ push_token: token }).eq("id", profileId);
  } catch {
    // notifications are a convenience; never block attendance on them
  }
}
