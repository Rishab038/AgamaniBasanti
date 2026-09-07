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
  ScanBarcode,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { useTheme, type Theme } from "../lib/theme";

/* The shell is two rows above the content.
   Row one is CONTEXT — which shop, what time, how it looks. Row two is
   DESTINATION. Keeping the shop switcher out of the nav matters: it
   changes what every figure on every page below it means, so it must
   not read as just another link.

   The nav itself splits in two. Today, Staff and Approvals are where an
   owner goes several times a day and carry a fill even when inactive;
   the rest are quieter until chosen. Without that split, eight equal
   pills give no hint about which ones are worth a glance this morning. */
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

  const primary = [
    { to: "/", label: "Today", icon: LayoutDashboard },
    { to: "/staff", label: "Staff", icon: Users },
    // Amber, not accent: the accent means "you are here", and a count
    // that is waiting on a decision must not look like the active tab.
    { to: "/approvals", label: "Approvals", icon: BadgeCheck, count: pendingCount, warn: true },
  ];
  const more = [
    { to: "/attendance", label: "Attendance", icon: CalendarCheck2 },
    { to: "/credit", label: "Credit", icon: NotebookPen, count: creditCount },
    { to: "/sales", label: "Sales", icon: ScanBarcode },
    { to: "/salary", label: "Salary", icon: ReceiptIndianRupee },
    { to: "/settings", label: "Settings", icon: Settings2 },
  ];

  const link = (
    l: { to: string; label: string; icon: typeof Users; count?: number; warn?: boolean },
    ghost: boolean,
  ) => (
    <NavLink
      key={l.to}
      to={l.to}
      end={l.to === "/"}
      className={({ isActive }) =>
        `nav${ghost ? " ghost" : ""}${isActive ? " active" : ""}`
      }
    >
      <l.icon />
      {l.label}
      {l.count ? <span className={l.warn ? "count warn" : "count"}>{l.count}</span> : null}
    </NavLink>
  );

  return (
    <div className="shell">
      <header className="topbar">
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

        <div style={{ flex: 1 }} />
        <Clock />
        <ThemePicker />
        <button className="logout" onClick={() => supabase.auth.signOut()}>
          <LogOut size={15} />
          Log out
        </button>
      </header>

      <nav className="navbar">
        <div className="nav-group">{primary.map((l) => link(l, false))}</div>
        <div className="divider" />
        <div className="nav-group">{more.map((l) => link(l, true))}</div>
      </nav>

      <main className="content">
        <div className="page" key={location.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/* The time, and a dot that says the page is live.
   Half a minute is the right tick: the clock is here so the owner can
   read a punch time against "now" without looking away, and a seconds
   hand would be a re-render every second for nobody's benefit. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="topclock">
      <span className="dot" />
      {now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}
    </div>
  );
}

/* Three buttons rather than one that cycles: a cycling control makes the
   owner click and watch to find out what it does, and there is no room
   for a legend explaining the order. */
function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const options: { key: Theme; label: string; Icon: typeof Sun }[] = [
    { key: "light", label: "Light", Icon: Sun },
    { key: "dark", label: "Dark", Icon: Moon },
    { key: "system", label: "Match this computer", Icon: Monitor },
  ];
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {options.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`theme-btn${theme === key ? " active" : ""}`}
          onClick={() => setTheme(key)}
          title={label}
          aria-label={label}
          aria-pressed={theme === key}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}
