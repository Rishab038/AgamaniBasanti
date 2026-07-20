// ADMS proxy, hosted as a Cloudflare Pages Function.
//
// Why it lives here: ADMS fingerprint machines let you configure a
// HOST but hardcode the request path to /iclock/*. Supabase edge
// functions live under /functions/v1/<name>/, so the device cannot
// reach them directly. This function sits on the dashboard's own
// domain (already deployed, already HTTPS) and forwards
//     https://agamani-admin.pages.dev/iclock/*
// to the Supabase adms function, injecting the shared secret so it
// never has to be typed into the machine's keypad.
//
// This replaces the standalone Worker in infra/cloudflare-worker,
// which needed a workers.dev subdomain to be registered first.
//
// Secret is set with:
//   npx wrangler pages secret put ADMS_SHARED_SECRET --project-name agamani-admin

const SUPABASE_ADMS = "https://zhekzbooxkuosolubdjd.supabase.co/functions/v1/adms";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.ADMS_SHARED_SECRET) {
    return new Response("proxy not configured", { status: 500 });
  }

  const target = SUPABASE_ADMS + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.set("x-adms-secret", env.ADMS_SHARED_SECRET);
  // strip hop-by-hop / origin headers that confuse the upstream
  headers.delete("host");
  headers.delete("cf-connecting-ip");

  return fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
}
