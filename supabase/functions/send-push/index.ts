// Delivers queued notifications to phones via Expo's push service.
//
// The database decides WHAT to say and to whom (fn_queue_shift_reminders
// and the advance trigger); this only carries the messages out. Rows
// are marked sent_push before delivery is attempted so a slow response
// or a retry cannot double-send.
//
// Called every few minutes by pg_cron via pg_net, or manually with the
// shared secret header.

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SECRET = Deno.env.get("ADMS_SHARED_SECRET") ?? "";
const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";

type Row = {
  id: string;
  profile_id: string;
  title: string;
  body: string;
  profiles: { push_token: string | null } | null;
};

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-adms-secret") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Only deliver what is still worth saying. These messages are
  // time-critical ("your shift starts soon", "you have not checked in"),
  // so one that has been sitting in the queue for hours is not merely
  // useless, it is misleading. Anything older than the window stays in
  // the table — the worker still sees it in the app's list — but is not
  // pushed. This also stops a backlog from arriving in one burst the
  // first time a phone registers a token.
  const MAX_AGE_MINUTES = 60;
  const freshSince = new Date(Date.now() - MAX_AGE_MINUTES * 60_000).toISOString();

  const { data, error } = await admin
    .from("notifications")
    .select("id, profile_id, title, body, profiles!inner(push_token)")
    .eq("sent_push", false)
    .gte("created_at", freshSince)
    .not("profiles.push_token", "is", null)
    .limit(100);

  if (error) return new Response(error.message, { status: 500 });
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }

  // mark first: a duplicate notification is worse than a missed one,
  // because these tell people whether they are late
  await admin
    .from("notifications")
    .update({ sent_push: true })
    .in("id", rows.map((r) => r.id));

  const messages = rows.map((r) => ({
    to: r.profiles!.push_token,
    sound: "default",
    title: r.title,
    body: r.body,
    priority: "high",
  }));

  let delivered = 0;
  try {
    const res = await fetch(EXPO_PUSH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messages),
    });
    const out = await res.json();
    delivered = Array.isArray(out?.data)
      ? out.data.filter((d: { status?: string }) => d.status === "ok").length
      : 0;
  } catch (e) {
    console.error("expo push failed:", e);
  }

  return new Response(JSON.stringify({ queued: rows.length, delivered }), {
    headers: { "content-type": "application/json" },
  });
});
