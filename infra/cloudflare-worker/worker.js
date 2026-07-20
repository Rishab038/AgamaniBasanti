// SUPERSEDED — the live proxy is now a Cloudflare Pages Function at
// apps/admin/functions/iclock/[[path]].js, serving on the dashboard's
// existing domain (agamani-admin.pages.dev). That avoids having to
// register a workers.dev subdomain, which this file required.
// Kept only for the case where a separate custom domain is needed
// (e.g. a device that refuses HTTPS).
//
// ADMS proxy — free Cloudflare Worker.
//
// Why this exists: ADMS fingerprint machines only let you configure
// a host + port; they hardcode the request path to /iclock/*.
// Supabase edge functions live under /functions/v1/<name>/, so the
// device can't reach them directly. This worker sits at the root of
// a workers.dev subdomain (or custom domain), forwards /iclock/* to
// the adms function, and injects the shared-secret header so the
// secret never has to be typed into the machine.
//
// Deploy:  cd infra/cloudflare-worker && npx wrangler deploy
// Secrets: npx wrangler secret put ADMS_SHARED_SECRET
// Vars:    set SUPABASE_FUNCTION_URL in wrangler.toml
//
// If the delivered machine only speaks plain HTTP and refuses the
// workers.dev HTTPS redirect, attach this worker to a custom domain
// on Cloudflare and set SSL mode to allow HTTP on that hostname —
// or fall back to bridge/pyzk_bridge.py (no inbound URL needed).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/iclock/")) {
      return new Response("not found", { status: 404 });
    }

    const target =
      env.SUPABASE_FUNCTION_URL.replace(/\/$/, "") +
      url.pathname +
      url.search;

    const headers = new Headers(request.headers);
    headers.set("x-adms-secret", env.ADMS_SHARED_SECRET);

    return fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });
  },
};
