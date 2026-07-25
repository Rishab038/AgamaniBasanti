"""
LAN bridge: fingerprint machine -> Supabase.

Runs on the shop PC alongside Attendance Master. All three readers use
the same machine over the same LAN, and none disturbs the others:

    machine --ADMS push--> vendor portal (onlinerealsoft.com)  [untouched]
    machine <--LAN read--- Attendance Master                   [untouched]
    machine <--LAN read--- this script -> our dashboard

TIMING GUARANTEE
    The punch time we store is the machine's own recorded timestamp
    (r.timestamp), never the time this script happened to run. If the PC
    is off for three days, those punches still arrive with their true
    times when it next runs — only the *delivery* is delayed, never the
    *timing*. Nothing here writes to the machine or edits a timestamp.

WHY IT IS SAFE TO RUN REPEATEDLY
    The server deduplicates on (serial, enroll_no, punched_at), so
    re-sending a punch is a no-op. That lets us re-scan a rolling window
    every run rather than trusting a cursor file: a missed run, a crash
    mid-upload, or a restored backup all self-heal on the next pass.

    We never call clear_attendance() — the machine keeps its own log, so
    the vendor portal and Attendance Master are unaffected.

Setup:  run install.bat  (writes config.json and schedules this)
Manual: pip install -r requirements.txt  &&  python pyzk_bridge.py
"""

import json
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import requests
from zk import ZK

HERE = Path(__file__).parent
CONFIG_FILE = HERE / "config.json"
STATE_FILE = HERE / "last_sync.json"
LOG_FILE = HERE / "bridge.log"

# The deep sweep: how far back to re-read when we have no idea what has
# already been sent (first run, lost state file, long outage). Longer
# than any gap likely to go unnoticed; the server discards what it has.
DEFAULT_LOOKBACK_DAYS = 10

# Normal runs only re-read a little either side of the last success.
# Running every minute, re-sending ten days each time would mean pushing
# well over a thousand rows a minute forever. The overlap is generous
# enough to absorb a device clock nudge or an out-of-order write.
OVERLAP_MINUTES = 90

# A device clock this far out makes every punch it records wrong. We
# report it loudly but never "fix" a stored punch — see TIMING GUARANTEE.
CLOCK_WARN_SECONDS = 120


def log(msg: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # logging must never break the sync


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        sys.exit("config.json missing — run install.bat first")
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def read_cutoff(lookback_days: int) -> datetime:
    """How far back to read this run.

    Normally just past the last successful sync. Falls back to the full
    deep sweep whenever that cursor is missing, unreadable, or so old
    that trusting it would leave a hole — so a lost state file costs one
    slow run, never a lost punch.
    """
    deep = datetime.now() - timedelta(days=lookback_days)
    try:
        last = datetime.fromisoformat(
            json.loads(STATE_FILE.read_text(encoding="utf-8"))["last_ts"]
        )
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return deep
    return max(last - timedelta(minutes=OVERLAP_MINUTES), deep)


def write_cutoff(ts: datetime) -> None:
    try:
        STATE_FILE.write_text(json.dumps({"last_ts": ts.isoformat()}), encoding="utf-8")
    except OSError:
        pass  # next run just re-reads a wider window; nothing is lost


def port_open(ip: str, port: int, timeout: float = 0.4) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((ip, port)) == 0


def local_subnet():
    """This PC's /24, e.g. '192.168.1'. Used to hunt for the machine."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))          # no traffic actually sent
            return s.getsockname()[0].rsplit(".", 1)[0]
    except OSError:
        return None


def discover(port: int):
    """Scan the local /24 for something listening on the device port.

    The machine's IP changes whenever the router hands out a new lease,
    which would otherwise mean a support call every few months.
    """
    base = local_subnet()
    if not base:
        return None
    log(f"looking for the machine on {base}.1-254 port {port} ...")
    candidates = [f"{base}.{i}" for i in range(1, 255)]
    with ThreadPoolExecutor(max_workers=64) as pool:
        results = pool.map(lambda i: port_open(i, port), candidates)
        for ip, ok in zip(candidates, results):
            if ok:
                log(f"found a device at {ip}")
                return ip
    return None


def connect(cfg: dict):
    """Connect, auto-discovering (and remembering) the IP if it moved."""
    port = int(cfg.get("device_port", 5005))
    ip = cfg.get("device_ip") or ""

    if not ip or not port_open(ip, port):
        if ip:
            log(f"{ip}:{port} did not answer - the machine may have a new IP")
        found = discover(port)
        if not found:
            sys.exit(
                f"Could not reach the fingerprint machine on port {port}.\n"
                "Check that it is powered on and on the same network as this PC.\n"
                "Attendance Master shows its IP in the device list."
            )
        ip = found
        cfg["device_ip"] = ip
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    return ZK(ip, port=port, timeout=15).connect(), ip


def check_clock(conn) -> None:
    """Report device clock drift. Never rewrites a recorded punch."""
    try:
        device_now = conn.get_time()
    except Exception:                            # noqa: BLE001
        return
    drift = abs((device_now - datetime.now()).total_seconds())
    if drift > CLOCK_WARN_SECONDS:
        log(
            f"WARNING: the machine's clock reads {device_now:%Y-%m-%d %H:%M:%S}, "
            f"about {drift / 60:.0f} minutes off this PC. Every punch it records "
            "carries that error. Correct it on the machine itself "
            "(Menu > System > Date/Time). Punches already recorded are left "
            "exactly as they are."
        )


def main() -> None:
    cfg = load_config()
    lookback = int(cfg.get("lookback_days", DEFAULT_LOOKBACK_DAYS))
    cutoff = read_cutoff(lookback)
    started = datetime.now()

    conn, ip = connect(cfg)
    try:
        check_clock(conn)
        # Read-only. disable_device() would freeze the keypad for the
        # duration and could turn a worker away mid-punch, so we accept a
        # marginally less atomic snapshot instead — anything missed is
        # picked up by the next run's overlapping window.
        records = conn.get_attendance() or []
    finally:
        conn.disconnect()

    recent = [r for r in records if r.timestamp >= cutoff]

    # Report in even when there is nothing to send. The server stamps a
    # heartbeat on every call, so an empty run still proves the sync is
    # alive — otherwise "working, nobody punched yet" and "broken" look
    # exactly the same from the dashboard side, and the only way to tell
    # them apart is a phone call to the shop.
    payload = {
        "serial": cfg["device_serial"],
        "punches": [
            {
                "enroll_no": int(r.user_id),
                # the machine's own recorded time, verbatim; the server
                # reads it as IST and never substitutes its own clock
                "ts": r.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "status": getattr(r, "status", None),
                "verify": getattr(r, "punch", None),
            }
            for r in recent
        ],
    }

    resp = requests.post(
        cfg["function_url"].rstrip("/") + "/bridge",
        json=payload,
        headers={"x-adms-secret": cfg["shared_secret"]},
        timeout=60,
    )
    resp.raise_for_status()
    body = resp.json()

    # Only advance the cursor once the server has actually accepted the
    # batch. A failed upload raises above, leaving the old cursor in
    # place so the next run resends rather than skipping past.
    write_cutoff(started)

    if recent:
        log(
            f"{ip}: sent {len(recent)} punches since {cutoff:%d %b %H:%M}, "
            f"{body.get('received', '?')} new (the rest were already stored)"
        )
    else:
        log(f"{ip}: connected, no new punches ({len(records)} on the machine)")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:                     # noqa: BLE001
        log(f"ERROR: {exc}")
        sys.exit(1)
