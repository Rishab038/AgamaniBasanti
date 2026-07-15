import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Layout from "./pages/Layout";
import Dashboard from "./pages/Dashboard";
import Staff from "./pages/Staff";
import Attendance from "./pages/Attendance";
import Settings from "./pages/Settings";
import { Advances, Payroll } from "./pages/stubs";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return null;

  return (
    <BrowserRouter>
      <Routes>
        {session ? (
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="staff" element={<Staff />} />
            <Route path="attendance" element={<Attendance />} />
            <Route path="advances" element={<Advances />} />
            <Route path="payroll" element={<Payroll />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Login />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
