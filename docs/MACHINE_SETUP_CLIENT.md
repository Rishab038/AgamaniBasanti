# Connecting the fingerprint machine — Krishnanagar

**Please read first:** nothing in these steps changes the fingerprint
machine itself. Your existing software (Attendance Master) and the
online portal you already use will keep working exactly as they do now.
We are only *reading* attendance from the machine, not taking it over.

You will need about 15 minutes, once.

---

## What you need before you start

1. **The shop computer** — the same one that already runs Attendance
   Master, or any computer connected to the same internet/router as the
   fingerprint machine.
2. **The file we sent you**, `agamani-attendance-setup.zip`. Right-click
   it, choose **Extract All**, and put the folder somewhere easy to find,
   such as the Desktop.

> Please keep that file to yourself — it carries the shop's access key,
> so treat it like a password. There is nothing for you to type in.

---

## Step 1 — Install Python (one time only)

The computer needs a small free program called Python.

1. Go to **https://www.python.org/downloads/**
2. Click the big yellow **Download Python** button.
3. Open the downloaded file.
4. **Very important:** on the first screen, tick the box at the bottom
   that says **"Add python.exe to PATH"**, *then* click Install Now.
5. When it finishes, click Close.

> If the computer already has Python, you can skip this step. Step 2 will
> tell you if it is missing.

---

## Step 2 — Run the setup

1. Open the folder you extracted.
2. Find the file named **`install.bat`**.
3. **Right-click** it and choose **"Run as administrator"**.
   - If Windows shows a blue "Windows protected your PC" box, click
     **More info**, then **Run anyway**.
4. A black window opens and does everything by itself. **There is
   nothing to type.**

   > The machine's serial number, its port and its address on the
   > network are already set or found automatically.

5. Wait a moment. It searches the network for the fingerprint machine,
   then checks that it can reach us.

**If it says the setup is done** — you are finished. Attendance now
updates by itself every minute.

**If it shows an error** — nothing has been set up and nothing is
broken. Take a photo of the screen and send it to Rishab.

---

## Step 3 — Check it worked

Open the dashboard at **admin.agamanibasantifashion.com**, ask a staff
member to put their finger on the machine, and wait about a minute.
Their punch should appear.

---

## That's it — what to remember afterwards

- **Leave that computer switched on during shop hours.** That is the
  only ongoing requirement.
- **If the computer is off for a day or two, nothing is lost.** The
  machine keeps its own record. When the computer is switched on again,
  everything catches up automatically — and each punch keeps the exact
  time it actually happened.
- **Do not change any settings on the fingerprint machine.** Nothing
  needs changing there.

---

## If something looks wrong later

| What you see | What it means |
|---|---|
| Attendance stopped updating | The computer is off, or lost internet. Switch it on — it catches up by itself. |
| The times look wrong | The machine's own clock may be wrong. Tell Rishab; he can see this from his side. |
| A new staff member's punches don't appear | Their fingerprint number needs to be added on the dashboard. |

For anything else, contact Rishab. He can see from his side whether the
machine is reaching us, so most questions can be answered without anyone
visiting the shop.
