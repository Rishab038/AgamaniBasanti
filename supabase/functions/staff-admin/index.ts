// Owner-only staff administration. Creating/updating login accounts
// requires the service-role key, which must never reach a browser —
// so the dashboard calls this function instead. Every action
// re-verifies that the caller's JWT belongs to a profile with
// role = 'owner'.
//
// Actions (POST JSON { action, ...params }):
//   create_worker { employee_code, full_name, pin, branch_id,
//                   shift_id?, base_salary?, phone?, joined_on?, role? }
//   reset_pin     { profile_id, new_pin }
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

const codeToEmail = (code: string) =>
  `${code.trim().toLowerCase()}@staff.agamani.app`;

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
        const code = String(body.employee_code ?? "").trim().toUpperCase();
        const pin = String(body.pin ?? "");
        if (!/^[A-Z0-9]{2,12}$/.test(code)) {
          return json({ error: "Employee code must be 2-12 letters/numbers, e.g. W02" }, 400);
        }
        if (!/^\d{6}$/.test(pin)) {
          return json({ error: "PIN must be exactly 6 digits" }, 400);
        }
        if (!body.full_name || !body.branch_id) {
          return json({ error: "Name and branch are required" }, 400);
        }

        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email: codeToEmail(code),
          password: pin,
          email_confirm: true,
        });
        if (createErr) {
          const msg = createErr.message.includes("already")
            ? `Employee code ${code} is already in use`
            : createErr.message;
          return json({ error: msg }, 400);
        }

        const { error: profErr } = await admin.from("profiles").insert({
          id: created.user.id,
          employee_code: code,
          full_name: body.full_name,
          role: body.role === "supervisor" ? "supervisor" : "worker",
          branch_id: body.branch_id,
          shift_id: body.shift_id ?? null,
          phone: body.phone ?? null,
          base_salary: body.base_salary ?? 0,
          joined_on: body.joined_on ?? null,
        });
        if (profErr) {
          // roll back the orphaned login
          await admin.auth.admin.deleteUser(created.user.id);
          return json({ error: profErr.message }, 400);
        }
        return json({ ok: true, profile_id: created.user.id, employee_code: code });
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
