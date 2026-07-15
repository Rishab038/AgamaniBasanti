// One place for every color and size — both screens pull from here
// so the app always looks like one product.

export const colors = {
  brand: "#0d9488",
  brandDark: "#0f766e",
  brandDeep: "#134e4a",
  ink: "#0f172a",
  ink2: "#475569",
  ink3: "#94a3b8",
  bg: "#f6f8fa",
  surface: "#ffffff",
  line: "#e5e9f0",
  good: "#15803d",
  goodBg: "#f0fdf4",
  warn: "#b45309",
  warnBg: "#fffbeb",
  serious: "#b91c1c",
  seriousBg: "#fef2f2",
  out: "#c2410c",
};

export const radius = { md: 14, lg: 20, pill: 999 };

export const shadow = {
  card: {
    shadowColor: "#0f172a",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  button: {
    shadowColor: "#0f766e",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
};
