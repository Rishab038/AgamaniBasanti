// Staff management: list, add worker (creates the login via the
// staff-admin edge function), reset PIN, activate/deactivate,
// re-allow a new phone, and set the fingerprint enrollment number.

import { Fragment, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { intFieldHandler } from "../lib/intField";
import { byName, titleCase } from "../lib/text";

type StaffRow = {
  id: string;
  employee_code: string;
  full_name: string;
  role: string;
  phone: string | null;
  base_salary: number;
  device_id: string | null;
  device_enroll_no: number | null;
  active: boolean;
  approved_at: string | null;
  joined_on: string | null;
  branch_id: string;
  shift_id: string | null;
  employment_type: "NORMAL" | "NO_PAY_NO_WORK" | "CONTRACT" | "PF" | null;
  shift_start: string | null;
  shift_end: string | null;
  lunch_minutes: number;
  salary_basic: number;
  salary_hra: number;
  salary_conveyance: number;
  salary_washing: number;
};

const EMPLOYMENT_LABEL: Record<string, string> = {
  NORMAL: "Normal",
  NO_PAY_NO_WORK: "No pay no work",
  CONTRACT: "Contract",
  PF: "PF",
};

/** "10:30:00" -> "10:30"; null-safe */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

type BulkRow = {
  full_name: string;
  phone: string;
  device_enroll_no: number | null;
  problem: string | null;
};

type BulkResult = {
  full_name: string;
  ok: boolean;
  phone?: string;
  pin?: string;
  employee_code?: string;
  error?: string;
};

async function callStaffAdmin(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("staff-admin", { body });
  if (error) {
    // surface the function's own message when it sent one
    let msg = error.message;
    try {
      const ctx = await (error as { context?: Response }).context?.json();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep original message */ }
    throw new Error(msg);
  }
  return data;
}

const emptyForm = {
  employee_code: "",
  full_name: "",
  phone: "",
  pin: "",
  base_salary: "",
  branch_id: "",
  shift_id: "",
  joined_on: new Date().toISOString().slice(0, 10),
  employment_type: "NORMAL",
  shift_start: "",
  shift_end: "",
  salary_basic: 0,
  salary_hra: 0,
  salary_conveyance: 0,
  salary_washing: 0,
};

export default function Staff() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const { branchId } = useBranch();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!branchId) return;
    const { data } = await supabase
      .from("profiles").select("*")
      .eq("branch_id", branchId);
    // Managers first (there are only one or two, and they are "you"),
    // then every worker in alphabetical order — the owner looks people
    // up by name, never by code.
    const rows = ((data as StaffRow[]) ?? []).slice().sort((a, b) => {
      const aWorker = a.role === "worker" ? 1 : 0;
      const bWorker = b.role === "worker" ? 1 : 0;
      return aWorker - bWorker || byName(a, b);
    });
    setStaff(rows);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  // ---- add a manager (dashboard login by email, not phone+PIN) ----
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminForm, setAdminForm] = useState({
    email: "", full_name: "", password: "", role: "owner",
  });
  const [adminBusy, setAdminBusy] = useState(false);

  const addAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminBusy(true);
    setError(null);
    try {
      await callStaffAdmin({ action: "create_admin", ...adminForm });
      setNotice(
        `${adminForm.full_name} can now sign in at this dashboard with ${adminForm.email}. ` +
        `Share the password with them directly — it is not stored anywhere you can read it back.`,
      );
      setAdminForm({ email: "", full_name: "", password: "", role: "owner" });
      setAdminOpen(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdminBusy(false);
    }
  };

  // ---- bulk add: paste "Name, phone, machineNo, shiftTime" lines ----
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);

  const bulkRows: BulkRow[] = bulkText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      const full_name = parts[0] ?? "";
      const phone = (parts[1] ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
      const enroll = parts[2] ? parseInt(parts[2], 10) : NaN;
      let problem: string | null = null;
      if (!full_name) problem = "name missing";
      else if (!/^[6-9]\d{9}$/.test(phone)) problem = "bad mobile number";
      else if (staff.some((s) => s.phone === phone)) problem = "number already used";
      return {
        full_name,
        phone,
        device_enroll_no: Number.isInteger(enroll) && enroll > 0 ? enroll : null,
        problem,
      };
    });

  const runBulk = async () => {
    setBulkBusy(true);
    setError(null);
    try {
      const data = await callStaffAdmin({
        action: "bulk_create_workers",
        branch_id: branchId,
        workers: bulkRows.map((r) => ({
          full_name: r.full_name,
          phone: r.phone,
          device_enroll_no: r.device_enroll_no,
        })),
      });
      setBulkResults(data.results as BulkResult[]);
      setBulkText("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const downloadCredentials = () => {
    const header = "Name,Mobile (login),PIN,Staff code,Result";
    const lines = bulkResults.map((r) =>
      [`"${r.full_name}"`, r.phone ?? "", r.pin ?? "", r.employee_code ?? "",
        r.ok ? "created" : `failed: ${r.error}`].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "staff-login-details.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const pfTotal =
    form.salary_basic + form.salary_hra + form.salary_conveyance + form.salary_washing;

  const addWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const isPf = form.employment_type === "PF";
      const res = await callStaffAdmin({
        action: "create_worker",
        employee_code: form.employee_code || null,
        full_name: form.full_name,
        pin: form.pin,
        phone: form.phone,
        employment_type: form.employment_type,
        // for PF staff the components are the salary; base_salary is their sum
        base_salary: isPf ? pfTotal : Number(form.base_salary) || 0,
        salary_basic: form.salary_basic,
        salary_hra: form.salary_hra,
        salary_conveyance: form.salary_conveyance,
        salary_washing: form.salary_washing,
        shift_start: form.shift_start || null,
        shift_end: form.shift_end || null,
        branch_id: branchId,
        joined_on: form.joined_on,
      });
      setNotice(
        `${form.full_name} added. They log in with their mobile number ${res.phone} and PIN ${form.pin} — ` +
        `once, on their own phone, then they stay logged in.`,
      );
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // inline confirmations instead of native popups: friendlier for a
  // non-technical owner, and native dialogs freeze embedded browsers
  const [pendingAction, setPendingAction] = useState<{ id: string; kind: string } | null>(null);

  // What a delete would destroy. Fetched the moment Delete is chosen, so
  // the owner is told the cost before the button, not after the mistake.
  type DeleteImpact = {
    attendance: number; punches: number; advances: number;
    payslips: number; notifications: number; confirmed_payslips: number;
  };
  const [deleteImpact, setDeleteImpact] = useState<DeleteImpact | null>(null);

  const askDelete = async (row: StaffRow) => {
    setPendingAction({ id: row.id, kind: "delete" });
    setDeleteImpact(null);
    try {
      const res = await callStaffAdmin({ action: "delete_impact", profile_id: row.id });
      setDeleteImpact(res as DeleteImpact);
    } catch {
      // if the count fails the delete still works; just no preview
    }
  };

  const [newPin, setNewPin] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const runAction = async (row: StaffRow, kind: string) => {
    setPendingAction(null);
    setError(null);
    try {
      if (kind === "set_pin") {
        await callStaffAdmin({ action: "set_password", profile_id: row.id, new_password: newPin });
        setNotice(`PIN for ${row.full_name} is now ${newPin}. Tell them privately.`);
        setNewPin("");
      } else if (kind === "set_password") {
        await callStaffAdmin({
          action: "set_password", profile_id: row.id, new_password: newPassword,
        });
        setNotice(
          `Password changed for ${row.full_name}. Share it with them directly — ` +
          `it cannot be read back later.`,
        );
        setNewPassword("");
      } else if (kind === "change_phone") {
        const res = await callStaffAdmin({
          action: "change_phone", profile_id: row.id, new_phone: newPhone,
        });
        setNotice(`${row.full_name} now logs in with ${res.phone} (same PIN).`);
        setNewPhone("");
      } else if (kind === "toggle_active") {
        await callStaffAdmin({ action: "set_active", profile_id: row.id, active: !row.active });
      } else if (kind === "clear_device") {
        await callStaffAdmin({ action: "clear_device", profile_id: row.id });
        setNotice(`${row.full_name} can now use a new phone.`);
      } else if (kind === "delete" || kind === "delete_force") {
        const res = await callStaffAdmin({
          action: "delete_account",
          profile_id: row.id,
          force: kind === "delete_force",
        });
        const wiped = res?.erased as Record<string, number> | null | undefined;
        const days = wiped?.attendance_days ?? 0;
        setNotice(
          days > 0
            ? `${titleCase(row.full_name)} and ${days} day${days > 1 ? "s" : ""} of their records have been deleted.`
            : `${titleCase(row.full_name)} has been removed.`,
        );
        setDeleteImpact(null);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ---- self-registration approvals ----
  const [pendingSalary, setPendingSalary] = useState<Record<string, string>>({});
  const pendingJoins = staff.filter((s) => !s.active && !s.approved_at);
  const noSalaryCount = staff.filter(
    (s) => s.role === "worker" && s.active && Number(s.base_salary) <= 0,
  ).length;

  const approveJoin = async (row: StaffRow) => {
    setError(null);
    try {
      await callStaffAdmin({
        action: "approve_worker",
        profile_id: row.id,
        base_salary: Number(pendingSalary[row.id]) || 0,
      });
      setNotice(`${row.full_name} is approved — they can start checking in right away.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const rejectJoin = async (row: StaffRow) => {
    setError(null);
    try {
      await callStaffAdmin({ action: "delete_account", profile_id: row.id });
      setNotice(`Request from ${row.full_name} removed.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ---- edit a staff member's details ----
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The menu is position:fixed and anchored from the trigger's screen
  // rect. Absolute positioning got clipped by the table's overflow
  // (needed for its rounded corners) and by the mobile scroll
  // container, so the last row's menu was cut off.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; up: boolean } | null>(null);

  const openMenuAt = (id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (openMenu === id) {
      setOpenMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const up = window.innerHeight - r.bottom < 280; // not enough room below
    // right-aligned to the trigger, but never past the window edge
    const MENU_W = 220;
    const left = Math.min(r.right, window.innerWidth - 8);
    setMenuPos({
      top: up ? r.top - 6 : r.bottom + 6,
      left: Math.max(left, MENU_W + 8),
      up,
    });
    setOpenMenu(id);
  };

  const menuStyle = (): React.CSSProperties => ({
    position: "fixed",
    top: menuPos?.top ?? 0,
    left: menuPos?.left ?? 0,
    transform: `translateX(-100%)${menuPos?.up ? " translateY(-100%)" : ""}`,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: "", base_salary: 0, joined_on: "", employee_code: "",
    employment_type: "", shift_start: "", shift_end: "", lunch_minutes: 60,
    salary_basic: 0, salary_hra: 0, salary_conveyance: 0, salary_washing: 0,
  });
  const [editBusy, setEditBusy] = useState(false);

  const startEdit = (row: StaffRow) => {
    setPendingAction(null);
    setOpenMenu(null);
    setEditingId(row.id);
    setEditForm({
      full_name: row.full_name,
      base_salary: Number(row.base_salary) || 0,
      joined_on: row.joined_on ?? "",
      employee_code: row.employee_code,
      employment_type: row.employment_type ?? "",
      shift_start: hhmm(row.shift_start),
      shift_end: hhmm(row.shift_end),
      lunch_minutes: row.lunch_minutes ?? 60,
      salary_basic: Number(row.salary_basic) || 0,
      salary_hra: Number(row.salary_hra) || 0,
      salary_conveyance: Number(row.salary_conveyance) || 0,
      salary_washing: Number(row.salary_washing) || 0,
    });
  };

  const saveEdit = async (row: StaffRow) => {
    if (!editForm.full_name.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setEditBusy(true);
    setError(null);
    // owner-only by RLS; the audit trigger records every salary change
    // for PF staff the components are the source of truth and
    // base_salary is kept equal to their sum, so summaries and the
    // other pay bases still have one number to read
    const isPf = editForm.employment_type === "PF";
    const componentSum =
      editForm.salary_basic + editForm.salary_hra +
      editForm.salary_conveyance + editForm.salary_washing;

    const { error: err } = await supabase.from("profiles").update({
      full_name: editForm.full_name.trim(),
      base_salary: isPf ? componentSum : editForm.base_salary,
      joined_on: editForm.joined_on || null,
      employee_code: editForm.employee_code.trim().toUpperCase(),
      employment_type: editForm.employment_type || null,
      shift_start: editForm.shift_start || null,
      shift_end: editForm.shift_end || null,
      lunch_minutes: editForm.lunch_minutes,
      salary_basic: isPf ? editForm.salary_basic : 0,
      salary_hra: isPf ? editForm.salary_hra : 0,
      salary_conveyance: isPf ? editForm.salary_conveyance : 0,
      salary_washing: isPf ? editForm.salary_washing : 0,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    setEditBusy(false);
    if (err) {
      setError(
        err.message.includes("duplicate") || err.message.includes("unique")
          ? `Staff code ${editForm.employee_code.toUpperCase()} is already used by someone else.`
          : err.message,
      );
      return;
    }
    setEditingId(null);
    setNotice(`${editForm.full_name} updated.`);
    await load();
  };

  const saveEnrollNo = async (row: StaffRow, value: string) => {
    const n = value === "" ? null : Number(value);
    const { error: err } = await supabase
      .from("profiles").update({ device_enroll_no: n }).eq("id", row.id);
    if (err) setError(err.message);
    else setNotice(`Fingerprint machine number for ${row.full_name} saved.`);
  };

  return (
    <div>
      <div className="page-head">
        <h1>Staff</h1>
        <p>Add staff, hand out login codes, and manage PINs, phones and fingerprint numbers.</p>
      </div>

      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {/* one actionable line instead of "₹0" repeated down the table */}
      {noSalaryCount > 0 && (
        <div className="banner warn" style={{ cursor: "default" }}>
          {noSalaryCount} staff {noSalaryCount === 1 ? "member has" : "members have"} no salary
          set yet — payroll will calculate ₹0 for {noSalaryCount === 1 ? "them" : "them"} until
          you add it.
        </div>
      )}

      {pendingJoins.map((p) => (
        <div className="approval-card" key={p.id}>
          <div>
            <div className="who">{p.full_name} wants to join</div>
            <div className="why">
              Mobile {p.phone}
              {p.device_enroll_no != null && <> · machine no. {p.device_enroll_no}</>}
              {" · asked "}
              {p.joined_on
                ? new Date(p.joined_on).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                : "recently"}
            </div>
          </div>
          <div className="acts">
            <input
              className="enroll-input"
              type="number"
              placeholder="salary ₹"
              value={pendingSalary[p.id] ?? ""}
              onChange={(e) => setPendingSalary({ ...pendingSalary, [p.id]: e.target.value })}
            />
            <button className="btn good" onClick={() => approveJoin(p)}>Approve</button>
            <button className="btn soft" onClick={() => rejectJoin(p)}>Reject</button>
          </div>
        </div>
      ))}

      <div className="actions toolbar">
        <button
          className="btn primary"
          onClick={() => { setShowForm(!showForm); setBulkOpen(false); setAdminOpen(false); }}
        >
          {showForm ? "Close" : "+ Add staff member"}
        </button>
        <div className="menu-wrap">
          <button className="btn" onClick={(e) => openMenuAt("toolbar", e)}>
            More <span className="caret">▾</span>
          </button>
          {openMenu === "toolbar" && (
            <>
              <div className="menu-backdrop" onClick={() => setOpenMenu(null)} />
              <div className="menu" style={menuStyle()}>
                <button onClick={() => { setOpenMenu(null); setBulkOpen(true); setShowForm(false); setAdminOpen(false); }}>
                  Add many at once (paste a list)
                </button>
                <button onClick={() => { setOpenMenu(null); setAdminOpen(true); setShowForm(false); setBulkOpen(false); }}>
                  Add a manager login
                </button>
              </div>
            </>
          )}
        </div>
        <span className="toolbar-count">
          {staff.filter((s) => s.role === "worker" && s.active).length} active staff
        </span>
      </div>

      {adminOpen && (
        <form className="card form-grid" onSubmit={addAdmin}>
          <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
            Managers sign in to <strong>this dashboard</strong> with an email address
            (workers use their mobile number in the app instead). Choose a password here
            and pass it to them yourself — set it once, they keep using it.
          </p>
          <label>
            Email address
            <input
              type="email" required placeholder="name@example.com"
              value={adminForm.email}
              onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
            />
          </label>
          <label>
            Full name
            <input
              required placeholder="Full name"
              value={adminForm.full_name}
              onChange={(e) => setAdminForm({ ...adminForm, full_name: e.target.value })}
            />
          </label>
          <label>
            Password (min 8 characters)
            <input
              type="text" required minLength={8} placeholder="choose a password"
              value={adminForm.password}
              onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
            />
          </label>
          <label>
            Access level
            <select
              value={adminForm.role}
              onChange={(e) => setAdminForm({ ...adminForm, role: e.target.value })}
            >
              <option value="owner">Owner — full access including salary</option>
              <option value="supervisor">Supervisor — attendance only, no salary</option>
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={adminBusy}>
            {adminBusy ? "Creating…" : "Create manager login"}
          </button>
        </form>
      )}

      {bulkOpen && (
        <div className="card">
          <p className="muted" style={{ marginBottom: 10 }}>
            One person per line: <strong>Name, mobile number, machine no.</strong> —
            e.g. <code>Surojit Majumder, 9830012345, 70</code>. Machine no. is optional.
            PINs are generated automatically and shown once after creating.
          </p>
          <textarea
            className="bulk-input"
            rows={8}
            placeholder={"Surojit Majumder, 9830012345, 70\nDeep Sarkar, 9830054321, 71"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          {bulkRows.length > 0 && (
            <>
              <table>
                <thead>
                  <tr><th>Name</th><th>Mobile</th><th>Machine no.</th><th>Check</th></tr>
                </thead>
                <tbody>
                  {bulkRows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.full_name}</td>
                      <td>{r.phone || "—"}</td>
                      <td>{r.device_enroll_no ?? "—"}</td>
                      <td>
                        {r.problem
                          ? <span className="pill serious">{r.problem}</span>
                          : <span className="pill good">Ready</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="btn primary"
                  disabled={bulkBusy || bulkRows.some((r) => r.problem !== null)}
                  onClick={runBulk}
                >
                  {bulkBusy
                    ? "Creating…"
                    : `Create ${bulkRows.length} worker${bulkRows.length > 1 ? "s" : ""}`}
                </button>
                {bulkRows.some((r) => r.problem !== null) && (
                  <span className="muted">Fix the rows marked red first.</span>
                )}
              </div>
            </>
          )}
          {bulkResults.length > 0 && (
            <>
              <h2>Login details — save this list now (PINs are shown only once)</h2>
              <table>
                <thead>
                  <tr><th>Name</th><th>Mobile (login)</th><th>PIN</th><th>Code</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {bulkResults.map((r, i) => (
                    <tr key={i}>
                      <td>{r.full_name}</td>
                      <td>{r.phone ?? "—"}</td>
                      <td><strong>{r.pin ?? "—"}</strong></td>
                      <td>{r.employee_code ?? "—"}</td>
                      <td>
                        {r.ok
                          ? <span className="pill good">Created ✓</span>
                          : <span className="pill serious">{r.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn" style={{ marginTop: 10 }} onClick={downloadCredentials}>
                ⬇ Download this list (CSV)
              </button>
            </>
          )}
        </div>
      )}

      {showForm && (
        <form className="card form-grid" onSubmit={addWorker}>
          <label>
            Full name
            <input value={form.full_name} onChange={set("full_name")} placeholder="Full name" required />
          </label>
          <label>
            Mobile number (their app login)
            <input
              value={form.phone}
              onChange={set("phone")}
              placeholder="10-digit number"
              maxLength={10}
              required
            />
          </label>
          <label>
            6-digit PIN
            <input value={form.pin} onChange={set("pin")} placeholder="e.g. 428913" maxLength={6} required />
          </label>
          <label>
            Staff type
            <select value={form.employment_type} onChange={set("employment_type")}>
              <option value="NORMAL">Normal (monthly salary)</option>
              <option value="PF">PF (statutory — with salary break-up)</option>
              <option value="CONTRACT">Contract</option>
              <option value="NO_PAY_NO_WORK">No pay no work (daily wage)</option>
            </select>
          </label>

          {/* PF staff are paid off the components, so the single "monthly
              salary" box would be the wrong question to ask. Swap it for
              the break-up and total the parts up for them. */}
          {form.employment_type === "PF" ? (
            <>
              <label>
                Basic (₹)
                <input type="text" inputMode="numeric" value={form.salary_basic}
                  onChange={intFieldHandler((n) => setForm((f) => ({ ...f, salary_basic: n })), 7)} />
              </label>
              <label>
                H.R.A. (₹)
                <input type="text" inputMode="numeric" value={form.salary_hra}
                  onChange={intFieldHandler((n) => setForm((f) => ({ ...f, salary_hra: n })), 7)} />
              </label>
              <label>
                Conveyance (₹)
                <input type="text" inputMode="numeric" value={form.salary_conveyance}
                  onChange={intFieldHandler((n) => setForm((f) => ({ ...f, salary_conveyance: n })), 7)} />
              </label>
              <label>
                Washing (₹)
                <input type="text" inputMode="numeric" value={form.salary_washing}
                  onChange={intFieldHandler((n) => setForm((f) => ({ ...f, salary_washing: n })), 7)} />
              </label>
              <div className="pf-total" style={{ gridColumn: "1 / -1" }}>
                Total salary: ₹{pfTotal.toLocaleString("en-IN")}
                {" · "}PF is 12% of Basic, ESI 0.75% of gross, plus professional tax.
              </div>
            </>
          ) : (
            <label>
              {form.employment_type === "NO_PAY_NO_WORK" ? "Daily wage (₹)" : "Monthly salary (₹)"}
              <input type="number" value={form.base_salary} onChange={set("base_salary")} placeholder="12000" />
            </label>
          )}

          <label>
            Shift starts (optional)
            <input type="time" value={form.shift_start} onChange={set("shift_start")} />
          </label>
          <label>
            Shift ends (optional)
            <input type="time" value={form.shift_end} onChange={set("shift_end")} />
          </label>
          <label>
            Joining date
            <input type="date" value={form.joined_on} onChange={set("joined_on")} />
          </label>
          {/* no branch picker: staff are added to the shop currently
              selected in the sidebar, which is what the owner is
              already looking at */}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create worker"}
          </button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Salary</th>
            <th>Machine no.</th>
            <th>Phone app</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {staff.filter((s) => s.active || s.approved_at).map((row) => (
            <Fragment key={row.id}>
            <tr className={row.active ? "" : "inactive"}>
              <td>
                {titleCase(row.full_name)}{!row.active && " (inactive)"}
                {(row.phone || row.shift_start) && (
                  <div className="note muted">
                    {row.phone}
                    {row.phone && row.shift_start && " · "}
                    {row.shift_start && `${hhmm(row.shift_start)}–${hhmm(row.shift_end)}`}
                  </div>
                )}
              </td>
              <td>
                {row.role !== "worker" ? (
                  <span className="pill neutral">{row.role}</span>
                ) : row.employment_type ? (
                  EMPLOYMENT_LABEL[row.employment_type]
                ) : (
                  <button className="link-btn" onClick={() => startEdit(row)}>Set type</button>
                )}
              </td>
              <td>
                {row.role !== "worker" ? (
                  <span className="dash">—</span>
                ) : Number(row.base_salary) > 0 ? (
                  `₹${Number(row.base_salary).toLocaleString("en-IN")}`
                ) : (
                  <button className="link-btn" onClick={() => startEdit(row)}>Set salary</button>
                )}
              </td>
              <td>
                {row.role === "worker" ? (
                  <input
                    className="enroll-input"
                    type="number"
                    defaultValue={row.device_enroll_no ?? ""}
                    placeholder="not set"
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v !== String(row.device_enroll_no ?? "")) saveEnrollNo(row, v);
                    }}
                  />
                ) : "—"}
              </td>
              <td>
                {row.device_id
                  ? <span className="pill good">Linked</span>
                  : <span className="dash">—</span>}
              </td>
              <td className="actions">
                {pendingAction?.id !== row.id && (
                  <div className="menu-wrap">
                    <button
                      className="btn small menu-trigger"
                      aria-label={`Actions for ${row.full_name}`}
                      onClick={(e) => openMenuAt(row.id, e)}
                    >
                      Manage <span className="caret">▾</span>
                    </button>
                    {openMenu === row.id && (
                      <>
                        <div className="menu-backdrop" onClick={() => setOpenMenu(null)} />
                        <div className="menu" style={menuStyle()}>
                          <button onClick={() => { setOpenMenu(null); startEdit(row); }}>
                            Edit details
                          </button>
                          {row.role === "worker" ? (
                            <>
                              <button onClick={() => { setOpenMenu(null); setPendingAction({ id: row.id, kind: "set_pin" }); }}>
                                Reset PIN
                              </button>
                              <button onClick={() => { setOpenMenu(null); setPendingAction({ id: row.id, kind: "change_phone" }); }}>
                                Change mobile number
                              </button>
                              {row.device_id && (
                                <button onClick={() => { setOpenMenu(null); setPendingAction({ id: row.id, kind: "clear_device" }); }}>
                                  Allow a new phone
                                </button>
                              )}
                              <button onClick={() => { setOpenMenu(null); setPendingAction({ id: row.id, kind: "toggle_active" }); }}>
                                {row.active ? "Deactivate" : "Activate"}
                              </button>
                            </>
                          ) : (
                            <button onClick={() => { setOpenMenu(null); setPendingAction({ id: row.id, kind: "set_password" }); }}>
                              Change password
                            </button>
                          )}
                          <div className="menu-sep" />
                          <button
                            className="danger"
                            onClick={() => { setOpenMenu(null); askDelete(row); }}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {pendingAction?.id === row.id && (
                  <>
                    {pendingAction.kind === "set_pin" ? (
                      <>
                        <input
                          className="enroll-input"
                          placeholder="new PIN"
                          maxLength={6}
                          value={newPin}
                          onChange={(e) => setNewPin(e.target.value)}
                        />
                        <button
                          className="btn small primary"
                          disabled={!/^\d{6}$/.test(newPin)}
                          onClick={() => runAction(row, "set_pin")}
                        >
                          Set PIN
                        </button>
                      </>
                    ) : pendingAction.kind === "set_password" ? (
                      <>
                        <input
                          className="note-input"
                          placeholder="new password (8+)"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <button
                          className="btn small primary"
                          disabled={newPassword.length < 8}
                          onClick={() => runAction(row, "set_password")}
                        >
                          Set password
                        </button>
                      </>
                    ) : pendingAction.kind === "change_phone" ? (
                      <>
                        <input
                          className="note-input"
                          placeholder="new mobile number"
                          maxLength={10}
                          value={newPhone}
                          onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ""))}
                        />
                        <button
                          className="btn small primary"
                          disabled={!/^[6-9]\d{9}$/.test(newPhone)}
                          onClick={() => runAction(row, "change_phone")}
                        >
                          Save
                        </button>
                      </>
                    ) : pendingAction.kind === "delete" ? (
                      (() => {
                        const i = deleteImpact;
                        const history = i
                          ? i.attendance + i.punches + i.advances + i.payslips
                          : 0;
                        const bits = i
                          ? [
                              i.attendance && `${i.attendance} attendance day${i.attendance > 1 ? "s" : ""}`,
                              i.advances && `${i.advances} advance${i.advances > 1 ? "s" : ""}`,
                              i.payslips && `${i.payslips} payslip${i.payslips > 1 ? "s" : ""}`,
                            ].filter(Boolean).join(", ")
                          : "";
                        return (
                          <>
                            <span className="delete-warn">
                              {!i
                                ? "Checking their records…"
                                : history === 0
                                ? "Nothing recorded for them yet — safe to delete."
                                : `Also deletes ${bits}.` +
                                  (i.confirmed_payslips > 0
                                    ? ` ${i.confirmed_payslips} of those payslip(s) are from a confirmed salary month.`
                                    : "")}
                            </span>
                            <button
                              className="btn small danger"
                              disabled={!i}
                              onClick={() => runAction(row, history > 0 ? "delete_force" : "delete")}
                            >
                              {history > 0 ? "Delete permanently" : "Confirm delete"}
                            </button>
                            {history > 0 && row.active && (
                              <button
                                className="btn small"
                                onClick={() => runAction(row, "toggle_active")}
                              >
                                Deactivate instead
                              </button>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      <button className="btn small danger" onClick={() => runAction(row, pendingAction.kind)}>
                        Confirm?
                      </button>
                    )}
                    <button
                      className="btn small"
                      onClick={() => {
                        setPendingAction(null);
                        setDeleteImpact(null);
                        setNewPin(""); setNewPassword(""); setNewPhone("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </td>
            </tr>

            {editingId === row.id && (
              <tr>
                <td colSpan={6} className="edit-cell">
                  <div className="edit-panel">
                    <label>
                      Full name
                      <input
                        value={editForm.full_name}
                        onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                      />
                    </label>
                    {row.role === "worker" && editForm.employment_type !== "PF" && (
                      <label>
                        {editForm.employment_type === "NO_PAY_NO_WORK"
                          ? "Daily wage (₹)"
                          : "Monthly salary (₹)"}
                        <input
                          type="text"
                          inputMode="numeric"
                          value={editForm.base_salary}
                          onChange={intFieldHandler(
                            (n) => setEditForm((f) => ({ ...f, base_salary: n })), 7,
                          )}
                        />
                      </label>
                    )}
                    {row.role === "worker" && editForm.employment_type === "PF" && (
                      <>
                        <label>
                          Basic (₹)
                          <input type="text" inputMode="numeric" value={editForm.salary_basic}
                            onChange={intFieldHandler((n) => setEditForm((f) => ({ ...f, salary_basic: n })), 7)} />
                        </label>
                        <label>
                          HRA (₹)
                          <input type="text" inputMode="numeric" value={editForm.salary_hra}
                            onChange={intFieldHandler((n) => setEditForm((f) => ({ ...f, salary_hra: n })), 7)} />
                        </label>
                        <label>
                          Conveyance (₹)
                          <input type="text" inputMode="numeric" value={editForm.salary_conveyance}
                            onChange={intFieldHandler((n) => setEditForm((f) => ({ ...f, salary_conveyance: n })), 7)} />
                        </label>
                        <label>
                          Washing (₹)
                          <input type="text" inputMode="numeric" value={editForm.salary_washing}
                            onChange={intFieldHandler((n) => setEditForm((f) => ({ ...f, salary_washing: n })), 7)} />
                        </label>
                        <div className="pf-total" style={{ gridColumn: "1 / -1" }}>
                          Total salary: ₹{(editForm.salary_basic + editForm.salary_hra +
                            editForm.salary_conveyance + editForm.salary_washing).toLocaleString("en-IN")}
                          {" · "}PF is 12% of Basic, ESI 0.75% of gross, plus professional tax.
                        </div>
                      </>
                    )}
                    <label>
                      Joining date
                      <input
                        type="date"
                        value={editForm.joined_on}
                        onChange={(e) => setEditForm({ ...editForm, joined_on: e.target.value })}
                      />
                    </label>
                    {row.role === "worker" && (
                      <>
                        <label>
                          Staff type
                          <select
                            value={editForm.employment_type}
                            onChange={(e) =>
                              setEditForm({ ...editForm, employment_type: e.target.value })}
                          >
                            <option value="">— not set —</option>
                            <option value="NORMAL">Normal — salary ÷ 30, 4 leave days</option>
                            <option value="NO_PAY_NO_WORK">No pay no work — daily wage</option>
                            <option value="CONTRACT">Contract — salary ÷ 30, 4 leave days</option>
                            <option value="PF">PF — Basic&HRA components, statutory deductions</option>
                          </select>
                        </label>
                        <label>
                          Shift starts
                          <input
                            type="time"
                            value={editForm.shift_start}
                            onChange={(e) =>
                              setEditForm({ ...editForm, shift_start: e.target.value })}
                          />
                        </label>
                        <label>
                          Shift ends
                          <input
                            type="time"
                            value={editForm.shift_end}
                            onChange={(e) =>
                              setEditForm({ ...editForm, shift_end: e.target.value })}
                          />
                        </label>
                        <label>
                          Lunch break (minutes)
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editForm.lunch_minutes}
                            onChange={intFieldHandler(
                              (n) => setEditForm((f) => ({ ...f, lunch_minutes: n })), 3,
                            )}
                          />
                        </label>
                      </>
                    )}
                    <div className="actions">
                      <button
                        className="btn primary"
                        disabled={editBusy}
                        onClick={() => saveEdit(row)}
                      >
                        {editBusy ? "Saving…" : "Save changes"}
                      </button>
                      <button className="btn" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                    {row.role === "worker" && (
                      <p className="muted" style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13 }}>
                        Salary changes apply to payroll from now on — payslips already
                        confirmed keep the figure they were calculated with. To change their
                        mobile number use Manage → Change mobile number (it is also their
                        app login). Setting a shift start makes late arrivals show on the
                        Today page; leave it empty and lateness is never flagged.
                      </p>
                    )}
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>

      <p className="muted hint-line">
        "Machine no." is the ID the fingerprint machine assigns when you enroll the
        worker's finger — fill it in on the day the machine is set up so attendance
        cross-verification can match them.
      </p>
    </div>
  );
}
