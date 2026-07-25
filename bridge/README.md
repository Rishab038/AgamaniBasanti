# Attendance sync — shop PC setup

This connects the fingerprint machine to the Agamani dashboard **without
changing anything on the machine**. Attendance Master and the vendor
portal (`onlinerealsoft.com`) keep working exactly as they do today.

## Why it works this way

The machine can only *push* to one server, and that slot belongs to the
vendor. So instead of taking it, this reads the machine's own stored log
over the shop network — the same way Attendance Master does. Three
readers, one machine, nobody's toes stepped on:

```
                   ┌── ADMS push ──> vendor portal   (unchanged)
  fingerprint  ────┼── LAN read  <── Attendance Master (unchanged)
    machine        └── LAN read  <── this sync ──> Agamani dashboard
```

## Punch times are never altered

Each punch is stored with **the time the machine recorded it**, not the
time the sync ran. If the PC is switched off for three days, those
punches arrive with their true times as soon as it comes back on — only
the *delivery* is delayed, never the *timing*.

Nothing is ever written to the machine, and its log is never cleared.
Deleting or editing a punch time is not something this can do.

The one thing that *can* make times wrong is the **machine's own clock**.
The sync checks it on every run and writes a warning to `bridge.log` if
it has drifted more than two minutes — it never silently "corrects"
punches that were already recorded.

## Setup (once)

1. Copy this whole `bridge` folder to the shop PC.
2. Right-click **`install.bat`** → **Run as administrator**.
3. Answer three questions (serial, port, setup key). Leave the IP blank —
   it finds the machine by itself.

It then tests the connection, and only if that succeeds does it schedule
itself to run **every minute**. If the test fails, nothing is scheduled
and the reason is on screen.

## Day to day

- **Leave the PC on during shop hours.** That is the only requirement.
- Punches appear on the dashboard within about a minute.
- `bridge.log` in this folder records every run.
- If the router gives the machine a new IP, the sync finds it again on
  its own and remembers the new one.

Each run only reads punches since the last successful one (plus 90
minutes of overlap), so running every minute stays cheap. `last_sync.json`
holds that marker — delete it and the next run re-reads the full 10 days
and repairs anything missing.

## If something looks wrong

| Symptom | Cause |
|---|---|
| "Could not reach the fingerprint machine" | Machine off, or on a different network from the PC |
| Punches stop appearing | PC was off — they arrive, with correct times, once it is back |
| Times look shifted | The machine's clock. Check `bridge.log` for the drift warning, then fix it on the machine: Menu → System → Date/Time |

To remove the sync entirely:
`schtasks /Delete /TN "AgamaniAttendanceSync" /F`
