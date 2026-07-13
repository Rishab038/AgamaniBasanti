# AgamaniBasanti — Staff Management System

Attendance + salary system for a cloth shop: worker mobile app
(geofenced selfie check-in), owner web dashboard, and fingerprint
machine cross-verification. Runs entirely on free tiers
(₹0/month) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repo layout

| Path | What it is |
|---|---|
| `apps/mobile` | Worker app — Expo (SDK 57) / React Native, Android-first |
| `apps/admin` | Owner dashboard — React + Vite, deploys to Cloudflare Pages |
| `supabase/migrations` | Postgres schema, RLS policies, attendance logic |
| `supabase/functions/adms` | Receiver for fingerprint-machine punches (ADMS + bridge) |
| `supabase/functions/cleanup-selfies` | Deletes selfie images past retention (hashes kept) |
| `infra/cloudflare-worker` | Free proxy: device's hardcoded `/iclock/*` → Supabase function |
| `bridge/` | Fallback: Python LAN poller if the machine has no cloud push |
| `docs/DEVICE_SETUP.md` | Delivery-day checklist for the fingerprint machine |
| `.github/workflows/backup.yml` | Nightly pg_dump (free tier has no backups) |

## First-time setup

1. **Supabase** — create a free project at supabase.com, then:
   ```
   npm i -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push                     # applies the 3 migrations
   supabase secrets set ADMS_SHARED_SECRET=<long-random-string>
   supabase functions deploy adms
   supabase functions deploy cleanup-selfies
   ```
2. **Enable `pg_cron`** in the dashboard (Database → Extensions) if migration 0003
   printed a notice about it.
3. **Create the owner login**: Authentication → Add user (email + password), then in
   the SQL editor insert their `profiles` row with `role = 'owner'`, plus one
   `branches` row with the shop's coordinates.
4. **Worker accounts**: create auth users with email `w07@staff.agamani.app` /
   password = 6-digit PIN, and matching `profiles` rows (`employee_code = 'W07'`).
   The Staff page automates this in Phase 2.
5. **Backups**: add the `SUPABASE_DB_URL` secret in GitHub → repo Settings →
   Secrets → Actions (workflow is already in place).

## Running the apps

```
# worker app (scan QR with Expo Go on an Android phone)
cd apps/mobile
copy .env.example .env    # fill in Supabase URL + anon key
npx expo start

# owner dashboard
cd apps/admin
copy .env.example .env
npm run dev
```

## Status (2026-07-14)

- ✅ Phase 1 foundation: schema + RLS + cross-verification logic, check-in flow
  (geofence, selfie hash, offline queue, anti-spoof basics), dashboard shell with
  live "Today" board.
- 🔜 Fingerprint machine **ordered, not yet delivered** — everything is ready for
  it; on arrival follow [docs/DEVICE_SETUP.md](docs/DEVICE_SETUP.md).
- 🔜 Phase 1 remainders: selfie watermark burn-in (react-native-view-shot),
  Wi-Fi SSID fallback (netinfo), Play Integrity — all need a dev build
  (`expo-dev-client`) instead of Expo Go.
- 🔜 Phase 2: Staff/Attendance/Settings pages, exports. Phase 3: payroll engine +
  advances. See the roadmap in docs/ARCHITECTURE.md.
