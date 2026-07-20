// Staff management: list, add worker (creates the login via the
// staff-admin edge function), reset PIN, activate/deactivate,
// re-allow a new phone, and set the fingerprint enrollment number.

import { Fragment, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { intFieldHandler } from "../lib/intField";

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
};

type Option = { id: string; name: string };

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
};

export default function Staff() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [branches, setBranches] = useState<Option[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [p, b] = await Promise.all([
      supabase.from("profiles").select("*").order("employee_code"),
      supabase.from("branches").select("id, name"),
    ]);
    setStaff((p.data as StaffRow[]) ?? []);
    setBranches(b.data ?? []);
  };

  useEffect(() => {
    load();
  }, []);

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
        branch_id: branches[0]?.id,
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

  const addWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await callStaffAdmin({
        action: "create_worker",
        employee_code: form.employee_code || null,
        full_name: form.full_name,
        pin: form.pin,
        phone: form.phone,
        base_salary: Number(form.base_salary) || 0,
        branch_id: form.branch_id || branches[0]?.id,
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
      } else if (kind === "delete") {
        await callStaffAdmin({ action: "delete_account", profile_id: row.id });
        setNotice(`${row.full_name} has been removed.`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ---- self-registration approvals ----
  const [pendingSalary, setPendingSalary] = useState<Record<string, string>>({});
  const pendingJoins = staff.filter((s) => !s.active && !s.approved_at);

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: "", base_salary: 0, joined_on: "", employee_code: "",
  });
  const [editBusy, setEditBusy] = useState(false);

  const startEdit = (row: StaffRow) => {
    setPendingAction(null);
    setEditingId(row.id);
    setEditForm({
      full_name: row.full_name,
      base_salary: Number(row.base_salary) || 0,
      joined_on: row.joined_on ?? "",
      employee_code: row.employee_code,
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
    const { error: err } = await supabase.from("profiles").update({
      full_name: editForm.full_name.trim(),
      base_salary: editForm.base_salary,
      joined_on: editForm.joined_on || null,
      employee_code: editForm.employee_code.trim().toUpperCase(),
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

      <div className="actions">
        <button className="btn primary" onClick={() => { setShowForm(!showForm); setBulkOpen(false); }}>
          {showForm ? "Close" : "+ Add staff member"}
        </button>
        <button className="btn" onClick={() => { setBulkOpen(!bulkOpen); setShowForm(false); setAdminOpen(false); }}>
          {bulkOpen ? "Close bulk add" : "⇪ Bulk add (paste list)"}
        </button>
        <button className="btn" onClick={() => { setAdminOpen(!adminOpen); setShowForm(false); setBulkOpen(false); }}>
          {adminOpen ? "Close" : "🔑 Add manager"}
        </button>
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
            Staff code (optional — auto if empty)
            <input value={form.employee_code} onChange={set("employee_code")} placeholder="W02" />
          </label>
          <label>
            Monthly salary (₹)
            <input type="number" value={form.base_salary} onChange={set("base_salary")} placeholder="12000" />
          </label>
          <label>
            Joining date
            <input type="date" value={form.joined_on} onChange={set("joined_on")} />
          </label>
          <label>
            Branch
            <select value={form.branch_id} onChange={set("branch_id")}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create worker"}
          </button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Role</th>
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
              <td>{row.employee_code}</td>
              <td>
                {row.full_name}{!row.active && " (inactive)"}
                {row.phone && <div className="note muted">{row.phone}</div>}
              </td>
              <td>{row.role}</td>
              <td>
                {row.role === "worker"
                  ? `₹${Number(row.base_salary).toLocaleString("en-IN")}`
                  : "—"}
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
              <td>{row.device_id ? "✅ linked" : "—"}</td>
              <td className="actions">
                {pendingAction?.id !== row.id && (
                  row.role === "worker" ? (
                    <>
                      <button className="btn small" onClick={() => startEdit(row)}>Edit</button>
                      <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "set_pin" })}>Reset PIN</button>
                      <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "change_phone" })}>Change no.</button>
                      {row.device_id && (
                        <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "clear_device" })}>New phone</button>
                      )}
                      <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "toggle_active" })}>
                        {row.active ? "Deactivate" : "Activate"}
                      </button>
                      <button className="btn small danger" onClick={() => setPendingAction({ id: row.id, kind: "delete" })}>Delete</button>
                    </>
                  ) : (
                    <>
                      <button className="btn small" onClick={() => startEdit(row)}>Edit</button>
                      <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "set_password" })}>
                        Change password
                      </button>
                      <button className="btn small danger" onClick={() => setPendingAction({ id: row.id, kind: "delete" })}>
                        Delete
                      </button>
                    </>
                  )
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
                    ) : (
                      <button className="btn small danger" onClick={() => runAction(row, pendingAction.kind)}>
                        Confirm{pendingAction.kind === "delete" ? " delete" : ""}?
                      </button>
                    )}
                    <button
                      className="btn small"
                      onClick={() => {
                        setPendingAction(null);
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
                <td colSpan={7} className="edit-cell">
                  <div className="edit-panel">
                    <label>
                      Full name
                      <input
                        value={editForm.full_name}
                        onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                      />
                    </label>
                    {row.role === "worker" && (
                      <label>
                        Monthly salary (₹)
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
                    <label>
                      Staff code
                      <input
                        value={editForm.employee_code}
                        onChange={(e) =>
                          setEditForm({ ...editForm, employee_code: e.target.value.toUpperCase() })}
                      />
                    </label>
                    <label>
                      Joining date
                      <input
                        type="date"
                        value={editForm.joined_on}
                        onChange={(e) => setEditForm({ ...editForm, joined_on: e.target.value })}
                      />
                    </label>
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
                        mobile number use "Change no." (it is also their app login).
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
