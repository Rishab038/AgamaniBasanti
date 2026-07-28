# Launch Checklist — final gate before client handover

Status as of 2026-07-25. Items marked ⛔ block go-live; ⚠️ should be done
before handover; ✅ verified done.

## ⛔ Blocking — must be fixed before workers rely on the system

- [ ] **Kanchrapara geofence is wrong.** `branches` still has the old test
      coordinates (14.090386, 77.631915 — near Bangalore). No one can ever
      check in at Kanchrapara until the real shop coordinates are saved
      (Settings → Shop location, or tell Claude the lat/lng).
      Krishnanagar (23.412099, 88.494319, 30 m) looks right — confirm the
      30 m radius isn't too tight for GPS drift; 60–100 m is safer.
- [x] ~~15 PF staff have no salary break-up~~ — **done 2026-07-25**, loaded
      from *KRISHNANAGAR SALARY MAY 2026.xlsx*. All 15 now have
      Basic/HRA/Conveyance/Washing. Two were matched by name across a
      spelling difference and are worth a second look:
      *Indrojit sutrodhar* (register: INDRAJIT SUTRADHAR, ₹15,000) and
      *Surojit Majumder* (register: SURIJIT MAJUMDER, ₹10,000).
      Also **Sourav Biswas's salary changed ₹18,000 → ₹15,600** to match
      the register — confirm that is right, he is the per-day (₹600) man.
- [ ] **2 workers have ₹0 salary**: Subham Das, Sujit saha. Not in the
      Krishnanagar register — set their monthly salary on the Staff page.
- [ ] **5 names in the register have no app account yet**: Triptikana
      Biswas, Rima Shaw, Sagar Sarkar, Ram Krishna Saha, Sushabhan Saha.
      The owner can now add them directly (Staff → Add worker → staff
      type **PF** → enter the break-up), or they self-register with the
      shop code and the owner fills the break-up on approval. Their
      figures from the register:

      | Name | Basic | HRA | Conveyance | Washing | Total |
      |---|---|---|---|---|---|
      | Triptikana Biswas | 3000 | 3000 | 1000 | 1000 | 8000 |
      | Rima Shaw | 3000 | 3000 | 0 | 0 | 6000 |
      | Sagar Sarkar | 3000 | 5000 | 2000 | 1000 | 11000 |
      | Ram Krishna Saha | 4000 | 5000 | 2000 | 1000 | 12000 |
      | Sushabhan Saha | 3000 | 4000 | 2000 | 1000 | 10000 |

## ⚠️ Before handover

- [ ] **Push notifications — two real bugs found and fixed 2026-07-25,
      one live confirmation still needed.**
      Diagnosis: reminders *were* being generated correctly (64 queued:
      shift_soon, late, checkout_due, advance) and the send-push cron ran
      every 5 min returning HTTP 200 — but always `{"sent":0}`, because
      **not one worker had a push_token**. `push.ts` wrote it with a
      direct `update` on `profiles`, whose only UPDATE policy is
      owner-only, so it matched zero rows and still reported success.
      Fixes: migration `0031` adds `fn_set_push_token` (SECURITY DEFINER,
      validates the token format, writes one column for `auth.uid()`); the
      app calls that RPC and now logs failures instead of swallowing them;
      and `send-push` only pushes notifications younger than 60 minutes,
      so a stale "your shift starts soon" cannot arrive at midnight. The
      64-row backlog was marked sent (still visible in-app, not pushed).
      **Remaining:** install the new APK, open it, allow notifications,
      then check `select count(push_token) from profiles` — once that is
      non-zero, delivery can be confirmed with any advance approve/reject.
- [ ] **Distribute the new APK to all staff phones.** Only the newest
      build (with google-services.json) can receive notifications. Older
      installs keep working for attendance but stay silent.
- [x] **Test Worker (W33)** — keeping deliberately (client's call) as the
      standing test login. It has ₹0 salary so it will appear in payroll
      runs at zero; harmless, but ignore that row.
- [x] ~~234 old selfies — deletion armed, needs one command~~ — **resolved
      2026-07-27 without the manual step.** Check-in photos were
      reinstated with a 2-day retention and a nightly cron (see the
      section at the end), so the backlog is swept automatically. The
      dangerous `-40` setting is gone; it is `2`, and the function now
      refuses anything under 1 day.
- [ ] **Connect the fingerprint machines.** `device_punches` has 0 rows —
      no machine has ever sent a real punch. When the T304F arrives at
      each shop: plug into shop internet, set the server address to
      `agamani-admin.pages.dev` (port 443, /iclock/), and it self-appears
      on the Settings page for one-tap registration. Enroll staff
      fingerprints; enrollment numbers are already stored per profile.
- [ ] **Owner account for the client.** Two owner logins exist — confirm
      one belongs to the client (their own email + password they chose),
      not just test accounts. Hand over OWNER_GUIDE.md with it.

## Optional / client's call

- [ ] Shift timings are set for only 7 of 36 staff. Staff without timings
      are never marked late and get no shift reminders — fine if that's
      intended; set timings on the Staff page for anyone who should be
      tracked.
- [ ] West Bengal professional-tax slab: the ₹15,001–25,000 → ₹130 band
      was assumed (standard WB slab) — confirm with the client's
      accountant before the first PF payroll.
- [ ] Point the fingerprint machines and any bookmarks at
      `admin.agamanibasantifashion.com` (both URLs work; the pages.dev
      one is fine to keep using).

## ✅ Verified working (today)

- [x] Dashboard live at https://admin.agamanibasantifashion.com with SSL
- [x] Realtime: dashboard *and* worker app update live, no relaunch
      (migration 0030 + app subscription, OTA published)
- [x] All 3 cron jobs healthy, zero failures (finalize, reminders, push)
- [x] Payroll engine: PF formula validated to the paisa on 3 test cases
- [x] Salary page warns when staff have missing pay data (new)
- [x] Staff codes (W01…) hidden from the owner everywhere; staff lists
      alphabetical; names shown in Title Case regardless of how they
      were typed (new)
- [x] Salary page toolbar regrouped — month + actions left, status and
      export right (new)
- [x] Settings page: dead "Shifts" section removed; points to per-person
      timings on Staff page (new)
- [x] App: dead camera code and expo-camera dependency removed (new)
- [x] Both apps typecheck clean; admin dev server compiles clean
- [x] RLS verified: workers see only their own rows; salary owner-only
- [x] Self-onboarding flow (join code → owner approval) live
- [x] Offline queue, geofence, anti-spoofing, audit log in place

## Check-in photos (added 2026-07-27)

Reinstated as the tie-breaker for the geofence, not as an identity check
(the fingerprint machine does that). Behaviour:

- Taken on **arrival only** — lunch and departure stay one tap.
- **Optional at every step.** No camera permission, a broken shutter, or
  "Skip" still records the punch; the row is tagged `no_photo` so a
  doubtful fence with no picture is visible rather than silent.
- Front camera, downscaled to 640px / 50% JPEG before upload.
- Rides in the offline queue as base64, so a punch taken with no signal
  keeps its photo and uploads on sync.
- `selfie_sha256` is stored, so the record can still show the image was
  not swapped after the file itself is gone.

**Retention is 2 days**, enforced by a pg_cron job at 01:50 IST calling
`cleanup-selfies`. The function was rewritten to delete by FILE AGE — the
old one removed whole `yyyy-mm` month folders, which can never express a
2-day rule and is why 234 images from the first experiment were still in
the bucket. It refuses any retention below 1 day, so a stray setting
cannot wipe today's evidence.

The consent screen was updated in the same change: it previously told
workers "the app never takes your picture", which shipping a camera would
have made false.

Owner sees them on **Today** — a thumbnail per row, click to enlarge.
URLs are signed and expire in an hour; the bucket stays private.
