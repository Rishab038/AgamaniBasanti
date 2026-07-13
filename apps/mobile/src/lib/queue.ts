// Offline queue: check-ins are ALWAYS written here first, then
// synced. If the shop internet is down, rows wait and drain later
// with synced_late=true — that is the delayed-sync audit trail.

import * as SQLite from "expo-sqlite";
import { supabase } from "./supabase";

const db = SQLite.openDatabaseSync("agamani.db");

db.execSync(`
  create table if not exists pending_checkins (
    id integer primary key autoincrement,
    row_json text not null,
    selfie_base64 text,
    selfie_path text,
    created_at text not null default (datetime('now'))
  );
`);

export type CheckinRow = {
  profile_id: string;
  branch_id: string;
  direction: "IN" | "OUT";
  client_ts: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  wifi_ssid: string | null;
  device_id: string;
  selfie_path: string | null;
  selfie_sha256: string | null;
  flag: "CLEAN" | "SUSPECT";
  flag_reasons: string[];
  synced_late: boolean;
};

export function enqueue(row: CheckinRow, selfieBase64: string | null): void {
  db.runSync(
    "insert into pending_checkins (row_json, selfie_base64, selfie_path) values (?, ?, ?)",
    [JSON.stringify(row), selfieBase64, row.selfie_path],
  );
}

export function pendingCount(): number {
  const r = db.getFirstSync<{ n: number }>(
    "select count(*) as n from pending_checkins",
  );
  return r?.n ?? 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); // Hermes provides atob globally
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Push one queued row to Supabase. Throws on failure so drain() stops. */
async function syncOne(item: {
  id: number;
  row_json: string;
  selfie_base64: string | null;
  selfie_path: string | null;
}): Promise<void> {
  const row: CheckinRow = JSON.parse(item.row_json);

  if (item.selfie_base64 && item.selfie_path) {
    const { error: upErr } = await supabase.storage
      .from("selfies")
      .upload(item.selfie_path, base64ToBytes(item.selfie_base64).buffer as ArrayBuffer, {
        contentType: "image/jpeg",
        upsert: false,
      });
    // an already-uploaded selfie from a half-synced attempt is fine
    if (upErr && !`${upErr.message}`.toLowerCase().includes("exist")) {
      throw upErr;
    }
  }

  const { error } = await supabase.from("attendance_app").insert(row);
  if (error) throw error;

  db.runSync("delete from pending_checkins where id = ?", [item.id]);
}

/**
 * Try to push everything in the queue. Returns how many synced.
 * Call on app start, on network regain, and after each check-in.
 */
export async function drain(): Promise<number> {
  const items = db.getAllSync<{
    id: number;
    row_json: string;
    selfie_base64: string | null;
    selfie_path: string | null;
    created_at: string;
  }>("select * from pending_checkins order by id");

  let synced = 0;
  for (const item of items) {
    const row: CheckinRow = JSON.parse(item.row_json);
    // anything that waited in the queue is a delayed sync
    row.synced_late = true;
    try {
      await syncOne({ ...item, row_json: JSON.stringify(row) });
      synced++;
    } catch {
      break; // still offline — retry on the next drain
    }
  }
  return synced;
}
