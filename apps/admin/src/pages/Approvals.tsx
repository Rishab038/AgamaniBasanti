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
        <h1>Approvals</h1>
        <p>Advance requests from staff — say yes or no, the app tells them instantly.</p>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {pending.length === 0 && (
        <div className="card">
          <span className="muted">Nothing waiting for you right now. 🎉</span>
        </div>
      )}

      {pending.map((a) => (
        <div className="approval-card" key={a.id}>
          <div>
            <div className="who">
              {titleCase(a.profiles?.full_name ?? "")}
              {a.recorded_by && a.recorded_by !== a.profile_id
                ? " took " : " asked for "}
              {rupees(a.amount)}
              <span className="muted"> · {fmtDate(a.created_at)}</span>
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

      {decided.length > 0 && (
        <>
          <h2>Recent decisions</h2>
          <table>
            <thead>
              <tr>
                <th>Staff</th>
                <th>Amount</th>
                <th>Reason</th>
                <th>Decision</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{titleCase(a.profiles?.full_name ?? "")}</strong>
                  </td>
                  <td>{rupees(a.amount)}</td>
                  <td className="muted">{a.reason ?? "—"}</td>
                  <td>
                    <span className={`pill ${a.status === "APPROVED" ? "good" : "serious"}`}>
                      {a.status === "APPROVED" ? "Approved" : "Rejected"}
                    </span>
                  </td>
                  <td className="muted">{a.decided_at ? fmtDate(a.decided_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
