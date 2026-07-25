// Shop settings: geofence per branch, shifts, and holidays.
// Everything here is owner-only (enforced by RLS, not just UI).

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { intFieldHandler } from "../lib/intField";

type Branch = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  wifi_ssid: string | null;
  join_code: string | null;
};

type Holiday = { id: string; branch_id: string; on_date: string; name: string };

type Device = {
  id: string;
  serial: string;
  model: string | null;
  last_seen_at: string | null;
  branch_id: string;
};

export default function Settings() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newHoliday, setNewHoliday] = useState({ on_date: "", name: "" });
  const [devices, setDevices] = useState<Device[]>([]);
  const [newDevice, setNewDevice] = useState({ serial: "", model: "", branch_id: "" });
  const [newShop, setNewShop] = useState("");
  // which shop an unregistered machine should be assigned to
  const [attemptBranch, setAttemptBranch] = useState<Record<string, string>>({});
  const { reloadBranches, branchId } = useBranch();
  const [attempts, setAttempts] = useState<{ serial: string; last_seen: string; hits: number }[]>([]);

  const load = async () => {
    const [b, h, d, at] = await Promise.all([
      supabase.from("branches").select("*").order("created_at"),
      supabase.from("holidays").select("*").gte("on_date", new Date().toISOString().slice(0, 10)).order("on_date"),
      // all shops' machines are listed together: seeing both at once is
      // how you spot one plugged into the wrong shop
      supabase.from("devices").select("id, serial, model, last_seen_at, branch_id"),
      supabase.from("device_attempts").select("serial, last_seen, hits").order("last_seen", { ascending: false }),
    ]);
    setAttempts(at.data ?? []);
    setBranches(b.data ?? []);
    setHolidays(h.data ?? []);
    setDevices(d.data ?? []);
  };

  useEffect(() => {
    load();
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    setError(null);
  };

  const saveBranch = async (b: Branch) => {
    const { error: err } = await supabase.from("branches").update({
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      radius_m: b.radius_m,
      wifi_ssid: b.wifi_ssid || null,
    }).eq("id", b.id);
    if (err) setError(err.message);
    else flash(`${b.name} saved. Workers get the new fence next time they open the app.`);
  };

  const editBranch = (id: string, patch: Partial<Branch>) =>
    setBranches(branches.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const addHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHoliday.on_date || !newHoliday.name) return;
    const { error: err } = await supabase.from("holidays").insert(
      branches.map((b) => ({ branch_id: b.id, ...newHoliday })),
    );
    if (err) setError(err.message);
    else {
      setNewHoliday({ on_date: "", name: "" });
      flash("Holiday added.");
      await load();
    }
  };

  const removeHoliday = async (h: Holiday) => {
    const { error: err } = await supabase.from("holidays").delete().eq("id", h.id);
    if (err) setError(err.message);
    else await load();
  };

  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Where the shop is, when shifts run, and which days are holidays.</p>
      </div>
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <h2>Shop location (geofence)</h2>
      {branches.map((b) => (
        <div className="card form-grid" key={b.id}>
          <label>
            Branch name
            <input value={b.name} onChange={(e) => editBranch(b.id, { name: e.target.value })} />
          </label>
          <label>
            Latitude
            <input
              type="number" step="any" value={b.lat ?? ""}
              onChange={(e) => editBranch(b.id, { lat: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
          <label>
            Longitude
            <input
              type="number" step="any" value={b.lng ?? ""}
              onChange={(e) => editBranch(b.id, { lng: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
          <label>
            Check-in radius (metres)
            <input
              type="text" inputMode="numeric" value={b.radius_m}
              onChange={intFieldHandler((n) => editBranch(b.id, { radius_m: n }), 4)}
            />
          </label>
          <label>
            Shop Wi-Fi name (backup check)
            <input
              value={b.wifi_ssid ?? ""} placeholder="exact Wi-Fi name"
              onChange={(e) => editBranch(b.id, { wifi_ssid: e.target.value })}
            />
          </label>
          <button className="btn primary" onClick={() => saveBranch(b)}>Save location</button>
        </div>
      ))}
      <p className="muted hint-line">
        Tip: in Google Maps, right-click the shop and click the numbers to copy
        latitude and longitude.
      </p>

      <h2>Shift timings</h2>
      <div className="card">
        <span className="muted">
          Shift timings are set per person — open the <strong>Staff</strong> page, pick
          someone, and set their start, end, and lunch break there. Staff with timings get
          automatic reminders; staff without timings are never marked late.
        </span>
      </div>

      <h2>Joining codes</h2>
      <div className="card">
        <p className="muted" style={{ marginBottom: 10 }}>
          Each shop has its own code. New staff install the app, tap "New staff? Join",
          and enter the code for the shop they work at — that is what puts them in the
          right shop. They then appear on the Staff page for your one-tap approval.
        </p>
        {branches.map((b) => (
          <div className="filter-row" key={b.id} style={{ marginTop: 12 }}>
            <span className="join-code">{b.join_code ?? "······"}</span>
            <div>
              <strong>{b.name}</strong>
              <div className="muted note">code for this shop</div>
            </div>
            <button
              className="btn"
              onClick={async () => {
                const fresh = String(Math.floor(100000 + Math.random() * 900000));
                const { error: err } = await supabase
                  .from("branches").update({ join_code: fresh }).eq("id", b.id);
                if (err) setError(err.message);
                else {
                  flash(`New code for ${b.name}. Share it with staff who still need to join.`);
                  await load();
                  await reloadBranches();
                }
              }}
            >
              ↻ New code
            </button>
          </div>
        ))}
      </div>

      <h2>Add another shop</h2>
      <form
        className="card holiday-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newShop.trim()) return;
          const { error: err } = await supabase.from("branches").insert({
            name: newShop.trim(),
            radius_m: 100,
            join_code: String(Math.floor(100000 + Math.random() * 900000)),
          });
          if (err) setError(err.message);
          else {
            setNewShop("");
            flash("Shop added. Switch to it in the sidebar, then set its location below.");
            await load();
            await reloadBranches();
          }
        }}
      >
        <input
          placeholder="Shop name, e.g. Krishnanagar"
          value={newShop}
          onChange={(e) => setNewShop(e.target.value)}
        />
        <button className="btn primary" type="submit">Add shop</button>
      </form>

      <h2>Fingerprint machines</h2>
      <p className="muted hint-line" style={{ marginTop: 0 }}>
        Each shop has its own machine. Which shop a machine belongs to decides whose
        attendance its punches count towards — enrollment numbers restart on every
        machine, so #70 at one shop is a different person from #70 at the other.
      </p>

      {attempts.filter((a) => !devices.some((d) => d.serial === a.serial)).map((a) => (
        <div className="banner warn" key={a.serial} style={{ cursor: "default" }}>
          <span style={{ flex: 1 }}>
            A machine with serial <strong>{a.serial}</strong> is trying to connect
            ({a.hits} time{a.hits > 1 ? "s" : ""}, last{" "}
            {new Date(a.last_seen).toLocaleTimeString("en-IN", {
              hour: "numeric", minute: "2-digit",
            })}
            ) but is not registered yet.
          </span>
          <select
            value={attemptBranch[a.serial] ?? branchId ?? ""}
            onChange={(e) => setAttemptBranch({ ...attemptBranch, [a.serial]: e.target.value })}
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button
            className="btn small primary"
            onClick={async () => {
              const target = attemptBranch[a.serial] ?? branchId;
              if (!target) return;
              const { error: err } = await supabase.from("devices").insert({
                branch_id: target,
                serial: a.serial,
                model: "Realtime T304F Mini",
              });
              if (err) setError(err.message);
              else {
                const bname = branches.find((b) => b.id === target)?.name ?? "";
                flash(`Machine ${a.serial} registered to ${bname} — its punches will now be accepted.`);
                await load();
              }
            }}
          >
            Register here
          </button>
        </div>
      ))}

      <form
        className="card holiday-row"
        onSubmit={async (e) => {
          e.preventDefault();
          const target = newDevice.branch_id || branchId;
          if (!newDevice.serial.trim() || !target) return;
          const { error: err } = await supabase.from("devices").insert({
            branch_id: target,
            serial: newDevice.serial.trim(),
            model: newDevice.model.trim() || null,
          });
          if (err) {
            setError(
              err.message.includes("duplicate") || err.message.includes("unique")
                ? "That serial number is already registered."
                : err.message,
            );
          } else {
            setNewDevice({ serial: "", model: "", branch_id: "" });
            flash("Machine registered — punches from this serial number will now be accepted.");
            await load();
          }
        }}
      >
        <input
          placeholder="Serial number (device menu → Info)"
          value={newDevice.serial}
          onChange={(e) => setNewDevice({ ...newDevice, serial: e.target.value })}
        />
        <input
          placeholder="Model, e.g. Realtime T304F Mini"
          value={newDevice.model}
          onChange={(e) => setNewDevice({ ...newDevice, model: e.target.value })}
        />
        <span className="inline-label">
          At which shop?
          <select
            value={newDevice.branch_id || branchId || ""}
            onChange={(e) => setNewDevice({ ...newDevice, branch_id: e.target.value })}
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </span>
        <button className="btn primary" type="submit">Register machine</button>
      </form>

      <table>
        <thead>
          <tr><th>Serial</th><th>Model</th><th>Shop</th><th>Last synced</th><th>Status</th></tr>
        </thead>
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No machine registered yet. Punches are only accepted from registered serial
                numbers.
              </td>
            </tr>
          )}
          {devices.map((d) => {
            const fresh =
              d.last_seen_at &&
              Date.now() - new Date(d.last_seen_at).getTime() < 2 * 3600 * 1000;
            return (
              <tr key={d.id}>
                <td><strong>{d.serial}</strong></td>
                <td>{d.model ?? "—"}</td>
                <td>
                  <select
                    value={d.branch_id}
                    onChange={async (e) => {
                      const { error: err } = await supabase
                        .from("devices")
                        .update({ branch_id: e.target.value })
                        .eq("id", d.id);
                      if (err) setError(err.message);
                      else {
                        const bname = branches.find((b) => b.id === e.target.value)?.name ?? "";
                        flash(`${d.serial} now belongs to ${bname}.`);
                        await load();
                      }
                    }}
                  >
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </td>
                <td className="muted">
                  {d.last_seen_at
                    ? new Date(d.last_seen_at).toLocaleString("en-IN", {
                        day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
                      })
                    : "never"}
                </td>
                <td>
                  <span className={`pill ${fresh ? "good" : "serious"}`}>
                    {fresh ? "Connected ✓" : "Not syncing"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Holidays</h2>
      <form className="card holiday-row" onSubmit={addHoliday}>
        <input
          type="date" value={newHoliday.on_date}
          onChange={(e) => setNewHoliday({ ...newHoliday, on_date: e.target.value })}
        />
        <input
          placeholder="e.g. Durga Puja" value={newHoliday.name}
          onChange={(e) => setNewHoliday({ ...newHoliday, name: e.target.value })}
        />
        <button className="btn primary" type="submit">Add holiday</button>
      </form>
      <table>
        <thead>
          <tr><th>Date</th><th>Holiday</th><th></th></tr>
        </thead>
        <tbody>
          {holidays.length === 0 && (
            <tr><td colSpan={3} className="muted">No upcoming holidays.</td></tr>
          )}
          {holidays.map((h) => (
            <tr key={h.id}>
              <td>{h.on_date}</td>
              <td>{h.name}</td>
              <td>
                <button className="btn small danger" onClick={() => removeHoliday(h)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
