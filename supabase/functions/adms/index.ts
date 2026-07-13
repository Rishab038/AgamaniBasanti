// ============================================================
// ADMS / iclock receiver — the fingerprint machine's cloud door.
//
// Two ways punches arrive here:
//  1. ADMS "cloud push" devices (eSSL/ZKTeco) POST plain-text
//     ATTLOG lines to /iclock/cdata. Devices hardcode the /iclock
//     path, so in production a tiny Cloudflare Worker proxy
//     (infra/cloudflare-worker) forwards /iclock/* to this
//     function and injects the shared secret header.
//  2. The pyzk LAN bridge (bridge/pyzk_bridge.py) POSTs JSON to
//     /bridge with the same secret header.
//
// Security: x-adms-secret header must match ADMS_SHARED_SECRET,
// AND the reported serial number must exist in the devices table.
// Dedup is enforced by the DB unique index
// (device_serial, enroll_no, punched_at) — re-pushes are no-ops.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SHARED_SECRET = Deno.env.get("ADMS_SHARED_SECRET") ?? "";

// Device clocks are set to local Indian time; convert to UTC instant.
const IST_OFFSET = "+05:30";

function deviceTimeToIso(local: string): string | null {
  // "2026-07-14 10:01:23" -> "2026-07-14T10:01:23+05:30"
  const m = local.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}T${m[2]}${IST_OFFSET}` : null;
}

type Punch = {
  device_serial: string;
  enroll_no: number;
  punched_at: string;
  status_code: number | null;
  verify_code: number | null;
  raw: string | null;
};

async function knownDevice(serial: string): Promise<boolean> {
  const { data } = await supabase
    .from("devices").select("id").eq("serial", serial).maybeSingle();
  return data !== null;
}

async function touchHeartbeat(serial: string) {
  await supabase
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("serial", serial);
}

async function insertPunches(punches: Punch[]): Promise<number> {
  if (punches.length === 0) return 0;
  const { error, count } = await supabase
    .from("device_punches")
    .upsert(punches, {
      onConflict: "device_serial,enroll_no,punched_at",
      ignoreDuplicates: true,
      count: "exact",
    });
  if (error) throw new Error(`insert failed: ${error.message}`);
  return count ?? punches.length;
}

// ATTLOG line: "<enroll>\t<yyyy-mm-dd hh:mm:ss>\t<status>\t<verify>[\t...]"
function parseAttlog(body: string, serial: string): Punch[] {
  const punches: Punch[] = [];
  for (const line of body.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 2) continue;
    const enroll = parseInt(parts[0], 10);
    const iso = deviceTimeToIso(parts[1]);
    if (isNaN(enroll) || !iso) continue;
    punches.push({
      device_serial: serial,
      enroll_no: enroll,
      punched_at: iso,
      status_code: parts[2] !== undefined ? parseInt(parts[2], 10) || 0 : null,
      verify_code: parts[3] !== undefined ? parseInt(parts[3], 10) || 0 : null,
      raw: line.trim(),
    });
  }
  return punches;
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname; // e.g. /adms/iclock/cdata (function name prefix included)

  // --- auth: shared secret on every route ---
  if (!SHARED_SECRET || req.headers.get("x-adms-secret") !== SHARED_SECRET) {
    return text("forbidden", 403);
  }

  try {
    // ---------- JSON ingestion from the pyzk bridge ----------
    if (path.endsWith("/bridge") && req.method === "POST") {
      const { serial, punches } = await req.json() as {
        serial: string;
        punches: { enroll_no: number; ts: string; status?: number; verify?: number }[];
      };
      if (!await knownDevice(serial)) return text("unknown device serial", 403);

      const rows: Punch[] = punches
        .map((p) => ({
          device_serial: serial,
          enroll_no: p.enroll_no,
          punched_at: deviceTimeToIso(p.ts) ?? p.ts, // bridge may send ISO already
          status_code: p.status ?? null,
          verify_code: p.verify ?? null,
          raw: null,
        }))
        .filter((p) => p.punched_at !== null);

      const n = await insertPunches(rows);
      await touchHeartbeat(serial);
      return new Response(JSON.stringify({ ok: true, received: n }), {
        headers: { "content-type": "application/json" },
      });
    }

    // ---------- ADMS iclock protocol ----------
    const sn = url.searchParams.get("SN") ?? "";
    if (path.includes("/iclock/")) {
      if (!sn || !await knownDevice(sn)) return text("unknown device serial", 403);
      await touchHeartbeat(sn);

      // Handshake: device asks for its options on boot / interval
      if (path.endsWith("/iclock/cdata") && req.method === "GET") {
        // TimeZone value format varies by firmware — verify on the
        // real device (some want 5.5, some want minutes = 330).
        return text(
          [
            `GET OPTION FROM: ${sn}`,
            "ATTLOGStamp=None",
            "OPERLOGStamp=9999",
            "ATTPHOTOStamp=None",
            "ErrorDelay=30",
            "Delay=10",
            "TransTimes=00:00;12:00",
            "TransInterval=1",
            "TransFlag=TransData AttLog",
            "TimeZone=5.5",
            "Realtime=1",
            "Encrypt=None",
          ].join("\n"),
        );
      }

      // Data push: attendance logs (and other tables we ignore)
      if (path.endsWith("/iclock/cdata") && req.method === "POST") {
        const table = url.searchParams.get("table") ?? "";
        const body = await req.text();
        if (table === "ATTLOG") {
          const n = await insertPunches(parseAttlog(body, sn));
          return text(`OK: ${n}`);
        }
        // OPERLOG / ATTPHOTO / options — acknowledge and discard
        return text("OK: 0");
      }

      // Command poll — we never queue commands to the device
      if (path.endsWith("/iclock/getrequest")) {
        return text("OK");
      }

      // Some firmwares ping /iclock/ping or /iclock/devicecmd
      return text("OK");
    }

    return text("not found", 404);
  } catch (e) {
    console.error("adms error:", e);
    return text("error", 500);
  }
});
