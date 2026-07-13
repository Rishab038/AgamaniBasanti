# Fingerprint Machine — Delivery-Day Checklist

Everything on the software side is already built and waiting. When
the machine arrives, this is the entire integration procedure.

## Before unboxing (5 minutes)

1. **Note the exact brand + model number** (photo of the label on the box/back).
2. Find out which path applies:
   - **Path A — ADMS / Cloud Push** (best): the device menu has something like
     *Comm → Cloud Server / ADMS / Server Settings* where you can enter a server
     address. eSSL and ZKTeco models with "ADMS" in the spec sheet have this.
   - **Path B — LAN only**: no cloud menu, but the device is reachable on the shop
     network on TCP port 4370 (almost all eSSL/ZKTeco/Realtime models are).
3. Ask the vendor: *"Does it support pushing attendance to a custom HTTP server URL
   (ADMS)? Does it support HTTPS or only HTTP?"* Write the answers down.

## One-time cloud prep (already scripted, ~10 minutes)

1. In Supabase, set the function secret (once):
   `supabase secrets set ADMS_SHARED_SECRET=<long-random-string>`
2. Deploy the receiver: `supabase functions deploy adms`
3. Register the machine in the database (SQL editor):
   ```sql
   insert into devices (branch_id, serial, model)
   values ('<branch-uuid>', '<SERIAL-FROM-DEVICE-MENU>', '<model>');
   ```
   The serial is shown in the device menu (usually *System → Info → Serial No*).
   **Unregistered serials are rejected** — this is deliberate.

## Path A: ADMS device (15 minutes at the shop)

1. Deploy the proxy once from your laptop:
   ```
   cd infra/cloudflare-worker
   npx wrangler deploy
   npx wrangler secret put ADMS_SHARED_SECRET   # same value as Supabase
   ```
   (The proxy exists because ADMS devices hardcode the `/iclock/*` URL path and
   only let you configure a host — the worker forwards to the Supabase function
   and injects the secret header.)
2. On the device: *Comm → Ethernet/Wi-Fi* → join the shop network.
3. *Comm → Cloud Server Setting* → Server Address = `agamani-adms-proxy.<your-subdomain>.workers.dev`,
   Port = `443`, enable HTTPS if offered.
   - If the device is HTTP-only and refuses the connection, attach the worker to a
     Cloudflare custom domain with "Always Use HTTPS" disabled — or use Path B.
4. Punch a test finger. Within ~1 minute the row should appear in `device_punches`
   and the dashboard's device banner should clear (heartbeat updated).

## Path B: LAN bridge (20 minutes at the shop)

1. Give the device a static IP on the shop router (e.g. 192.168.1.201).
2. On the shop PC: install Python 3, then
   ```
   cd bridge
   pip install -r requirements.txt
   copy config.example.json config.json    # fill in IP, serial, URL, secret
   python pyzk_bridge.py                   # should print "synced N punches"
   ```
3. Windows Task Scheduler → new task → run `python pyzk_bridge.py` every 5 minutes,
   "run whether user is logged on or not".
4. Same test: punch a finger, check `device_punches`.

## Enrolling workers (once per worker)

1. Enroll the worker's finger on the machine; note the **enrollment/user ID** the
   machine assigns (e.g. `7`).
2. Put that number on their profile:
   ```sql
   update profiles set device_enroll_no = 7 where employee_code = 'W07';
   ```
   (The Staff page of the dashboard will do this with a form in Phase 2.)
3. From then on, cross-verification is automatic: app + fingerprint within
   15 minutes = VERIFIED.

## How you know it's working

- `devices.last_seen_at` updates on every contact — the dashboard shows a red
  banner if the machine goes quiet for 2+ hours.
- Duplicate pushes are harmless (unique index dedups them).
- The machine buffers punches locally when the internet is down and re-sends —
  nothing is lost during outages on either path.
