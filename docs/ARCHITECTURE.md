# AgamaniBasanti — Staff Management System
## Architecture, Stack & Roadmap (v1.0 — 2026-07-14)

Staff attendance + payroll system for a cloth shop: worker mobile app, owner web
dashboard, and fingerprint-machine cross-verification.
Constraints: ₹0 development cost, < ₹2,000/month production cost, non-technical owner,
must not touch existing QR/GST billing.

---

## 1. Technology Stack

| Layer | Technology | Free tier used | Prod cost |
|---|---|---|---|
| Mobile app (workers) | **React Native + Expo (managed), TypeScript** | Expo Go for dev; EAS Build free tier (~30 builds/mo) for APKs; EAS Update free tier for OTA JS updates | ₹0 |
| Web admin (owner) | **React + Vite + Mantine UI**, hosted on **Cloudflare Pages** | Unlimited bandwidth, unlimited sites, commercial use allowed | ₹0 |
| Backend + DB + Auth + Storage | **Supabase (free tier)** — Postgres, Auth, Storage, Edge Functions (Deno), Realtime, pg_cron | 500 MB DB, 1 GB storage, 500K edge invocations/mo, 50K MAU auth | ₹0 |
| Push notifications | **Expo Push API** (server-triggered) + **local scheduled notifications** (shift reminders) | Unlimited, free | ₹0 |
| PDF/CSV exports | **Client-side generation** (pdf-lib + Papa Parse in the browser) | N/A — no server compute | ₹0 |
| Device bridge (fingerprint machine) | ADMS cloud-push (built into device) OR Python `pyzk` script on the shop PC | N/A | ₹0 |
| Backups | **GitHub Actions** nightly `pg_dump` → private repo / Backblaze B2 (10 GB free) | 2,000 Action min/mo free | ₹0 |
| CI + code hosting | GitHub private repo | Free | ₹0 |

**Recurring production cost: ₹0/month.** The ₹1,500–2,000 budget is pure headroom:

- Optional custom domain: ~₹1,000/year (~₹85/mo).
- Google Play developer account: **₹2,150 one-time** (or skip it — for 50 internal
  users, distribute the APK directly via WhatsApp/link and push updates over-the-air
  with EAS Update; no store needed).
- If the shop ever outgrows the free tier (multiple branches, hundreds of staff):
  Supabase Pro is ~$25/mo (~₹2,150) — at the edge of budget — or self-host Supabase
  on a ₹400–700/mo VPS (Hetzner/Contabo), since it's open source. That escape hatch
  is a key reason to pick Supabase.

**Why this stack and not the obvious alternatives:**

- **Supabase over Firebase Spark:** Firebase Cloud Functions now require the Blaze
  plan (credit card on file), which breaks the "$0, no card" rule. More importantly,
  salary proration, advance recovery, and attendance cross-matching are *relational,
  reporting-heavy* problems — real SQL with joins, window functions, and `pg_cron`
  beats Firestore document modeling here. Supabase Row Level Security also gives you
  role-based access enforced in the database, not just in app code.
- **Cloudflare Pages over Vercel:** Vercel's Hobby (free) tier prohibits commercial
  use — a client project qualifies as commercial. Cloudflare Pages' free tier
  explicitly allows it and has no bandwidth cap.
- **Expo managed over bare React Native:** you get camera, GPS, secure storage,
  SQLite, and push notifications without touching native code, plus free cloud APK
  builds (no local Android Studio setup needed) and OTA updates so you can fix bugs
  without redistributing the APK.
- **Android-only for v1** (confirm with client — see §5). Workers in this segment are
  overwhelmingly on Android; skipping iOS halves the testing surface and avoids the
  ₹8,500/yr Apple developer fee, and the anti-spoofing checks (mock location flags,
  Play Integrity) are Android APIs anyway.

### Free-tier watchouts (designed around, not discovered later)

1. **Supabase free projects pause after 7 days of inactivity.** Daily attendance
   traffic makes this a non-issue in production; during slow dev weeks, a scheduled
   GitHub Action pings the API daily to keep it warm.
2. **1 GB storage vs. selfies.** 50 workers × 2 punches/day × 26 days ≈ 2,600
   photos/mo. The app compresses each watermarked selfie to ≤ 50 KB (720px JPEG)
   before upload → ~130 MB/month. A `pg_cron` job deletes photos older than 90 days
   (keeping the SHA-256 hash and metadata forever), so steady-state usage is
   ~400 MB — safely inside 1 GB. If the client wants longer photo retention, archive
   monthly to Backblaze B2 (10 GB free) via a GitHub Action.
3. **No automated backups on the free tier.** Nightly `pg_dump` via GitHub Actions is
   mandatory from week 1, not an afterthought.
4. **500 MB database** holds years of data: an attendance row is < 1 KB; a full year
   for 50 workers is ~35K rows ≈ 35 MB including indexes.

---

## 2. Hardware Integration: Fingerprint Machine → Cloud

Three options, in order of preference. All end at the same place: rows in a
`device_punches` table in Postgres.

### Option A — Buy an ADMS/"Cloud Push" capable device (best; ₹6,500–10,000 one-time)

Most low-cost Indian biometric brands (eSSL, ZKTeco, Realtime) sell models with
**ADMS / Cloud Push** — e.g. eSSL K90 Pro+, ZKTeco K40 Pro/WL30 series. These devices
have a settings menu where you enter a **server URL**, and the machine itself POSTs
every punch over plain HTTP whenever it has network — no PC, no middleware.

Flow:
1. Device menu → Comm → Cloud Server Setting → point it at
   `https://<project>.supabase.co/functions/v1/adms?key=<long-random-secret>`.
2. A Supabase Edge Function speaks the (well-documented, plain-text) ADMS push
   protocol: the device sends lines like
   `ATTLOG: <enroll_no>\t<timestamp>\t<status>...`; the function parses them and
   upserts into `device_punches` with a unique index on
   `(device_serial, enroll_no, punched_at)` for dedup, and replies `OK`.
3. The device retries automatically when the shop internet drops — **offline
   buffering is built into the hardware** (they store 50K–100K logs locally).

This is the cleanest and most robust path. If the client is buying a machine anyway,
insist on ADMS support (ask the vendor explicitly: "does it push to a custom HTTP
server URL?").

### Option B — Existing ZK-protocol device + tiny LAN bridge (₹0)

Nearly all cheap fingerprint machines (ZKTeco and eSSL clones) speak the ZK binary
protocol on **TCP/UDP port 4370** over the shop LAN. The mature open-source Python
library **`pyzk`** pulls attendance logs from it.

Flow:
1. A 60-line Python script runs on whatever already exists in the shop — the billing
   PC (Windows Task Scheduler, every 5 min) or even an old Android phone running
   Termux + cron.
2. Script: connect to device IP:4370 → `get_attendance()` → POST new rows to a
   Supabase Edge Function (authenticated with a device secret, *not* the service-role
   key) → record the last-synced timestamp locally → repeat.
3. Same dedup index as Option A handles re-sent rows; if the PC is off for a day, the
   next run catches up because logs stay on the device.

Failure visibility: a `device_heartbeat` timestamp is updated on every successful
sync; the owner dashboard shows a red banner ("Fingerprint machine not synced for
2 hours") when it goes stale.

### Option C — Vendor-software export watcher (last resort)

If the device only talks to vendor software (e.g. eSSL eTimeTrackLite writes to a
local Access/SQL DB or Excel export), a watcher script on the shop PC tails that
file/DB and uploads new rows. Works, but fragile — treat as fallback only.

### Cross-verification logic (the "double verification")

A matching job (`pg_cron`, every 10 minutes, plus on-insert trigger) pairs records:

- App check-in at 09:58 + device punch at 10:01 (same worker, within a configurable
  ±10 min window) → status **VERIFIED**.
- App check-in with no device punch inside the window → **APP_ONLY** (suspicious —
  maybe GPS spoofing that slipped through, or they forgot the machine).
- Device punch with no app check-in → **DEVICE_ONLY** (benign — phone dead/forgotten
  — but flagged).

Only **VERIFIED** counts as clean attendance by default; APP_ONLY / DEVICE_ONLY
punches appear in the owner's "Needs attention" list with one-tap
**Approve / Reject** buttons, and every such decision lands in the audit log. The
worker↔device mapping is just a `device_enroll_no` column on the worker profile, set
once when the worker is enrolled on the machine.

> Note: the fingerprint machine is the real anti-spoofing anchor. GPS can be faked
> with enough effort; a finger physically present in the shop cannot. The app layer
> adds the selfie, timestamps, and self-service dashboard — the machine adds proof of
> presence.

---

## 3. Solution Architecture

```
 ┌────────────────────┐        ┌─────────────────────┐       ┌─────────────────────┐
 │  WORKER PHONE      │        │  SUPABASE (free)     │       │  OWNER BROWSER      │
 │  Expo/React Native │        │                      │       │  React on CF Pages  │
 │                    │  HTTPS │  Auth (email+PIN,    │ HTTPS │                     │
 │  Check-in flow ────┼───────►│   JWT with role)     │◄──────┼── Dashboard,        │
 │  GPS+SSID+selfie   │        │  Postgres + RLS      │       │   approvals,        │
 │  Offline queue     │        │  Storage (selfies)   │       │   payroll, reports  │
 │  (SQLite)          │        │  Edge Functions      │       │   (CSV/PDF client-  │
 │  Local shift       │        │  pg_cron jobs        │       │    side)            │
 │  reminders         │        │  Realtime channel ───┼──────►│  live attendance    │
 └────────────────────┘        └──────▲───────┬───────┘       └─────────────────────┘
                                      │       │
                     ADMS push or     │       │ DB trigger → Edge Fn
                     pyzk bridge      │       ▼
 ┌────────────────────┐               │   Expo Push API ──► worker phones
 │ FINGERPRINT MACHINE├───────────────┘   (advance approved, late warning…)
 │ (shop LAN)         │
 └────────────────────┘
```

### Check-in sequence (happy path)

1. Worker opens app → giant **CHECK IN** button. Button is live only when: inside
   geofence (haversine distance to branch coords ≤ radius) **or** connected to the
   shop's registered Wi-Fi (SSID/BSSID match, used when GPS accuracy > 25 m).
   Otherwise the button is grey with a plain-language message ("You are 240 m from
   the shop") — never an error code.
2. Tap → front camera opens → selfie captured → app burns watermark (name, branch,
   date-time, lat/long) into the JPEG, compresses to ≤ 50 KB, computes SHA-256.
3. Anti-spoofing checks run silently: `isMockLocation` flag, developer-options
   enabled, VPN active (NetworkCapabilities), Play Integrity verdict (free API,
   10K req/day), GPS accuracy sanity, device-ID match against the worker's registered
   device. Any failure → check-in recorded but flagged `SUSPECT` with the reason;
   hard failures (mock location) block outright with a friendly message.
4. Record (coords, accuracy, SSID, device ID, photo hash, client timestamp) is
   written to a **local SQLite queue first**, then synced. Server assigns the
   authoritative `received_at` timestamp; a large client-vs-server clock gap is
   flagged. If offline, the queue drains on reconnect and the record is visibly
   marked "synced late" in both apps — the audit trail requirement.
5. Selfie uploads to a Storage bucket where worker RLS policy is **insert-only** (no
   update/delete ever) — combined with the stored hash, that is the tamper-evidence.
6. The cross-verification job later pairs this with the fingerprint punch (§2).

### Data model (core tables)

`branches` (coords, radius, wifi_ssid/bssid) · `profiles` (role, branch, device_id,
device_enroll_no, base_salary, shift) · `shifts` · `attendance_app` ·
`device_punches` · `attendance_days` (materialized daily status: VERIFIED / APP_ONLY /
DEVICE_ONLY / ABSENT / LEAVE_PAID / LEAVE_UNPAID / HOLIDAY) · `leave_policies` ·
`leave_requests` · `advances` + `advance_repayments` (running balance = view) ·
`payroll_runs` + `payslips` (frozen JSON snapshot of the calculation, so historical
payslips never change when rules change) · `holidays` · `audit_log` (append-only,
written by DB triggers on every UPDATE/DELETE of attendance and salary tables — not
by app code, so it can't be bypassed) · `notifications`.

### Security & roles

- **RBAC via Supabase RLS + JWT claims**: `owner` (everything), `supervisor`
  (attendance monitoring + leave approval for own branch, no salary data), `worker`
  (own rows only). Enforced in Postgres — a compromised app build still can't read
  another worker's salary.
- Workers sign in with **employee code + 4-digit PIN** (mapped to email/password
  under the hood — avoids SMS OTP costs and is one-time set up by you on each
  worker's phone). Session persists; workers never see a login screen again.
- All traffic HTTPS; Postgres encrypted at rest (Supabase default); selfie bucket
  private, owner views via short-lived signed URLs.
- **Multi-branch ready**: every table carries `branch_id` from day one; adding a
  branch = one row in `branches` + assigning workers. No re-architecture.

### Salary engine (Module 2)

Runs as SQL (a view + one Edge Function for month-end freeze):

```
gross        = base_salary × payable_days / working_days_in_month
payable_days = VERIFIED + LEAVE_PAID + HOLIDAY  (+ owner-approved exceptions)
deductions   = unauthorized_absences × per_day_rate      (per leave policy)
advance_cut  = min(agreed_installment, remaining_advance_balance)
net          = gross − deductions − advance_cut
```

Owner clicks "Run payroll" on the 1st → engine computes → owner reviews a preview
table → clicks "Confirm" → payslips freeze and appear in each worker's app. Advance
requests flow: worker taps "Request advance" (amount + reason) → owner gets a push +
dashboard card → Approve/Reject → balance and future deductions update automatically.

---

## 4. Development Roadmap (~10 weeks part-time)

**Phase 0 — Discovery & setup (Week 1)**
Get answers to §5. Create free accounts (Supabase, Cloudflare, Expo, GitHub).
Identify the exact fingerprint machine model and confirm its integration path
(ADMS? port 4370 reachable?). Design schema + RLS policies. Deliverable: signed-off
feature list and the schema migration files.

**Phase 1 — Foundation + attendance core (Weeks 2–3)**
Supabase schema, RLS, auth with roles. Worker app skeleton: login, big-button home
screen, geofence check, selfie + watermark + compression, offline SQLite queue,
anti-spoof checks. Milestone: *you can check in from a real phone at a real location
and see the row + photo in Supabase.*

**Phase 2 — Device bridge + owner dashboard (Weeks 4–5)**
ADMS edge function or pyzk bridge script; cross-verification job; owner web app:
staff CRUD, geofence/Wi-Fi config screens, live attendance board (Supabase
Realtime), "Needs attention" queue. Milestone: *finger on machine + app check-in →
one VERIFIED day appears on the dashboard within minutes.*

**Phase 3 — Salary & advances (Weeks 6–7)**
Leave policies, holiday calendar, salary engine, payroll run + freeze flow, advance
request/approval workflow, payslip screens (worker) + PDF/CSV exports (owner).
Milestone: *a full month of test data produces a correct payslip you've verified by
hand against a spreadsheet.*

**Phase 4 — Notifications, audit, polish (Week 8)**
Local shift reminders (15 min before / at shift end), Expo push for approvals and
late-arrival alerts to owner, audit-log triggers + viewer screen, empty states, and a
Hindi/Bengali language pass on every worker-facing string.

**Phase 5 — Pilot & rollout (Weeks 9–10)**
Sideload the APK to 5 workers; **run parallel to the existing manual register for a
full month** and reconcile weekly — this is your acceptance test and builds the
owner's trust. Fix discrepancies, train the owner (record a 5-minute screen video in
their language), then roll out to all staff. Set up the nightly backup Action and the
keep-warm ping before calling it done.

Testing throughout: unit tests on the salary math (the highest-stakes logic), a
seeded demo dataset, and a "time-travel" flag so you can simulate month-end without
waiting for it.

---

## 5. Assumptions & Questions for the Client

**Hardware**
1. Does a fingerprint machine already exist? Exact brand/model number (photo of the
   label)? This decides Option A vs B vs C in §2.
2. Is there a PC in the shop that stays on during business hours, and does the
   machine sit on the same Wi-Fi/LAN?
3. How stable is the shop's internet? (Determines how loudly to surface sync-delay
   warnings.)

**Attendance policy**
4. Fixed shifts for everyone, or per-worker/rotating shifts? Weekly off day(s)?
5. Grace period for late arrival (e.g. 15 min)? Is a half-day a concept, and after
   how many minutes late?
6. What happens on APP_ONLY / DEVICE_ONLY days by default — count, or hold for
   approval? Who besides the owner can approve (is there a supervisor role on day 1)?
7. Do any staff legitimately work off-site sometimes (deliveries, bank runs)? Need an
   "outdoor duty" exception flow?

**Payroll**
8. Salary structure: fixed monthly, daily wage, or mixed across staff? Any overtime
   or incentives to track, or out of scope for v1?
9. Exact leave policy: paid leave count per month/year, carry-forward, sandwich-leave
   rule for holidays adjoining absences?
10. Advance recovery: fixed installment per month, or flexible per worker? Is
    interest ever charged (assume no)?
11. Payday date, and should payslips show in the worker app before or only after the
    owner confirms?

**Operational / legal**
12. All workers have Android phones? Any shared phones (breaks device-binding —
    needs a policy)? **Assumption: Android-only v1.**
13. Preferred worker-app language — Bengali, Hindi, English, or a toggle?
14. Selfie retention: is 90 days acceptable, or is longer archival required? Confirm
    workers are informed their photo/location is captured at punch time (basic
    consent notice inside the app; advisable under India's DPDP Act).
15. Confirm the system stays fully parallel to QR/GST billing — no integration, not
    even read-only, in v1. (Assumed yes; keeps blast radius zero.)
16. Number of branches today and in the next year (schema supports multi-branch from
    day one either way).
17. Who pays the one-time costs if chosen: Play Store ₹2,150, ADMS-capable machine
    ₹6,500–10,000, domain ~₹1,000/yr?
