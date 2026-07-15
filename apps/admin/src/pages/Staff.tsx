// Staff management: list, add worker (creates the login via the
// staff-admin edge function), reset PIN, activate/deactivate,
// re-allow a new phone, and set the fingerprint enrollment number.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

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
  branch_id: string;
  shift_id: string | null;
};

type Option = { id: string; name: string };

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
  const [shifts, setShifts] = useState<Option[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [p, b, s] = await Promise.all([
      supabase.from("profiles").select("*").order("employee_code"),
      supabase.from("branches").select("id, name"),
      supabase.from("shifts").select("id, name"),
    ]);
    setStaff((p.data as StaffRow[]) ?? []);
    setBranches(b.data ?? []);
    setShifts(s.data ?? []);
  };

  useEffect(() => {
    load();
  }, []);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const addWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callStaffAdmin({
        action: "create_worker",
        employee_code: form.employee_code,
        full_name: form.full_name,
        pin: form.pin,
        phone: form.phone || null,
        base_salary: Number(form.base_salary) || 0,
        branch_id: form.branch_id || branches[0]?.id,
        shift_id: form.shift_id || null,
        joined_on: form.joined_on,
      });
      setNotice(
        `${form.full_name} added. Give them: code ${form.employee_code.toUpperCase()}, PIN ${form.pin}. ` +
        `They log in once on their own phone and stay logged in.`,
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

  const runAction = async (row: StaffRow, kind: string) => {
    setPendingAction(null);
    setError(null);
    try {
      if (kind === "reset_pin") {
        await callStaffAdmin({ action: "reset_pin", profile_id: row.id, new_pin: newPin });
        setNotice(`PIN for ${row.full_name} is now ${newPin}. Tell them privately.`);
        setNewPin("");
      } else if (kind === "toggle_active") {
        await callStaffAdmin({ action: "set_active", profile_id: row.id, active: !row.active });
      } else if (kind === "clear_device") {
        await callStaffAdmin({ action: "clear_device", profile_id: row.id });
        setNotice(`${row.full_name} can now use a new phone.`);
      } else if (kind === "delete") {
        await callStaffAdmin({ action: "delete_worker", profile_id: row.id });
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
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

      <button className="btn primary" onClick={() => setShowForm(!showForm)}>
        {showForm ? "Close" : "+ Add staff member"}
      </button>

      {showForm && (
        <form className="card form-grid" onSubmit={addWorker}>
          <label>
            Employee code
            <input value={form.employee_code} onChange={set("employee_code")} placeholder="W02" required />
          </label>
          <label>
            Full name
            <input value={form.full_name} onChange={set("full_name")} placeholder="Full name" required />
          </label>
          <label>
            6-digit PIN
            <input value={form.pin} onChange={set("pin")} placeholder="e.g. 428913" maxLength={6} required />
          </label>
          <label>
            Phone (optional)
            <input value={form.phone} onChange={set("phone")} placeholder="98300xxxxx" />
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
          <label>
            Shift
            <select value={form.shift_id} onChange={set("shift_id")}>
              <option value="">— none yet —</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
          {staff.map((row) => (
            <tr key={row.id} className={row.active ? "" : "inactive"}>
              <td>{row.employee_code}</td>
              <td>{row.full_name}{!row.active && " (inactive)"}</td>
              <td>{row.role}</td>
              <td>{row.role === "worker" ? `₹${row.base_salary}` : "—"}</td>
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
                {row.role !== "owner" && pendingAction?.id !== row.id && (
                  <>
                    <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "reset_pin" })}>Reset PIN</button>
                    {row.device_id && (
                      <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "clear_device" })}>New phone</button>
                    )}
                    <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "toggle_active" })}>
                      {row.active ? "Deactivate" : "Activate"}
                    </button>
                    <button className="btn small danger" onClick={() => setPendingAction({ id: row.id, kind: "delete" })}>Delete</button>
                  </>
                )}
                {pendingAction?.id === row.id && (
                  <>
                    {pendingAction.kind === "reset_pin" ? (
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
                          onClick={() => runAction(row, "reset_pin")}
                        >
                          Set PIN
                        </button>
                      </>
                    ) : (
                      <button className="btn small danger" onClick={() => runAction(row, pendingAction.kind)}>
                        Confirm{pendingAction.kind === "delete" ? " delete" : ""}?
                      </button>
                    )}
                    <button className="btn small" onClick={() => setPendingAction(null)}>Cancel</button>
                  </>
                )}
              </td>
            </tr>
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
