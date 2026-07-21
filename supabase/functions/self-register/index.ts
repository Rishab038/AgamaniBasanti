// Public self-onboarding endpoint (verify_jwt = false): a new
// worker joins with the shop code the owner shared, their own name,
// mobile number, PIN and (optionally) their fingerprint-machine
// number. The account is created INACTIVE — RLS blocks check-ins
// and the app shows a waiting screen until the owner taps Approve.

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function normalizePhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

async function nextEmployeeCode(): Promise<string> {
  const { data } = await admin.from("profiles").select("employee_code");
  let max = 0;
  for (const r of data ?? []) {
    const m = /^W(\d+)$/i.exec(r.employee_code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `W${String(max + 1).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const body = await req.json();

    // The joining code identifies WHICH shop the worker belongs to —
    // with more than one branch it is the routing key, not just a gate.
    const given = String(body.join_code ?? "").replace(/\D/g, "");
    const { data: joinBranch } = await admin
      .from("branches").select("id, name").eq("join_code", given).maybeSingle();
    if (!given || !joinBranch) {
      return json({ error: "Wrong shop code. Ask the owner for the correct one." }, 403);
    }

    const phone = normalizePhone(body.phone);
    const pin = String(body.pin ?? "").trim();
    const name = String(body.full_name ?? "").trim();
    if (!phone) return json({ error: "Enter a valid 10-digit mobile number" }, 400);
    if (!/^\d{6}$/.test(pin)) return json({ error: "PIN must be exactly 6 digits" }, 400);
    if (name.length < 2) return json({ error: "Please enter your full name" }, 400);

    const { data: taken } = await admin
      .from("profiles").select("id").eq("phone", phone).maybeSingle();
    if (taken) {
      return json({ error: "This mobile number is already registered. Try logging in instead." }, 400);
    }

    // Machine numbers are unique PER SHOP, not globally — each branch
    // has its own fingerprint machine with its own numbering, so shop
    // A's #70 and shop B's #70 are different people. (This matches the
    // unique(branch_id, device_enroll_no) index on profiles.)
    const enroll = parseInt(String(body.machine_no ?? ""), 10);
    if (Number.isInteger(enroll) && enroll > 0) {
      const { data: enrollTaken } = await admin
        .from("profiles").select("full_name")
        .eq("device_enroll_no", enroll)
        .eq("branch_id", joinBranch.id)
        .maybeSingle();
      if (enrollTaken) {
        return json({
          error: `Machine number ${enroll} is already taken at ${joinBranch.name}. Check your number and try again, or leave it empty.`,
        }, 400);
      }
    }

    const branch = joinBranch;

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: `${phone}@staff.agamani.app`,
      password: pin,
      email_confirm: true,
    });
    if (createErr) {
      return json({
        error: createErr.message.includes("already")
          ? "This mobile number is already registered. Try logging in instead."
          : createErr.message,
      }, 400);
    }

    const { error: profErr } = await admin.from("profiles").insert({
      id: created.user.id,
      employee_code: await nextEmployeeCode(),
      full_name: name,
      role: "worker",
      branch_id: branch.id,
      phone,
      base_salary: 0,
      joined_on: new Date().toISOString().slice(0, 10),
      device_enroll_no: Number.isInteger(enroll) && enroll > 0 ? enroll : null,
      active: false,       // waits for owner approval
      approved_at: null,
    });
    if (profErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: profErr.message }, 400);
    }

    return json({ ok: true });
  } catch (e) {
    console.error("self-register error:", e);
    return json({ error: "internal error" }, 500);
  }
});
