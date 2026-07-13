import { NavLink, Outlet } from "react-router-dom";
import { supabase } from "../lib/supabase";

const links = [
  { to: "/", label: "Today" },
  { to: "/staff", label: "Staff" },
  { to: "/attendance", label: "Attendance" },
  { to: "/advances", label: "Advances" },
  { to: "/payroll", label: "Payroll" },
  { to: "/settings", label: "Settings" },
];

export default function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <h2 className="brand">Agamani</h2>
        <nav>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) => (isActive ? "nav active" : "nav")}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <button className="logout" onClick={() => supabase.auth.signOut()}>
          Log out
        </button>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
