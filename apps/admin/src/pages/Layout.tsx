import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  CalendarCheck2,
  LayoutDashboard,
  LogOut,
  Settings2,
  Users,
  BadgeCheck,
  ReceiptIndianRupee,
  NotebookPen,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";

export default function Layout() {
  const location = useLocation();
  const [pendingCount, setPendingCount] = useState(0);
  const [creditCount, setCreditCount] = useState(0);
  const { branches, branchId, setBranchId, branch } = useBranch();

  // approvals badge — for the shop currently being viewed
  useEffect(() => {
    if (!branchId) return;
    supabase
      .from("advances")
      .select("id, profiles!advances_profile_id_fkey!inner(branch_id)", {
        count: "exact", head: true,
      })
      .eq("status", "PENDING")
      .eq("profiles.branch_id", branchId)
      .then(({ count }) => setPendingCount(count ?? 0));

    // unpaid credit customers — money still out on the street
    supabase
      .from("credit_sales")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .is("settled_at", null)
      .then(({ count }) => setCreditCount(count ?? 0));
  }, [location.pathname, branchId]);

  const links = [
    { to: "/", label: "Today", icon: LayoutDashboard },
    { to: "/staff", label: "Staff", icon: Users },
    { to: "/attendance", label: "Attendance", icon: CalendarCheck2 },
    { to: "/approvals", label: "Approvals", icon: BadgeCheck, count: pendingCount },
    { to: "/credit", label: "Credit", icon: NotebookPen, count: creditCount },
    { to: "/salary", label: "Salary", icon: ReceiptIndianRupee },
    { to: "/settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="Agamani Basanti" className="brand-logo" />
        </div>

        {/* shop switcher — the whole dashboard follows this choice */}
        {branches.length > 1 && (
          <div className="branch-switch">
            {branches.map((b) => (
              <button
                key={b.id}
                className={b.id === branchId ? "branch-btn active" : "branch-btn"}
                onClick={() => setBranchId(b.id)}
                title={`Show ${b.name}`}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        {branches.length === 1 && branch && (
          <div className="branch-single">{branch.name}</div>
        )}
        <nav>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) => (isActive ? "nav active" : "nav")}
            >
              <l.icon />
              {l.label}
              {l.count ? <span className="count">{l.count}</span> : null}
            </NavLink>
          ))}
        </nav>
        <button className="logout" onClick={() => supabase.auth.signOut()}>
          <LogOut size={15} />
          Log out
        </button>
      </aside>
      <main className="content">
        <div className="page" key={location.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
