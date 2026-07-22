// "Warm & friendly" tokens — cream ground, cocoa ink, terracotta
// accent, rounded Nunito. Shared across every screen.

// Matches the dashboard's system (see apps/admin/src/index.css):
// neutral ground, ONE accent, and only three text weights. Heavy
// rounded type everywhere was what made the old version look unserious.

export const colors = {
  bg: "#faf6f0",
  surface: "#ffffff",
  line: "#eee2d3",
  line2: "#e3d5c3",

  ink: "#3a2f28",
  ink2: "#6b5a4c",
  ink3: "#9a8574",

  accent: "#d96f4e",
  accentDeep: "#c65f3f",
  accentSoft: "#fdeee7",

  good: "#4d8a4f",
  goodBg: "#e7f0e3",
  amber: "#a5622d",
  amberBg: "#fdeede",
  rose: "#8a5560",
  roseBg: "#f0e6e8",
  serious: "#b3402e",
  seriousBg: "#f9e7e2",
};

// Inter, three weights. Android ignores fontWeight for custom fonts,
// so text must name the family rather than set a weight.
// `black`/`extra` are kept as aliases so existing screens keep working;
// both map to semibold, which is the heaviest weight this design uses.
export const fonts = {
  regular: "Inter_400Regular",
  semi: "Inter_400Regular",
  bold: "Inter_500Medium",
  extra: "Inter_600SemiBold",
  black: "Inter_600SemiBold",
};

export const radius = { sm: 12, md: 16, lg: 22, pill: 999 };

export const shadow = {
  card: {
    shadowColor: "#3a2f28",
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  button: {
    shadowColor: "#c65f3f",
    shadowOpacity: 0.4,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  buttonGood: {
    shadowColor: "#4d8a4f",
    shadowOpacity: 0.4,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
};
