import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  CalendarCheck2,
  LayoutDashboard,
  LogOut,
  Settings2,
  Users,
  Wallet,
  ReceiptIndianRupee,
} from "lucide-react";
import { supabase } from "../lib/supabase";

const links = [
  { to: "/", label: "Today", icon: LayoutDashboard },
  { to: "/staff", label: "Staff", icon: Users },
  { to: "/attendance", label: "Attendance", icon: CalendarCheck2 },
  { to: "/advances", label: "Advances", icon: Wallet },
  { to: "/payroll", label: "Payroll", icon: ReceiptIndianRupee },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">অ</div>
          <div>
            <div className="name">Agamani</div>
            <div className="tag">Staff Manager</div>
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
            </NavLink>
          ))}
        </nav>
        <button className="logout" onClick={() => supabase.auth.signOut()}>
          <LogOut size={15} />
          Log out
        </button>
      </aside>
      <main className="content">
        {/* key remount = entrance animation on every page change */}
        <div className="page" key={location.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
