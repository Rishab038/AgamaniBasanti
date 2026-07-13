// Deletes selfies older than the retention period (app_settings.
// selfie_retention_days, default 90). The SHA-256 hash and all
// punch metadata stay in attendance_app forever — only the image
// bytes are removed, keeping storage inside the free tier.
//
// Path convention: selfies/{worker_uid}/{yyyy-mm}/{timestamp}.jpg
// We delete whole month folders older than the retention window.
//
// Schedule monthly via pg_cron + pg_net, or call it from a GitHub
// Action: POST with header x-adms-secret: $ADMS_SHARED_SECRET

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SHARED_SECRET = Deno.env.get("ADMS_SHARED_SECRET") ?? "";

Deno.serve(async (req) => {
  if (!SHARED_SECRET || req.headers.get("x-adms-secret") !== SHARED_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const { data: setting } = await supabase
    .from("app_settings").select("value").eq("key", "selfie_retention_days").maybeSingle();
  const retentionDays = Number(setting?.value ?? 90);

  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;

  let deleted = 0;

  // top level = one folder per worker uid
  const { data: workers, error } = await supabase.storage.from("selfies").list("");
  if (error) return new Response(error.message, { status: 500 });

  for (const w of workers ?? []) {
    const { data: months } = await supabase.storage.from("selfies").list(w.name);
    for (const m of months ?? []) {
      // month folders sort lexicographically: "2026-03" < "2026-07"
      if (!/^\d{4}-\d{2}$/.test(m.name) || m.name >= cutoffMonth) continue;

      const prefix = `${w.name}/${m.name}`;
      const { data: files } = await supabase.storage
        .from("selfies").list(prefix, { limit: 1000 });
      const paths = (files ?? []).map((f) => `${prefix}/${f.name}`);
      if (paths.length > 0) {
        const { error: delErr } = await supabase.storage.from("selfies").remove(paths);
        if (!delErr) deleted += paths.length;
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, deleted, cutoffMonth }), {
    headers: { "content-type": "application/json" },
  });
});
