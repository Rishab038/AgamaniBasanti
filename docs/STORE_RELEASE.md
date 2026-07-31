# Getting the app onto Play Store and iPhones

Two different routes, because the two stores treat a private company app
very differently.

| | Android | iPhone |
|---|---|---|
| Route | Google Play, **internal testing track** | **Custom App** via Apple Business Manager |
| Publicly listed? | No | No |
| Who can install | Staff you invite by email | Staff in your Apple Business Manager org |
| Cost | **$25 once** (~₹2,100) | **$99/year** (~₹8,300) |

## What actually costs money

**Apple Business Manager is free.** It does not replace the Apple
Developer Program — you need both. ABM is only the private channel;
the $99/year membership is what lets you build and submit anything at
all, and if it lapses the app stops distributing.

Google's $25 is genuinely one-time, forever.

---

## Before anything: the D-U-N-S number

Apple Business Manager requires a **D-U-N-S number** for Agamani Basanti
Fashions Pvt. Ltd. It is free from Dun & Bradstreet and typically takes
about a week in India, so **start this first** — everything on the Apple
side waits on it.

Apply: <https://developer.apple.com/enroll/duns-lookup/> (checks whether
the company already has one before issuing a new one — many registered
companies do).

You do **not** need it for:
- Google Play as an individual account
- Apple Developer Program if you enrol as an **individual** (see below)

---

## Part 1 — Google Play (do this first, it is the easy one)

### 1. Create the account — $25, once
<https://play.google.com/console/signup>

Choose **personal/individual** unless the client insists the listing show
the company; an organisation account now needs D-U-N-S and verification
and will hold you up for no benefit on a private track.

Google verifies identity with an ID document. Allow a day or two.

### 2. Create the app
Console → **Create app**

- App name: **Agamani Staff**
- Default language: English (India)
- App or game: **App**
- Free or paid: **Free**
- Declarations: tick both

### 3. Fill the required declarations
Under **Policy → App content**:

- **Privacy policy** → `https://admin.agamanibasantifashion.com/privacy`
- **Data safety** — this one matters, answer it honestly. The app collects:
  - *Location* (approximate and precise) — app functionality, **not** shared,
    collected only at the moment of a punch
  - *Photos* — app functionality, not shared, deleted after 2 days
  - *Personal info* (name, phone) — app functionality, account management
  - *Financial info* (salary, credit records) — app functionality, not shared
  - Data **is** encrypted in transit; users **can** request deletion
- **Ads**: no ads
- **Content rating**: fill the questionnaire — it will come out *Everyone*
- **Target audience**: 18+
- **Government apps**: no
- **Financial features**: declare the credit-book / due-payment tracking

### 4. Set up the internal testing track
**Testing → Internal testing → Create new release**

Add staff by email address (their Google account email). Up to 100
testers. They get a link, install from Play, and receive updates
automatically. **No public listing, no review wait, no 14-day testing
requirement** — that rule only applies to public releases.

### 5. Upload the build
Tell me when the app exists in the console and I will produce the AAB
(`eas build --profile production --platform android`). You can either:

- Upload the `.aab` by hand in the console — simplest, no keys to move; or
- Give EAS a Google service-account key so `eas submit` uploads it for you.
  If you want that, **upload the key yourself** at
  <https://expo.dev/accounts/rishab500/settings/credentials> — it is a
  password-equivalent file and should not be pasted into a chat.

---

## Part 2 — iPhone, via Apple Business Manager

### 1. Enrol in the Apple Developer Program — $99/year
<https://developer.apple.com/programs/enroll/>

**Enrol as an individual** (using your own Apple ID). It is far faster —
no D-U-N-S, no company verification — and an individual account can still
publish a Custom App to a company's Business Manager. Enrol as an
organisation only if the client wants "Agamani Basanti Fashions Pvt. Ltd."
shown as the seller, which nobody but the reviewer will see on a private
app.

### 2. Enrol the shop in Apple Business Manager — free
<https://business.apple.com/> → Enrol now

Needs the D-U-N-S number from above, the company's legal details, and a
second person at the company as verification contact. Once approved, note
the **Organisation ID** (Settings → Enrolment Information) — the app is
addressed to that number.

### 3. I prepare the iOS build
Already done in the code:
- Bundle identifier `com.agamani.staff`
- Camera / photos / location permission text (reviewers read these)
- Encryption declaration, so no export-compliance prompt each submission

Still needed once you have the Apple account:
- **An APNs key for push notifications.** The Firebase setup was
  Android-only; iPhone notifications need an Apple Push key uploaded to
  Expo. Create it at developer.apple.com → Certificates → Keys → **+** →
  Apple Push Notification service, then upload the `.p8` **yourself** at
  the Expo credentials page. Like any private key, it should not pass
  through a chat.

No Mac is needed — EAS builds iOS in the cloud.

### 4. Submit as a Custom App
In **App Store Connect → My Apps → +**, create the app, then in
**Pricing and Availability** choose **Custom App** and enter the shop's
Business Manager **Organisation ID**.

It still goes through App Review, but as a private app for a named
organisation the usual "not useful to the general public" objection does
not apply — which is exactly why this route suits you.

**Give the reviewer a test login** in App Store Connect → App Review
Information. Use the standing test worker account. Without it the
reviewer hits a login wall and rejects the build. Say plainly in the
notes: *"Private attendance app for employees of a two-branch clothing
shop. Accounts are created by the owner; there is no public sign-up."*

### 5. Distribute to staff
Once approved, the app appears in Apple Business Manager → **Apps**. Buy
it (free), then distribute either:

- **Redemption codes** — simplest without MDM. Each code is used once in
  the App Store app.
- **Managed distribution** — needs an MDM system; not worth it for 36 people.

---

## What I do, and what only you can do

| | |
|---|---|
| **You** | Pay and create the accounts, complete the questionnaires, enter the D-U-N-S / Organisation ID, upload private keys to Expo |
| **Me** | Produce the AAB and the iOS build, configure submission, fix anything a reviewer objects to |

I do not handle payment details or private keys — you upload those
directly to Expo or Apple so they never pass through a conversation.

## Timing

- **EAS build quota resets 1 August 2026** — production builds can start then
- **D-U-N-S**: about a week — start it today, it blocks the Apple side
- **Google Play internal track**: same day once the account is verified
- **Apple review of a Custom App**: usually a few days

## Meanwhile, nothing is blocked

Direct APK install keeps working for every Android phone, and updates
still ship over the air. The stores add automatic updates and — the real
reason to do this — the only way to get the app onto an iPhone at all.
