// Which shop the dashboard is currently showing.
//
// Every page reads `branchId` and filters by it, so the whole site
// behaves as a replica per shop. The choice is remembered in
// localStorage: an owner who works mainly from one shop should not
// have to re-pick it on every visit.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { supabase } from "./supabase";

export type Branch = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  wifi_ssid: string | null;
  join_code: string;
};

type Ctx = {
  branches: Branch[];
  branch: Branch | null;
  branchId: string | null;
  setBranchId: (id: string) => void;
  reloadBranches: () => Promise<void>;
  loading: boolean;
};

const BranchCtx = createContext<Ctx | null>(null);
const STORAGE_KEY = "agamani.branchId";

export function BranchProvider({ children }: { children: React.ReactNode }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reloadBranches = useCallback(async () => {
    const { data } = await supabase
      .from("branches")
      .select("id, name, lat, lng, radius_m, wifi_ssid, join_code")
      .order("created_at");
    const list = data ?? [];
    setBranches(list);
    setBranchIdState((current) => {
      // keep the current pick if it still exists, else fall back to
      // the remembered one, else the first shop
      if (current && list.some((b) => b.id === current)) return current;
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && list.some((b) => b.id === saved)) return saved;
      return list[0]?.id ?? null;
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    reloadBranches();
  }, [reloadBranches]);

  const setBranchId = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setBranchIdState(id);
  }, []);

  const value = useMemo<Ctx>(() => ({
    branches,
    branch: branches.find((b) => b.id === branchId) ?? null,
    branchId,
    setBranchId,
    reloadBranches,
    loading,
  }), [branches, branchId, setBranchId, reloadBranches, loading]);

  return <BranchCtx.Provider value={value}>{children}</BranchCtx.Provider>;
}

export function useBranch(): Ctx {
  const ctx = useContext(BranchCtx);
  if (!ctx) throw new Error("useBranch must be used inside BranchProvider");
  return ctx;
}
