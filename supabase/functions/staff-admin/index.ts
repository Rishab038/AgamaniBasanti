// Owner-only staff administration. Creating/updating login accounts
// requires the service-role key, which must never reach a browser —
// so the dashboard calls this function instead. Every action
// re-verifies that the caller's JWT belongs to a profile with
// role = 'owner'.
//
// Workers log in with their MOBILE NUMBER + PIN; the number maps to
// <phone>@staff.agamani.app under the hood. Employee codes are only
// an internal label (auto-generated when not provided).
//
// Actions (POST JSON { action, ...params }):
//   create_worker { full_name, phone, pin, branch_id,
//                   employee_code?, shift_id?, base_salary?, joined_on?, role? }
//   reset_pin     { profile_id, new_pin }
//   change_phone  { profile_id, new_phone } -- staff changed their number
//   set_active    { profile_id, active }
//   clear_device  { profile_id }            -- allow login from a new phone
//   delete_worker { profile_id }            -- only works if no attendance yet

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

const phoneToEmail = (phone: string) => `${phone}@staff.agamani.app`;

/** "+91 98300-12345" -> "9830012345"; returns null if not a valid Indian mobile */
function normalizePhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** next free internal code: W01, W02, ... */
async function nextEmployeeCode(): Promise<string> {
  const { data } = await admin.from("profiles").select("employee_code");
  let max = 0;
  for (const r of data ?? []) {
    const m = /^W(\d+)$/i.exec(r.employee_code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `W${String(max + 1).padStart(2, "0")}`;
}

type CreateResult =
  | { ok: true; profile_id: string; employee_code: string; phone: string; pin: string }
  | { ok: false; error: string };

/** shared by create_worker and bulk_create_workers; generates a
 *  random 6-digit PIN when none is given */
async function createOneWorker(input: Record<string, unknown>): Promise<CreateResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, error: "invalid mobile number" };
  let pin = String(input.pin ?? "").trim();
  if (!pin) {
    pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  }
  if (!/^\d{6}$/.test(pin)) return { ok: false, error: "PIN must be exactly 6 digits" };
  if (!input.full_name || !input.branch_id) return { ok: false, error: "name and branch are required" };

  const { data: taken } = await admin
    .from("profiles").select("id").eq("phone", phone).maybeSingle();
  if (taken) return { ok: false, error: "this mobile number is already used" };

  const rawCode = String(input.employee_code ?? "").trim().toUpperCase();
  const code = /^[A-Z0-9]{2,12}$/.test(rawCode) ? rawCode : await nextEmployeeCode();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: phoneToEmail(phone),
    password: pin,
    email_confirm: true,
  });
  if (createErr) {
    return {
      ok: false,
      error: createErr.message.includes("already")
        ? "this mobile number already has a login"
        : createErr.message,
    };
  }

  const enroll = Number(input.device_enroll_no);
  const { error: profErr } = await admin.from("profiles").insert({
    id: created.user.id,
    employee_code: code,
    full_name: input.full_name,
    role: input.role === "supervisor" ? "supervisor" : "worker",
    branch_id: input.branch_id,
    shift_id: input.shift_id ?? null,
    phone,
    base_salary: input.base_salary ?? 0,
    joined_on: input.joined_on ?? null,
    device_enroll_no: Number.isInteger(enroll) && enroll > 0 ? enroll : null,
  });
  if (profErr) {
    await admin.auth.admin.deleteUser(created.user.id); // roll back orphaned login
    return { ok: false, error: profErr.message };
  }
  return { ok: true, profile_id: created.user.id, employee_code: code, phone, pin };
}

async function requireOwner(req: Request): Promise<string> {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) throw json({ error: "not signed in" }, 401);
  const { data: prof } = await admin
    .from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "owner") throw json({ error: "owner only" }, 403);
  return user.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    await requireOwner(req);
    const body = await req.json();

    switch (body.action) {
      case "create_worker": {
        const r = await createOneWorker(body);
        if (!r.ok) return json({ error: r.error }, 400);
        return json(r);
      }

      case "bulk_create_workers": {
        // one shot onboarding: array of { full_name, phone,
        // device_enroll_no?, shift_id?, pin? } — PINs are generated
        // when missing and returned so the owner can hand them out
        const rows = Array.isArray(body.workers) ? body.workers : [];
        if (rows.length === 0 || rows.length > 60) {
          return json({ error: "Send between 1 and 60 workers per batch" }, 400);
        }
        const results = [];
        for (const w of rows) {
          const r = await createOneWorker({ ...w, branch_id: w.branch_id ?? body.branch_id });
          results.push({ full_name: w.full_name ?? "", ...r });
        }
        return json({ results });
      }

      case "change_phone": {
        const phone = normalizePhone(body.new_phone);
        if (!phone) {
          return json({ error: "Enter a valid 10-digit mobile number" }, 400);
        }
        const { data: taken } = await admin
          .from("profiles").select("id").eq("phone", phone).neq("id", body.profile_id).maybeSingle();
        if (taken) {
          return json({ error: "Another staff member already uses this number" }, 400);
        }
        const { error: authErr } = await admin.auth.admin.updateUserById(body.profile_id, {
          email: phoneToEmail(phone),
          email_confirm: true,
        });
        if (authErr) return json({ error: authErr.message }, 400);
        const { error } = await admin
          .from("profiles").update({ phone }).eq("id", body.profile_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, phone });
      }

      case "reset_pin": {
        if (!/^\d{6}$/.test(String(body.new_pin ?? ""))) {
          return json({ error: "PIN must be exactly 6 digits" }, 400);
        }
        const { error } = await admin.auth.admin.updateUserById(body.profile_id, {
          password: String(body.new_pin),
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "approve_worker": {
        const update: Record<string, unknown> = {
          active: true,
          approved_at: new Date().toISOString(),
        };
        const salary = Number(body.base_salary);
        if (Number.isFinite(salary) && salary >= 0) update.base_salary = salary;
        const { error } = await admin
          .from("profiles").update(update).eq("id", body.profile_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "set_active": {
        const active = Boolean(body.active);
        const { error } = await admin
          .from("profiles").update({ active }).eq("id", body.profile_id);
        if (error) return json({ error: error.message }, 400);
        // also block/unblock the login itself
        await admin.auth.admin.updateUserById(body.profile_id, {
          ban_duration: active ? "none" : "876000h",
        });
        return json({ ok: true });
      }

      case "clear_device": {
        const { error } = await admin
          .from("profiles").update({ device_id: null }).eq("id", body.profile_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "delete_worker": {
        // FK constraints stop this if the worker has attendance rows —
        // that is intentional (use set_active for real ex-staff).
        const { error } = await admin.auth.admin.deleteUser(body.profile_id);
        if (error) {
          return json({
            error: "Cannot delete: this worker already has attendance history. Deactivate instead.",
          }, 400);
        }
        return json({ ok: true });
      }

      default:
        return json({ error: `unknown action: ${body.action}` }, 400);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("staff-admin error:", e);
    return json({ error: "internal error" }, 500);
  }
});
