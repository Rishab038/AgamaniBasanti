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
  phone: string | null;
  active: boolean;
  approved_at: string | null;
  consent_at: string | null;
  shift_start: string | null;
  shift_end: string | null;
  lunch_minutes: number;
  /** owner-granted: may record credit sales at the billing counter */
  can_bill: boolean;
};

export type CreditSale = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  bill_no: string | null;
  bill_amount: number;
  due_amount: number;
  /** sum of payments taken so far; balance is due_amount - paid_amount */
  paid_amount: number;
  note: string | null;
  settled_at: string | null;
  created_at: string;
};

export type Branch = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  wifi_ssid: string | null;
};
