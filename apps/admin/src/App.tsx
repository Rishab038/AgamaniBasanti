import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { BranchProvider } from "./lib/branch";
import Login from "./pages/Login";
import Layout from "./pages/Layout";
import Dashboard from "./pages/Dashboard";
import Staff from "./pages/Staff";
import Attendance from "./pages/Attendance";
import Approvals from "./pages/Approvals";
import Credit from "./pages/Credit";
import CreditCustomer from "./pages/CreditCustomer";
import Settings from "./pages/Settings";
import Salary from "./pages/Salary";

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
          <Route element={<BranchProvider><Layout /></BranchProvider>}>
            <Route index element={<Dashboard />} />
            <Route path="staff" element={<Staff />} />
            <Route path="attendance" element={<Attendance />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="credit" element={<Credit />} />
            <Route path="credit/:id" element={<CreditCustomer />} />
            <Route path="salary" element={<Salary />} />
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
