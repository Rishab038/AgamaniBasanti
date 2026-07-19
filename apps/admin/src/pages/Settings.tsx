// Shop settings: geofence per branch, shifts, and holidays.
// Everything here is owner-only (enforced by RLS, not just UI).

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Branch = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  wifi_ssid: string | null;
};

type Shift = {
  id: string;
  branch_id: string;
  name: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  week_off: number[];
};

type Holiday = { id: string; branch_id: string; on_date: string; name: string };

type Device = {
  id: string;
  serial: string;
  model: string | null;
  last_seen_at: string | null;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Settings() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newHoliday, setNewHoliday] = useState({ on_date: "", name: "" });
  const [devices, setDevices] = useState<Device[]>([]);
  const [newDevice, setNewDevice] = useState({ serial: "", model: "" });
  const [joinCode, setJoinCode] = useState<string | null>(null);

  const load = async () => {
    const [b, s, h, d, jc] = await Promise.all([
      supabase.from("branches").select("*").order("created_at"),
      supabase.from("shifts").select("*").order("start_time"),
      supabase.from("holidays").select("*").gte("on_date", new Date().toISOString().slice(0, 10)).order("on_date"),
      supabase.from("devices").select("id, serial, model, last_seen_at"),
      supabase.from("app_settings").select("value").eq("key", "shop_join_code").maybeSingle(),
    ]);
    setBranches(b.data ?? []);
    setShifts(s.data ?? []);
    setHolidays(h.data ?? []);
    setDevices(d.data ?? []);
    setJoinCode(jc.data ? String(jc.data.value).replace(/"/g, "") : null);
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

  const saveShift = async (s: Shift) => {
    const { error: err } = await supabase.from("shifts").update({
      name: s.name,
      start_time: s.start_time,
      end_time: s.end_time,
      grace_minutes: s.grace_minutes,
      week_off: s.week_off,
    }).eq("id", s.id);
    if (err) setError(err.message);
    else flash(`Shift "${s.name}" saved.`);
  };

  const editShift = (id: string, patch: Partial<Shift>) =>
    setShifts(shifts.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const toggleWeekOff = (s: Shift, day: number) => {
    const week_off = s.week_off.includes(day)
      ? s.week_off.filter((d) => d !== day)
      : [...s.week_off, day].sort();
    editShift(s.id, { week_off });
  };

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
              type="number" value={b.radius_m}
              onChange={(e) => editBranch(b.id, { radius_m: Number(e.target.value) })}
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

      <h2>Shifts</h2>
      {shifts.map((s) => (
        <div className="card form-grid" key={s.id}>
          <label>
            Shift name
            <input value={s.name} onChange={(e) => editShift(s.id, { name: e.target.value })} />
          </label>
          <label>
            Starts
            <input type="time" value={s.start_time.slice(0, 5)}
              onChange={(e) => editShift(s.id, { start_time: e.target.value })} />
          </label>
          <label>
            Ends
            <input type="time" value={s.end_time.slice(0, 5)}
              onChange={(e) => editShift(s.id, { end_time: e.target.value })} />
          </label>
          <label>
            Late after (minutes)
            <input type="number" value={s.grace_minutes}
              onChange={(e) => editShift(s.id, { grace_minutes: Number(e.target.value) })} />
          </label>
          <div className="weekoff">
            <span>Weekly off:</span>
            {DAYS.map((d, i) => (
              <label key={d} className="weekday">
                <input
                  type="checkbox"
                  checked={s.week_off.includes(i)}
                  onChange={() => toggleWeekOff(s, i)}
                />
                {d}
              </label>
            ))}
          </div>
          <button className="btn primary" onClick={() => saveShift(s)}>Save shift</button>
        </div>
      ))}

      <h2>Shop joining code</h2>
      <div className="card">
        <p className="muted" style={{ marginBottom: 10 }}>
          New staff install the app, tap "New staff? Join", and enter this code with their
          name and mobile number. They appear on the Staff page for your one-tap approval.
        </p>
        <div className="filter-row">
          <span className="join-code">{joinCode ?? "······"}</span>
          <button
            className="btn"
            onClick={async () => {
              const fresh = String(Math.floor(100000 + Math.random() * 900000));
              const { error: err } = await supabase
                .from("app_settings").update({ value: fresh }).eq("key", "shop_join_code");
              if (err) setError(err.message);
              else {
                setJoinCode(fresh);
                flash("New joining code set — share it with staff who still need to join.");
              }
            }}
          >
            ↻ New code
          </button>
        </div>
      </div>

      <h2>Fingerprint machine</h2>
      <form
        className="card holiday-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newDevice.serial.trim() || branches.length === 0) return;
          const { error: err } = await supabase.from("devices").insert({
            branch_id: branches[0].id,
            serial: newDevice.serial.trim(),
            model: newDevice.model.trim() || null,
          });
          if (err) setError(err.message);
          else {
            setNewDevice({ serial: "", model: "" });
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
          placeholder="Model, e.g. Realtime T240F+"
          value={newDevice.model}
          onChange={(e) => setNewDevice({ ...newDevice, model: e.target.value })}
        />
        <button className="btn primary" type="submit">Register machine</button>
      </form>
      <table>
        <thead>
          <tr><th>Serial</th><th>Model</th><th>Last synced</th><th>Status</th></tr>
        </thead>
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
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
