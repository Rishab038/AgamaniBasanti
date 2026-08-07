// Offline queue: check-ins are ALWAYS written here first, then
// synced. If the shop internet is down, rows wait and drain later
// with synced_late=true — that is the delayed-sync audit trail.
//
// Three bugs lived here and all three showed up on one worker's screen
// as "5 check-ins saved" next to four identical check-ins:
//
//  1. drain() had no lock, and is called from three places — on mount,
//     on every return to the foreground, and straight after a punch.
//     Two overlapping runs each read the same undeleted rows and each
//     pushed them, so one punch landed several times.
//
//  2. drain() stopped at the FIRST failure on the assumption that a
//     failure means no signal. A row the server will never accept
//     therefore blocked every row behind it, for good. The banner kept
//     saying "will send when internet returns" on a phone with full
//     bars, and each new punch made the count climb.
//
//  3. Everything that went through here was stamped synced_late, even a
//     punch that reached the server a second after it was made — the
//     queue is the normal path, not the exception. Every one of the 859
//     punches in the last week claimed to be a delayed sync, which made
//     the flag worthless for spotting the ones that really were.

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

// Older installs predate this column. `add column` throws when it is
// already there, which is the cheapest way to ask.
try {
  db.execSync("alter table pending_checkins add column attempts integer not null default 0");
} catch {
  // already migrated
}

/** How many times a row is pushed before we stop letting it hold up the queue. */
const MAX_ATTEMPTS = 5;
/** Younger than this and the punch did not really "wait" for a network. */
const LATE_AFTER_SECONDS = 15;

export type CheckinRow = {
  profile_id: string;
  branch_id: string;
  direction: "IN" | "OUT";
  punch_kind: "ARRIVAL" | "LUNCH_OUT" | "LUNCH_IN" | "DEPARTURE";
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

/** Queue a punch. Returns its local id so the caller can ask whether it landed. */
export function enqueue(row: CheckinRow, selfieBase64: string | null): number {
  db.runSync(
    "insert into pending_checkins (row_json, selfie_base64, selfie_path) values (?, ?, ?)",
    [JSON.stringify(row), selfieBase64, row.selfie_path],
  );
  const r = db.getFirstSync<{ id: number }>("select last_insert_rowid() as id");
  return r?.id ?? 0;
}

/** Punches still waiting on a network — what the worker is told about. */
export function pendingCount(): number {
  const r = db.getFirstSync<{ n: number }>(
    "select count(*) as n from pending_checkins where attempts < ?",
    [MAX_ATTEMPTS],
  );
  return r?.n ?? 0;
}

/** Punches the server kept refusing. Kept, but no longer blocking anything. */
export function stuckCount(): number {
  const r = db.getFirstSync<{ n: number }>(
    "select count(*) as n from pending_checkins where attempts >= ?",
    [MAX_ATTEMPTS],
  );
  return r?.n ?? 0;
}

/** Is a specific queued punch still unsent? */
export function isPending(id: number): boolean {
  const r = db.getFirstSync<{ n: number }>(
    "select count(*) as n from pending_checkins where id = ?",
    [id],
  );
  return (r?.n ?? 0) > 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); // Hermes provides atob globally
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type SyncError = { code?: string; message?: string };

/** The server already has this punch — the row is done, not failed. */
const isDuplicate = (e: SyncError) =>
  e?.code === "23505" || /duplicate key|already exists/i.test(e?.message ?? "");

/** No signal. Worth stopping for; every other row will fail the same way. */
const isOffline = (e: SyncError) =>
  !e?.code && /network|fetch|timeout|connection/i.test(e?.message ?? "");

/** Push one queued row. Throws so the caller can classify the failure. */
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
    if (upErr && !/exist|duplicate/i.test(`${upErr.message}`)) throw upErr;
  }

  const { error } = await supabase.from("attendance_app").insert(row);
  if (error) throw error;

  db.runSync("delete from pending_checkins where id = ?", [item.id]);
}

/** Only one drain at a time, however many callers ask. */
let draining = false;

/**
 * Try to push everything in the queue. Returns how many synced.
 * Called on app start, on return to the foreground, and after a punch.
 */
export async function drain(): Promise<number> {
  // A second caller must not read the same rows a running one is still
  // working through — that is what produced the duplicate punches.
  if (draining) return 0;
  draining = true;

  try {
    const items = db.getAllSync<{
      id: number;
      row_json: string;
      selfie_base64: string | null;
      selfie_path: string | null;
      attempts: number;
      age_s: number;
    }>(
      `select *, (julianday('now') - julianday(created_at)) * 86400 as age_s
         from pending_checkins
        where attempts < ?
        order by id`,
      [MAX_ATTEMPTS],
    );

    let synced = 0;
    for (const item of items) {
      const row: CheckinRow = JSON.parse(item.row_json);
      // Only a punch that actually sat here waiting is a delayed sync.
      // Stamping every row made the flag meaningless.
      row.synced_late = item.age_s > LATE_AFTER_SECONDS;

      try {
        await syncOne({ ...item, row_json: JSON.stringify(row) });
        synced++;
      } catch (e) {
        const err = e as SyncError;

        if (isDuplicate(err)) {
          // Already on the server from an earlier overlapping run.
          // Dropping it is the right answer, not a failure.
          db.runSync("delete from pending_checkins where id = ?", [item.id]);
          continue;
        }

        db.runSync(
          "update pending_checkins set attempts = attempts + 1 where id = ?",
          [item.id],
        );

        // No signal means every remaining row fails the same way, so
        // stop. Anything else is this row's own problem — step over it
        // rather than let it hold up the punches behind it.
        if (isOffline(err)) break;
      }
    }
    return synced;
  } finally {
    draining = false;
  }
}
