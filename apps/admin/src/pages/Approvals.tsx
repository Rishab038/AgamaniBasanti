// Approvals — every advance request in one queue, with running
// balances so the owner always knows the exposure before saying yes.
// (Leave requests join this queue in a later phase.)

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useBranch } from "../lib/branch";
import { titleCase } from "../lib/text";

type Advance = {
  id: string;
  profile_id: string;
  amount: number;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  decided_at: string | null;
  recorded_by: string | null;
  profiles: { full_name: string; employee_code: string } | null;
  /** whoever filed it — differs from profiles when the counter logged it */
  recorder: { full_name: string } | null;
};

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const fmtDate = (ts: string) =>
  new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export default function Approvals() {
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [pendingAction, setPendingAction] = useState<{ id: string; approve: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { branchId } = useBranch();

  const load = async () => {
    const [adv, bal] = await Promise.all([
      supabase
        .from("advances")
        // advances has two FKs to profiles (requester + decider) —
        // PostgREST must be told this join means the requester
        .select(
          "id, profile_id, amount, reason, status, created_at, decided_at, recorded_by, profiles!advances_profile_id_fkey!inner(full_name, employee_code, branch_id), recorder:profiles!advances_recorded_by_fkey(full_name)",
        )
        .eq("profiles.branch_id", branchId ?? "")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase.from("advance_balances").select("profile_id, balance"),
    ]);
    if (adv.error) setError(adv.error.message);
    setAdvances((adv.data as unknown as Advance[]) ?? []);
    const b: Record<string, number> = {};
    for (const r of bal.data ?? []) b[r.profile_id] = (b[r.profile_id] ?? 0) + Number(r.balance);
    setBalances(b);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const decide = async (a: Advance, approve: boolean) => {
    setPendingAction(null);
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase
      .from("advances")
      .update({
        status: approve ? "APPROVED" : "REJECTED",
        decided_by: me.user?.id,
        decided_at: new Date().toISOString(),
      })
      .eq("id", a.id);
    if (err) setError(err.message);
    else await load();
  };

  const pending = advances.filter((a) => a.status === "PENDING");
  const decided = advances.filter((a) => a.status !== "PENDING");

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
            {pending.length === 0 ? "Advance requests" : `${pending.length} waiting on you`}
          </div>
          <h1>Approvals</h1>
          <p>Say yes or no — the app tells them instantly.</p>
        </div>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <div className="split">
        <div className="split-main">
      {pending.length === 0 && (
        <div className="card">
          <span className="muted">Nothing waiting for you right now.</span>
        </div>
      )}

      {pending.map((a) => (
        <div className="approval-card" key={a.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="head">
              <span className="amount">{rupees(a.amount)}</span>
              <span className="who">
                {titleCase(a.profiles?.full_name ?? "")}
                {a.recorded_by && a.recorded_by !== a.profile_id ? " · took it" : " · asked"}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>{fmtDate(a.created_at)}</span>
            </div>
            {/* Who wrote it down matters only when it was not the person
                who took the money — then it is the whole provenance. */}
            {a.recorded_by && a.recorded_by !== a.profile_id && (
              <div className="logged-by">
                logged at the counter by {titleCase(a.recorder?.full_name ?? "—")}
              </div>
            )}
            <div className="why">
              {a.reason ? `${a.reason} · ` : ""}
              current balance: {rupees(balances[a.profile_id] ?? 0)} → after:{" "}
              {rupees((balances[a.profile_id] ?? 0) + Number(a.amount))}
            </div>
          </div>
          <div className="acts">
            {pendingAction?.id === a.id ? (
              <>
                <button
                  className={pendingAction.approve ? "btn good" : "btn danger"}
                  onClick={() => decide(a, pendingAction.approve)}
                >
                  Confirm {pendingAction.approve ? "approve" : "reject"}?
                </button>
                <button className="btn" onClick={() => setPendingAction(null)}>Cancel</button>
              </>
            ) : (
              <>
                <button className="btn good" onClick={() => setPendingAction({ id: a.id, approve: true })}>
                  Approve
                </button>
                <button className="btn soft" onClick={() => setPendingAction({ id: a.id, approve: false })}>
                  Reject
                </button>
              </>
            )}
          </div>
        </div>
      ))}

        </div>

        {/* The template puts leave requests here. This shop has no leave
            feature — there is no table behind it — so rather than invent
            one, the rail carries what the owner actually looks back at:
            what they already decided, and when. It also gets the
            history out of the way of the queue. */}
        {decided.length > 0 && (
          <div className="split-rail">
            <div className="card">
              <div className="card-title">Recent decisions</div>
              {decided.map((a) => (
                <div className="decided-row" key={a.id}>
                  <div className="top">
                    <span className="amt">{rupees(a.amount)}</span>
                    <span className={`pill ${a.status === "APPROVED" ? "good" : "neutral"}`}>
                      {a.status === "APPROVED" ? "Approved" : "Declined"}
                    </span>
                  </div>
                  <div className="meta">
                    {titleCase(a.profiles?.full_name ?? "")}
                    {a.reason ? ` · ${a.reason}` : ""}
                    {a.decided_at ? ` · ${fmtDate(a.decided_at)}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
