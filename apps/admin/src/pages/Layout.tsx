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
} from "lucide-react";
import { supabase } from "../lib/supabase";

export default function Layout() {
  const location = useLocation();
  const [pendingCount, setPendingCount] = useState(0);

  // approvals badge — refreshed on every page change
  useEffect(() => {
    supabase
      .from("advances")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING")
      .then(({ count }) => setPendingCount(count ?? 0));
  }, [location.pathname]);

  const links = [
    { to: "/", label: "Today", icon: LayoutDashboard },
    { to: "/staff", label: "Staff", icon: Users },
    { to: "/attendance", label: "Attendance", icon: CalendarCheck2 },
    { to: "/approvals", label: "Approvals", icon: BadgeCheck, count: pendingCount },
    { to: "/salary", label: "Salary", icon: ReceiptIndianRupee },
    { to: "/settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">অ</div>
          <div>
            <div className="name">Agamani</div>
            <div className="tag">Basanti · Cloth House</div>
          </div>
        </div>
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
