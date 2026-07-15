// Design tokens — the worker app is a rich dark product, sharing
// the admin dashboard's navy + teal so both feel like one brand.

export const colors = {
  // surfaces
  bg: "#0c1222",
  bg2: "#111a30",
  card: "rgba(255,255,255,0.055)",
  cardBorder: "rgba(255,255,255,0.09)",
  cardSolid: "#151f38",

  // ink on dark
  ink: "#f1f5f9",
  ink2: "#a6b4c8",
  ink3: "#64748b",

  // brand
  brand: "#2dd4bf",
  brandStrong: "#14b8a6",
  brandDeep: "#0d9488",

  // check-out warmth
  out: "#fb923c",
  outDeep: "#ea580c",

  // status (lightened for dark surfaces)
  good: "#4ade80",
  goodDeep: "#16a34a",
  warn: "#fbbf24",
  serious: "#f87171",
};

export const gradients = {
  checkin: ["#2dd4bf", "#0d9488"] as const,
  checkout: ["#fb923c", "#ea580c"] as const,
  screen: ["#0c1222", "#0e1730", "#0c1222"] as const,
  success: ["rgba(12,18,34,0.96)", "rgba(6,44,36,0.97)"] as const,
};

export const radius = { md: 14, lg: 22, xl: 28, pill: 999 };

export const shadow = {
  glowTeal: {
    shadowColor: "#14b8a6",
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  glowOrange: {
    shadowColor: "#ea580c",
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
};
