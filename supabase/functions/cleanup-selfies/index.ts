// Deletes check-in photos once they are older than the retention
// window (app_settings.selfie_retention_days, default 2).
//
// The photo exists for one purpose: to settle "was this person actually
// at the shop?" when the GPS radius is in doubt. That question is asked
// within a day or two, so the image has no reason to outlive it. The
// SHA-256 and every punch detail stay in attendance_app forever, so the
// audit trail survives the picture.
//
// Deletion is by FILE AGE, not by folder. An earlier version removed
// whole "yyyy-mm" month folders once the month fell out of the window,
// which can never express a 2-day rule — inside the current month it
// deleted nothing at all.
//
// Path convention: selfies/{worker_uid}/{yyyy-mm}/{timestamp}.jpg
// Schedule: daily via pg_cron + pg_net, or POST with x-adms-secret.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SHARED_SECRET = Deno.env.get("ADMS_SHARED_SECRET") ?? "";
const PAGE = 1000;

/** every file under a prefix, paged so a busy month is not truncated */
async function listAll(prefix: string) {
  const out: { name: string; created_at?: string }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from("selfies").list(prefix, { limit: PAGE, offset });
    if (error || !data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** a file's age: prefer storage's own timestamp, fall back to the name */
function takenAt(f: { name: string; created_at?: string }): number | null {
  if (f.created_at) {
    const t = Date.parse(f.created_at);
    if (!Number.isNaN(t)) return t;
  }
  const stamp = Number(f.name.split(".")[0]);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

Deno.serve(async (req) => {
  if (!SHARED_SECRET || req.headers.get("x-adms-secret") !== SHARED_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const { data: setting } = await supabase
    .from("app_settings").select("value").eq("key", "selfie_retention_days").maybeSingle();

  // A negative or missing value once meant "sweep everything" during a
  // one-off cleanup. Never honour that on a schedule: clamp to at least
  // one day so a stray setting cannot wipe today's evidence.
  const days = Math.max(1, Number(setting?.value ?? 2) || 2);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;

  let deleted = 0;
  let kept = 0;
  const doomed: string[] = [];

  const workers = await listAll("");
  for (const w of workers) {
    for (const m of await listAll(w.name)) {
      if (!/^\d{4}-\d{2}$/.test(m.name)) continue;
      const prefix = `${w.name}/${m.name}`;
      for (const f of await listAll(prefix)) {
        const at = takenAt(f);
        // unreadable age: leave it alone rather than guess and delete
        if (at === null) { kept++; continue; }
        if (at < cutoff) doomed.push(`${prefix}/${f.name}`); else kept++;
      }
    }
  }

  for (let i = 0; i < doomed.length; i += 100) {
    const batch = doomed.slice(i, i + 100);
    const { error } = await supabase.storage.from("selfies").remove(batch);
    if (!error) deleted += batch.length;
  }

  return new Response(
    JSON.stringify({ ok: true, deleted, kept, retention_days: days }),
    { headers: { "content-type": "application/json" } },
  );
});
