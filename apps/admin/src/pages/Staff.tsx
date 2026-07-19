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

  const runAction = async (row: StaffRow, kind: string) => {
    setPendingAction(null);
    setError(null);
    try {
      if (kind === "reset_pin") {
        await callStaffAdmin({ action: "reset_pin", profile_id: row.id, new_pin: newPin });
        setNotice(`PIN for ${row.full_name} is now ${newPin}. Tell them privately.`);
        setNewPin("");
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
        await callStaffAdmin({ action: "delete_worker", profile_id: row.id });
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
      await callStaffAdmin({ action: "delete_worker", profile_id: row.id });
      setNotice(`Request from ${row.full_name} removed.`);
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
        <button className="btn" onClick={() => { setBulkOpen(!bulkOpen); setShowForm(false); }}>
          {bulkOpen ? "Close bulk add" : "⇪ Bulk add (paste list)"}
        </button>
      </div>

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
            <tr key={row.id} className={row.active ? "" : "inactive"}>
              <td>{row.employee_code}</td>
              <td>
                {row.full_name}{!row.active && " (inactive)"}
                {row.phone && <div className="note muted">{row.phone}</div>}
              </td>
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
                    <button className="btn small" onClick={() => setPendingAction({ id: row.id, kind: "change_phone" })}>Change no.</button>
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
