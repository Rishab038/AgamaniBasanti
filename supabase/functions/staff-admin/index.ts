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
//                   employee_code?, shift_id?, base_salary?, joined_on?, role?,
//                   employment_type?, shift_start?, shift_end?,
//                   salary_basic?, salary_hra?, salary_conveyance?,
//                   salary_washing?  -- PF components; base_salary is their sum }
//   create_admin  { email, password, full_name, role: owner|supervisor }
//                 -- managers sign in to the dashboard with a real email
//                    address, unlike workers who use phone + PIN
//   set_password   { profile_id, new_password }
//                  -- 6 digits for workers, 8+ chars for managers
//   change_phone   { profile_id, new_phone } -- staff changed their number
//   set_active     { profile_id, active }
//   clear_device   { profile_id }            -- allow login from a new phone
//   delete_account { profile_id, force? }
//                  -- refuses: deleting yourself, or the last owner.
//                     History (attendance, advances, payslips) blocks a
//                     plain delete and returns 409 needs_force; force
//                     erases that history first, then the login.
//   delete_impact  { profile_id }
//                  -- counts of what a forced delete would destroy

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

  // PF staff are paid off the statutory components, not a single figure:
  // PF is 12% of Basic and ESI 0.75% of gross, so the split has to be
  // stored, and base_salary is their sum. For everyone else the
  // components stay zero and base_salary is the monthly figure.
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const TYPES = ["NORMAL", "CONTRACT", "PF", "NO_PAY_NO_WORK"];
  const rawType = String(input.employment_type ?? "").toUpperCase();
  const employmentType = TYPES.includes(rawType) ? rawType : null;
  const isPf = employmentType === "PF";
  const parts = {
    salary_basic: isPf ? num(input.salary_basic) : 0,
    salary_hra: isPf ? num(input.salary_hra) : 0,
    salary_conveyance: isPf ? num(input.salary_conveyance) : 0,
    salary_washing: isPf ? num(input.salary_washing) : 0,
  };
  const componentTotal =
    parts.salary_basic + parts.salary_hra + parts.salary_conveyance + parts.salary_washing;

  const { error: profErr } = await admin.from("profiles").insert({
    id: created.user.id,
    employee_code: code,
    full_name: input.full_name,
    role: input.role === "supervisor" ? "supervisor" : "worker",
    branch_id: input.branch_id,
    shift_id: input.shift_id ?? null,
    phone,
    employment_type: employmentType,
    ...parts,
    base_salary: isPf ? componentTotal : num(input.base_salary),
    joined_on: input.joined_on ?? null,
    device_enroll_no: Number.isInteger(enroll) && enroll > 0 ? enroll : null,
    shift_start: input.shift_start || null,
    shift_end: input.shift_end || null,
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
    const callerId = await requireOwner(req);
    const body = await req.json();

    switch (body.action) {
      case "create_worker": {
        const r = await createOneWorker(body);
        if (!r.ok) return json({ error: r.error }, 400);
        return json(r);
      }

      case "create_admin": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const password = String(body.password ?? "");
        const fullName = String(body.full_name ?? "").trim();
        const role = body.role === "supervisor" ? "supervisor" : "owner";

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: "Enter a valid email address" }, 400);
        }
        if (password.length < 8) {
          return json({ error: "Password must be at least 8 characters" }, 400);
        }
        if (fullName.length < 2) {
          return json({ error: "Enter their full name" }, 400);
        }

        const { data: branch } = await admin
          .from("branches").select("id").limit(1).single();
        if (!branch) return json({ error: "No shop configured yet" }, 400);

        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // no verification mail; the owner vouches for them
        });
        if (createErr) {
          return json({
            error: createErr.message.includes("already")
              ? "An account with this email already exists"
              : createErr.message,
          }, 400);
        }

        const { error: profErr } = await admin.from("profiles").insert({
          id: created.user.id,
          employee_code: role === "owner" ? "OWNER" + Date.now().toString().slice(-3) : await nextEmployeeCode(),
          full_name: fullName,
          role,
          branch_id: branch.id,
          base_salary: 0,
          active: true,
          approved_at: new Date().toISOString(),
        });
        if (profErr) {
          await admin.auth.admin.deleteUser(created.user.id);
          return json({ error: profErr.message }, 400);
        }
        return json({ ok: true, email, role });
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

      case "set_password": {
        const pw = String(body.new_password ?? "");
        const { data: target } = await admin
          .from("profiles").select("role").eq("id", body.profile_id).maybeSingle();
        if (!target) return json({ error: "Account not found" }, 404);

        // workers type a 6-digit PIN on a phone keypad; managers sign in
        // to the dashboard with a real password
        if (target.role === "worker") {
          if (!/^\d{6}$/.test(pw)) return json({ error: "PIN must be exactly 6 digits" }, 400);
        } else if (pw.length < 8) {
          return json({ error: "Password must be at least 8 characters" }, 400);
        }

        const { error } = await admin.auth.admin.updateUserById(body.profile_id, {
          password: pw,
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

      case "delete_account": {
        // Guard 1: never delete the session you are signed in with.
        if (body.profile_id === callerId) {
          return json({
            error: "You cannot delete your own login. Ask another owner to remove it.",
          }, 400);
        }

        const { data: target } = await admin
          .from("profiles").select("role, full_name").eq("id", body.profile_id).maybeSingle();
        if (!target) return json({ error: "Account not found" }, 404);

        // Guard 2: the shop must always keep at least one way in.
        if (target.role === "owner") {
          const { count } = await admin
            .from("profiles").select("id", { count: "exact", head: true }).eq("role", "owner");
          if ((count ?? 0) <= 1) {
            return json({
              error: "This is the only owner account — deleting it would lock everyone out. Create another owner first.",
            }, 400);
          }
        }

        // Every table below points at profiles with ON DELETE NO ACTION,
        // so history physically blocks the delete. The owner can now
        // choose to erase it anyway (force), which is why the dashboard
        // shows the exact counts before asking.
        const pid = body.profile_id as string;
        const { error: plainErr } = await admin.auth.admin.deleteUser(pid);
        if (!plainErr) return json({ ok: true, erased: null });

        if (!body.force) {
          return json({
            error: `${target.full_name} has attendance history that payroll records depend on. ` +
              `Deactivate them, or choose "Delete permanently" to erase the history too.`,
            needs_force: true,
          }, 409);
        }

        // Ordered child-first so no foreign key is ever left dangling.
        // Columns naming this person as the ACTOR on someone else's row
        // (who approved a day, who decided an advance) are nulled rather
        // than deleted — that is another worker's record, not theirs.
        const erased: Record<string, number> = {};
        const wipe = async (table: string, column: string) => {
          const { count } = await admin
            .from(table).delete({ count: "exact" }).eq(column, pid);
          if (count) erased[table] = count;
        };
        const detach = async (table: string, column: string) => {
          await admin.from(table).update({ [column]: null }).eq(column, pid);
        };

        await detach("attendance_days", "approved_by");
        await detach("advances", "decided_by");
        await detach("leave_requests", "decided_by");
        await detach("payroll_runs", "created_by");

        await wipe("notifications", "profile_id");
        await wipe("attendance_app", "profile_id");
        await wipe("attendance_days", "profile_id");
        await wipe("advances", "profile_id");
        await wipe("leave_requests", "profile_id");
        await wipe("payslips", "profile_id");

        const { error: forcedErr } = await admin.auth.admin.deleteUser(pid);
        if (forcedErr) {
          return json({
            error: `Could not delete ${target.full_name}: ${forcedErr.message}`,
          }, 400);
        }
        return json({ ok: true, erased });
      }

      // Counts of everything a delete would destroy, so the dashboard can
      // show the owner what they are about to lose before they confirm.
      case "delete_impact": {
        const pid = body.profile_id as string;
        const countOf = async (table: string) => {
          const { count } = await admin
            .from(table).select("id", { count: "exact", head: true }).eq("profile_id", pid);
          return count ?? 0;
        };
        const [attendance, punches, advances, payslips, notifications] = await Promise.all([
          countOf("attendance_days"),
          countOf("attendance_app"),
          countOf("advances"),
          countOf("payslips"),
          countOf("notifications"),
        ]);

        // A payslip inside a CONFIRMED run is a frozen salary record —
        // worth naming separately, because that is the one thing here
        // that cannot be reconstructed from the machine or the app.
        const { count: frozen } = await admin
          .from("payslips")
          .select("id, payroll_runs!inner(status)", { count: "exact", head: true })
          .eq("profile_id", pid)
          .eq("payroll_runs.status", "CONFIRMED");

        return json({
          ok: true,
          attendance, punches, advances, payslips, notifications,
          confirmed_payslips: frozen ?? 0,
        });
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
