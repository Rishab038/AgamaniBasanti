# Linking the Fingerprint Machine — Realtime T304F Mini

**Device:** Realtime T304F Mini · **Serial:** `RGS2022036320`
**Installed at:** the shop, 36 staff already enrolled (machine numbers 70–105)

Everything on the software side is built and deployed. What remains is
configuration, in this order.

---

## Step 1 — The address for the machine  ✅ DONE, nothing to do

The fingerprint machine can only be given a **hostname**, not a full URL — it
hardcodes the `/iclock/*` path, which cannot reach a Supabase function directly.
A proxy therefore runs on the dashboard's own domain
([apps/admin/functions/iclock/](../apps/admin/functions/iclock)) and forwards to
the Supabase `adms` function, injecting the shared secret so it never has to be
typed into the machine's keypad.

**The address to enter into the machine:**

| Setting | Value |
|---|---|
| Server address / Domain name | `agamani-admin.pages.dev` |
| Port | `443` |

Verified working: a device handshake to
`https://agamani-admin.pages.dev/iclock/cdata?SN=…` reaches Supabase and returns
the real upstream response.

> Superseded: `infra/cloudflare-worker/` was the original standalone-Worker
> approach. It needed a `workers.dev` subdomain to be registered first, so it was
> replaced by the Pages Function above. Keep it only if a separate custom domain
> is ever wanted (e.g. an HTTP-only device that refuses HTTPS).

---

## Step 2 — Register the machine in the dashboard  (30 seconds)

<https://agamani-admin.pages.dev> → **Settings** → **Fingerprint machine**

| Field | Value |
|---|---|
| Serial number | `RGS2022036320` |
| Model | `Realtime T304F Mini` |

Punches are **only accepted from registered serial numbers** — this is deliberate,
and it is why the endpoint currently answers "unknown device serial" (verified).

Once registered, the row shows **Not syncing** until the first contact, then flips
to **Connected ✓**. The Today page shows a red banner if it ever goes quiet for
2+ hours.

---

## Step 3 — At the shop: put the machine on the network

1. Machine keypad → **Menu** → **Comm.** (or *Communication* / *Network*)
2. **Ethernet / Wi-Fi** → connect to the shop network.
   - Prefer a **static IP** (e.g. `192.168.1.201`) reserved on the router — it
     keeps Path B available as a fallback and survives router restarts.
3. Note the IP address the machine reports; write it down.

---

## Step 4 — Find out which path this device supports

Still in **Menu → Comm.**, look for an entry named any of:

> **Cloud Server Setting** · **ADMS** · **Server Setting** · **Comm. → Cloud**

### ▸ If it EXISTS → Path A (best: machine pushes by itself)

| Setting | Value |
|---|---|
| Server Address / Domain Name | `agamani-admin.pages.dev` |
| Server Port | `443` |
| Enable Domain Name / DNS | **ON** |
| HTTPS / SSL | **ON** if offered |
| Enable Proxy | OFF |

Save and reboot the machine when prompted.

**If the device refuses HTTPS** (some firmware is HTTP-only): tell Claude — we
attach the worker to a Cloudflare custom domain with HTTPS-redirect disabled, or
fall back to Path B. Do not disable security on the Supabase side.

### ▸ If it does NOT exist → Path B (shop PC bridge)

Needs a PC in the shop that stays on during business hours, on the same network.

```powershell
# 1. confirm the machine is reachable (replace with its IP)
Test-NetConnection 192.168.1.201 -Port 4370      # TcpTestSucceeded : True

# 2. install and configure the bridge
cd bridge
pip install -r requirements.txt
copy config.example.json config.json
#    edit config.json: device_ip, device_serial (RGS2022036320),
#    function_url, shared_secret  — Claude supplies the last two
python pyzk_bridge.py                             # expect "synced N punches"
```

Then Task Scheduler → new task → run `python pyzk_bridge.py` every 5 minutes,
"run whether user is logged on or not".

---

## Step 5 — Prove it works (2 minutes, at the machine)

1. Press any enrolled finger on the machine.
2. Within ~1 minute: dashboard → **Settings → Fingerprint machine** → status should
   read **Connected ✓** with a fresh "last synced" time.
3. Dashboard → **Today** → that worker's row should now show a time under the
   **Fingerprint** column (previously "— missing").
4. Have the same person check in on the app within 15 minutes → the status pill
   turns **Verified ✓**. That is the double verification working end to end.

---

## Step 6 — Match staff to their machine numbers

Cross-verification pairs an app check-in with a machine punch using
`profiles.device_enroll_no`. Three ways in, use whichever fits:

- **Self-onboarding (default now):** each worker types their own machine number
  when they join; you confirm it against the register while approving.
- **Staff page:** the "Machine no." column is editable inline at any time.
- **Bulk add:** paste `Name, mobile, machine no.` lines for anyone without a phone.

The transcribed shop register is in [staff_onboarding.csv](staff_onboarding.csv) —
use it as the answer key when approving. Known quirks to confirm with the client:
one worker is enrolled on **11** (everyone else is 70–105), number **100 is
skipped**, and entry **75** needs its Bengali name spelling confirmed.

---

## How it behaves once live

- **Internet drops at the shop:** the machine buffers punches locally
  (tens of thousands) and re-sends when it reconnects. Nothing is lost.
- **Duplicate pushes:** harmless — a unique index on
  `(device_serial, enroll_no, punched_at)` de-duplicates silently.
- **Machine unplugged / offline 2+ hours:** red banner on the Today page.
- **Someone punches the machine but not the app** (or vice versa): the day is
  flagged **Check this** and waits for a one-tap owner decision — it still counts
  as paid unless rejected.

## Reference

- ADMS receiver: [supabase/functions/adms/index.ts](../supabase/functions/adms/index.ts)
- Proxy: [infra/cloudflare-worker/worker.js](../infra/cloudflare-worker/worker.js)
- Bridge fallback: [bridge/pyzk_bridge.py](../bridge/pyzk_bridge.py)
- Shared secret: `.env.adms` in the project root (gitignored — keep a copy in your
  password manager)
