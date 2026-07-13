"""
LAN bridge: fingerprint machine -> Supabase.

Only needed if the delivered machine does NOT support ADMS cloud
push. Runs on the shop PC (Windows Task Scheduler, every 5 min) or
an old Android phone via Termux + cron. Pulls attendance logs over
the ZK protocol (port 4370) and POSTs them to the adms edge
function's /bridge route.

Setup:
    pip install -r requirements.txt
    copy config.example.json -> config.json and fill in values
    python pyzk_bridge.py

Logs stay on the device, so missed runs self-heal on the next one.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import requests
from zk import ZK

HERE = Path(__file__).parent
CONFIG_FILE = HERE / "config.json"
STATE_FILE = HERE / "last_sync.json"


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        sys.exit("config.json missing — copy config.example.json and fill it in")
    return json.loads(CONFIG_FILE.read_text())


def load_last_sync() -> datetime:
    if STATE_FILE.exists():
        return datetime.fromisoformat(json.loads(STATE_FILE.read_text())["last_ts"])
    return datetime(2000, 1, 1)


def save_last_sync(ts: datetime) -> None:
    STATE_FILE.write_text(json.dumps({"last_ts": ts.isoformat()}))


def main() -> None:
    cfg = load_config()
    last_ts = load_last_sync()

    zk = ZK(cfg["device_ip"], port=cfg.get("device_port", 4370), timeout=10)
    conn = zk.connect()
    try:
        conn.disable_device()
        records = conn.get_attendance()
    finally:
        try:
            conn.enable_device()
        finally:
            conn.disconnect()

    new = [r for r in records if r.timestamp > last_ts]
    if not new:
        print(f"up to date ({len(records)} records on device)")
        return

    payload = {
        "serial": cfg["device_serial"],
        "punches": [
            {
                "enroll_no": int(r.user_id),
                # device clock is IST; the edge function attaches +05:30
                "ts": r.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "status": getattr(r, "status", None),
                "verify": getattr(r, "punch", None),
            }
            for r in new
        ],
    }

    resp = requests.post(
        cfg["function_url"].rstrip("/") + "/bridge",
        json=payload,
        headers={"x-adms-secret": cfg["shared_secret"]},
        timeout=30,
    )
    resp.raise_for_status()

    save_last_sync(max(r.timestamp for r in new))
    print(f"synced {len(new)} punches: {resp.json()}")


if __name__ == "__main__":
    main()
