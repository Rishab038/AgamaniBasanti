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

- [ ] **Push notifications untested end-to-end.** No phone has the
      FCM-enabled APK yet (zero push tokens registered). Install the
      latest APK on one phone, open it, allow notifications, then fire a
      test (approve/reject any advance). Notifications are queued
      correctly server-side (cron healthy, 0 failures) — only delivery
      is unverified.
- [ ] **Distribute the new APK to all staff phones.** Only the newest
      build (with google-services.json) can receive notifications. Older
      installs keep working for attendance but stay silent.
- [x] **Test Worker (W33)** — keeping deliberately (client's call) as the
      standing test login. It has ₹0 salary so it will appear in payroll
      runs at zero; harmless, but ignore that row.
- [ ] **234 old selfies (11 MB) — deletion armed, needs one command.**
      `selfie_retention_days` is temporarily set to **-40** so the
      existing `cleanup-selfies` function will sweep the current month.
      Run the command in the handover notes, then set the value back to
      90. Nothing displays these images anymore and the consent screen
      now tells workers "the app never takes your picture", so removing
      them is the privacy-correct end state.
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
