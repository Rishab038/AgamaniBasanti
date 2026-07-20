# Go-Live Checklist — Agamani Basanti

System state as of **2026-07-20**: all test data wiped, security hardened,
consent notice live. What remains is configuration that needs real-world values.

---

## 🔴 Blocker — do this before anyone checks in

### 1. Set the real shop location

The geofence still points at a **test location in Bangalore** (13.090313,
77.631921) that was used while developing. Until it is corrected, **no worker at
the shop will be able to check in** — the button will stay grey and report a
distance of a few thousand kilometres.

1. Google Maps → right-click the shop building → click the coordinates to copy.
2. Dashboard → **Settings → Shop location** → paste latitude and longitude.
3. Radius **100 m** is a good default for a shop unit.
4. Fill in the **shop Wi-Fi name** too — it is the indoor fallback for when GPS
   is weak inside the building.

Sanity check: for West Bengal, latitude ≈ 22–27 and longitude ≈ 86–89. If the two
numbers look swapped, they are.

---

## Before handing over

### 2. Create the client's owner login

The only account that exists is the developer's
(`rishabagarwal038@gmail.com`). The client needs their own.

Supabase dashboard → **Authentication → Users → Add user**
- their email + a password they will change
- ✅ **Auto Confirm User** (skip this and login fails with "Email not confirmed")

Copy the new user's UID, then SQL Editor:

```sql
insert into profiles (id, employee_code, full_name, role, branch_id)
values ('<new-uid>', 'OWNER2', '<client name>', 'owner',
        (select id from branches limit 1));
```

Keep the developer account — it is the support route if the client is locked out.

### 3. Empty the test selfies

14 photos from development remain in storage (all of the developer). Supabase
dashboard → **Storage → selfies** → select all → Delete. Direct SQL deletion is
blocked by Supabase on purpose, so this must be done in the UI.

### 4. Turn on leaked-password protection

Supabase dashboard → **Authentication → Policies / Password settings** → enable
**leaked password protection**. It checks new passwords against known breach
lists. One toggle, and the security linter flags its absence.

### 5. Set up the nightly backup

The Supabase free tier has **no automatic backups**. The workflow is already
written at [.github/workflows/backup.yml](../.github/workflows/backup.yml) — it
needs the repo pushed to GitHub and one secret:

GitHub repo → Settings → Secrets → Actions → **`SUPABASE_DB_URL`**
(Supabase → Settings → Database → session pooler URI, with the password filled in)

Until this exists, a mistake in the SQL editor is unrecoverable.

---

## Rollout day at the shop

### 6. Connect the fingerprint machine

Follow [DEVICE_SETUP.md](DEVICE_SETUP.md). Short version:

- Machine menu → **Comm.** → join shop Wi-Fi
- Machine menu → **Comm. → Cloud Server / ADMS** → address
  `agamani-admin.pages.dev`, port `443`, HTTPS on
- Press a finger → dashboard **Settings → Fingerprint machine** should flip to
  **Connected ✓** within a minute

If that menu does not exist on the T304F Mini, use the shop-PC bridge
(`bridge/pyzk_bridge.py`) — instructions in the same document.

### 7. Onboard the staff

1. Dashboard → **Settings → Shop joining code** → note the 6-digit code.
2. Send the staff group one message: the APK link + *"install this, tap
   'New staff? Join', use code XXXXXX."*
3. Each worker enters their own name, mobile number, a PIN they choose, and their
   fingerprint-machine number.
4. Dashboard → **Staff** → each request appears → check the machine number against
   the shop register ([staff_onboarding.csv](staff_onboarding.csv)) → set their
   monthly salary → **Approve**.

Workers without a phone: use **Bulk add** and paste
`Name, mobile, machine no.` lines instead.

### 8. Configure the money rules

Dashboard → **Settings**:
- **Holidays** — Durga Puja, Diwali, and the rest of the year
- Leave allowance and payday come from the client's answers on
  [CLIENT_REQUIREMENTS.pdf](CLIENT_REQUIREMENTS.pdf) — still unanswered:
  paid leave per month, payday date, and the app language (Bengali / Hindi /
  English)

---

## Running it

| When | What |
|---|---|
| Daily | Glance at **Today**. Only "Check this" rows need a decision. |
| As they arrive | **Approvals** — advance requests, one tap each. |
| Month end | **Salary** → Generate draft → review → **Confirm & freeze** → export CSV. |

**Run parallel to the paper register for the first month** and reconcile weekly.
That is both the acceptance test and how the owner comes to trust the numbers.

---

## What is deliberately not built yet

Honest list, so nothing is a surprise:

- **Selfie watermark** — photos are stored with a SHA-256 hash and full metadata
  (time, GPS, device), which is stronger evidence than a burnt-in caption, but the
  visible stamp itself is not drawn yet.
- **Play Integrity / rooted-device detection** — mock-location is blocked; deeper
  device attestation needs a dev-client build.
- **Wi-Fi SSID fallback** — the field exists and is stored, but reading the
  connected SSID needs a native module in a dev-client build.
- **Push notifications** — shift reminders and approval alerts are designed but
  not wired up.
- **Worker leave requests** — the tables and owner-side approval exist; the
  worker-facing request screen does not.
- **Language** — the app is English-only until the client picks Bengali or Hindi.
