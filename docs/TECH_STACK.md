# AgamaniBasanti — Complete Technology Stack

Everything used to build, run, and deliver the two-shop staff attendance &
payroll system. Every hosted service below runs on its free tier; recurring
cost is ₹0/month.

---

## 1. At a glance

| Layer | Technology | Role |
|---|---|---|
| Worker mobile app | **Expo / React Native (SDK 57), TypeScript** | Check-in, lunch, payslips, advances |
| Owner web dashboard | **React + Vite + TypeScript** | Staff, attendance, payroll, approvals |
| Backend + DB + Auth | **Supabase** (Postgres, Auth, Storage, Edge Functions, Realtime, pg_cron, pg_net) | Everything server-side |
| Web hosting | **Cloudflare Pages** | Dashboard + fingerprint-machine proxy |
| App build & delivery | **EAS Build + EAS Update** | APKs and over-the-air updates |
| Push notifications | **Expo Push + Firebase Cloud Messaging** | Shift reminders, advance decisions |
| Fingerprint machine | **Realtime T304F Mini** (ADMS / ZK protocol) | Second verification factor |
| Backups | **GitHub Actions** (nightly `pg_dump`) | Free-tier has no auto backup |
| Source control | **Git / GitHub** | Code + CI |

```
 WORKER PHONE                SUPABASE (the whole backend)             OWNER BROWSER
 Expo / RN app        ┌───────────────────────────────────┐         React on
  check-in ───HTTPS──►│  Auth (phone+PIN / email)         │◄─HTTPS──  Cloudflare Pages
  offline queue       │  Postgres + Row Level Security     │         (dashboard)
  push (FCM) ◄────────┤  Storage · Edge Functions (Deno)  ├────────► live "Today"
                      │  Realtime · pg_cron · pg_net      │          (Realtime)
 FINGERPRINT          └────▲───────────────┬──────────────┘
 MACHINE (shop LAN) ──ADMS─┘               │ cron → Expo Push → phones
  Realtime T304F      via Cloudflare        └─ send-push → FCM
                      Pages proxy /iclock/*
```

---

## 2. Worker mobile app  (`apps/mobile`)

- **Expo SDK 57** (managed) + **React Native 0.86** + **React 19** + **TypeScript** —
  cross-platform native app without touching Android Studio for day-to-day work.
- **@supabase/supabase-js** — talks to the backend; auth session persisted in
  **@react-native-async-storage/async-storage**.
- **expo-location** — GPS for the geofence check (Balanced accuracy, 12 s interval).
- **expo-notifications** + **expo-device** — push registration & display.
- **expo-updates** — over-the-air JS updates; auto-checks on foreground.
- **expo-sqlite** — the offline queue (punches saved locally, synced later).
- **expo-crypto** — device-id generation / hashing.
- **expo-haptics** — tactile feedback on each punch.
- **expo-linear-gradient**, **expo-status-bar**, **expo-font** — UI.
- **@expo/vector-icons** (Ionicons) — the bottom-tab icons.
- **@expo-google-fonts/inter** — Inter, the app typeface (3 weights).
- **react-native-url-polyfill** — required by supabase-js on RN.

> Removed on purpose: **expo-camera** / selfie capture — the fingerprint machine
> is the second factor, so the photo added friction without adding evidence.

## 3. Owner web dashboard  (`apps/admin`)

- **React 19 + Vite + TypeScript** — fast SPA, built to static files.
- **react-router-dom** — Today / Staff / Attendance / Approvals / Salary / Settings.
- **lucide-react** — sidebar icons.
- **@supabase/supabase-js** — same backend, owner-scoped by Row Level Security.
- Hand-written CSS design system (Inter, warm terracotta/cream palette, one
  accent colour) — no UI framework.

---

## 4. Supabase — the entire backend

One Supabase project (`zhekzbooxkuosolubdjd`, Mumbai region) provides:

- **Postgres** — the database. **29 migrations** in `supabase/migrations`
  covering schema, attendance logic, the payroll engine (NORMAL / CONTRACT /
  PF-statutory / daily-wage), shift rules, multi-branch, and notifications.
- **Auth** — workers sign in with **mobile number + 6-digit PIN** (mapped to
  `<phone>@staff.agamani.app`, no SMS cost); managers with email + password.
- **Row Level Security** — roles enforced *in the database*: `owner`,
  `supervisor`, `worker`. A worker can only ever read their own rows; salary is
  owner-only. This is the real security boundary, not the UI.
- **Storage** — private bucket for any attendance images (insert-only for
  workers = tamper-evidence).
- **Edge Functions (Deno/TypeScript)** — five, see §6.
- **Realtime** — the dashboard "Today" board updates live as punches land.
- **pg_cron** — scheduled jobs (nightly attendance finalize, shift reminders,
  push delivery). See §7.
- **pg_net** — lets cron call edge functions over HTTP (drives push delivery).

## 5. Hosting & delivery

- **Cloudflare Pages** — hosts the dashboard at `agamani-admin.pages.dev`
  (free, unlimited bandwidth, commercial use allowed — unlike Vercel's free
  tier). Also hosts the **ADMS proxy as a Pages Function** at `/iclock/*`, so the
  fingerprint machine reaches Supabase without a separate server.
- **EAS Build** — builds the Android APK in Expo's cloud (free tier ~30/mo).
- **EAS Update** — over-the-air JS/asset updates on the `preview` channel; UI and
  logic fixes reach installed apps without a reinstall.
- **`wrangler`** — Cloudflare's CLI, used to deploy the dashboard.
- **`supabase` CLI** — pushes migrations and deploys edge functions.

## 6. Edge functions  (`supabase/functions`)

| Function | Purpose | Auth |
|---|---|---|
| `adms` | Receives fingerprint-machine punches (ADMS/iclock protocol + a JSON bridge route) | shared secret + serial allowlist |
| `staff-admin` | Owner actions needing the service-role key: create worker/manager, reset PIN, change phone, approve, bulk add | owner JWT re-checked |
| `self-register` | Worker self-onboarding via the shop join code | shop code + owner approval |
| `send-push` | Delivers queued notifications to phones via Expo Push | shared secret |
| `cleanup-selfies` | Deletes stored images past retention (hash kept) | shared secret |

## 7. Scheduled jobs (pg_cron)

| Job | Schedule | What it does |
|---|---|---|
| `finalize-yesterday` | 00:30 IST | Marks ABSENT / HOLIDAY / OFF_DAY for anyone with no punch |
| `shift-reminders` | every 5 min | Queues "shift soon / not checked in / check out" notifications |
| `send-push` | every 5 min | Carries queued notifications out to phones (pg_net → send-push → Expo → FCM) |

## 8. Push notifications — Firebase

Android push needs **Firebase Cloud Messaging (FCM)**:

- **Firebase project** `agamani-basanti` with an Android app registered for
  package `com.agamani.staff`.
- **`google-services.json`** bundled into the app (`android.googleServicesFile`).
- **FCM V1 service-account key** uploaded to EAS, so Expo's push service can
  deliver on your behalf.
- Flow: DB writes a `notifications` row → `send-push` reads unsent ones → Expo
  Push API → FCM → the phone (works even when the app is closed).

## 9. Fingerprint machine integration

- **Realtime T304F Mini** — face + fingerprint device, one per shop.
- **ADMS / "cloud push"**: the machine POSTs punches to a server URL. It reaches
  `agamani-admin.pages.dev/iclock/*`, the Cloudflare Pages proxy forwards to the
  `adms` edge function (injecting the shared secret), which upserts into
  `device_punches` (deduped by a unique index).
- **Fallback** (`bridge/pyzk_bridge.py`) — if a machine lacks cloud push, a small
  Python script on the shop PC polls it over the ZK protocol (port 4370) and
  POSTs to the same endpoint.
- Cross-verification: an app check-in + a machine punch the same day →
  **VERIFIED** automatically. Enrollment numbers are per-machine (per-branch).

## 10. Security model

- **Row Level Security** on every table — the database, not the app, enforces who
  sees what. Verified: 0 functions callable by the anonymous key.
- **Roles**: owner / supervisor / worker, plus a public path (self-register)
  gated by shop code + approval.
- **Secrets**: shared secret for machine/push endpoints stored in a locked-down
  `internal_secrets` table (RLS, no policies) + Supabase function secrets; the
  service-role key never leaves the server.
- **Audit log** — append-only triggers record every attendance/salary/advance
  change with actor and before/after values.
- **Anti-spoofing** — mock-location block, VPN/dev-mode flags, device binding,
  and the fingerprint machine as the physical anchor.
- **Consent** — recorded per worker (India DPDP Act) before first check-in.

## 11. Cost

| Service | Tier | Cost |
|---|---|---|
| Supabase | Free (500 MB DB, 1 GB storage, 50K MAU) | ₹0 |
| Cloudflare Pages | Free (unlimited bandwidth) | ₹0 |
| EAS Build / Update | Free | ₹0 |
| Expo Push + Firebase FCM | Free | ₹0 |
| Firebase (Spark) | Free | ₹0 |
| GitHub (repo + Actions) | Free | ₹0 |
| **Recurring total** | | **₹0/month** |

Optional one-time: Play Store account ₹2,150 (skippable — APKs distribute
directly); a custom domain ~₹1,000/yr. Scale escape hatch: Supabase Pro ~₹2,150/mo,
or self-host Supabase on a small VPS since it's open source.

## 12. Accounts / services to keep credentials for

Supabase · Cloudflare · Expo (EAS) · Firebase/Google · GitHub. Plus the app's
shared secret (`.env.adms`) and both owner logins — keep all in a password
manager.

## 13. Languages & tools summary

- **Languages**: TypeScript (app, dashboard, edge functions), SQL/PL-pgSQL
  (database logic), Python (fingerprint bridge), a little Deno-flavoured TS.
- **Runtimes**: Node/Hermes (RN), browser (dashboard), Deno (edge functions),
  Postgres (database).
- **CLIs**: `supabase`, `eas-cli`, `wrangler`, `expo`, `git`.
