import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — copy .env.example to .env",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true, // workers log in once, then never see the login screen
    detectSessionInUrl: false,
  },
});

export type Profile = {
  id: string;
  employee_code: string;
  full_name: string;
  role: "owner" | "supervisor" | "worker";
  branch_id: string | null;
  shift_id: string | null;
  device_id: string | null;
  base_salary: number;
};

export type Branch = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  wifi_ssid: string | null;
};
