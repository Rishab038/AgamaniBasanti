// Nocturne — the dark ground the whole app is drawn on.
//
// Two things about this system are worth knowing before changing it.
//
// 1. It is HAIRLINE-BASED, not shadow-based. Every surface is separated
//    from the ground by a one-pixel ring, never by a blur. That is a
//    design decision that happens to be the cheapest thing we could
//    have asked Android for: an elevation promotes a view to its own
//    layer and makes the system render a blur underneath it, and a
//    scrolling list of them is what made this app stutter on a ₹10,000
//    phone. `shadow.card` below is now a ring, so every screen that
//    already asked for it got faster without being touched.
//
// 2. There is ONE accent. Amber means "needs a decision", mint means
//    "settled", and neither is ever decorative. If a new colour seems
//    necessary, the answer is almost always a different weight of ink.
//
// Inter at 400/500/600 — the three weights already bundled. Nothing
// here adds a byte of font.

export const colors = {
  bg: "#161826",        // the ground
  surface: "#232532",   // every card
  sheet: "#282a38",     // modals and bottom sheets, one step up

  // Hairlines. Both are the ink colour at low alpha rather than a grey,
  // so they read as light catching an edge instead of a drawn border.
  line: "rgba(233,233,237,0.07)",
  line2: "rgba(233,233,237,0.16)",
  track: "rgba(233,233,237,0.09)",   // inactive pill / neutral fill

  ink: "#f3f5fe",
  ink2: "#b2b6ca",
  ink3: "#9397ab",
  mute: "#5d6172",      // a step below ink3: "not yet", "nothing here"

  accent: "#9184d9",
  accentDeep: "#5d5294",
  accentSoft: "rgba(145,132,217,0.16)",
  accentLight: "#b5abfc",
  // Text and glyphs that sit ON the accent. The accent is light enough
  // that white fails contrast on it; the ground colour passes easily.
  accentInk: "#161826",

  good: "#7fc9a6",
  goodBg: "rgba(127,201,166,0.16)",
  amber: "#e5a552",
  amberBg: "rgba(229,165,82,0.13)",
  amberInk: "#2a1e08",

  // The system has no red. Anything genuinely wrong borrows amber's
  // job at full strength; these two exist only so older screens that
  // asked for them keep working.
  rose: "#e5a552",
  roseBg: "rgba(229,165,82,0.13)",
  serious: "#e5776b",
  seriousBg: "rgba(229,119,107,0.14)",
};

// Android ignores fontWeight for custom fonts, so text must name the
// family rather than set a weight.
export const fonts = {
  regular: "Inter_400Regular",
  semi: "Inter_500Medium",
  bold: "Inter_500Medium",
  extra: "Inter_600SemiBold",
  black: "Inter_600SemiBold",
};

export const radius = { sm: 14, md: 16, lg: 20, xl: 24, pill: 999 };

// A ring, not a shadow — see the note at the top of this file. Spread
// into a style array exactly as before; the twenty-five places that
// already do so now cost one rect each instead of a blurred layer.
export const shadow = {
  card: { borderWidth: 1, borderColor: colors.line },
  button: { borderWidth: 1, borderColor: "rgba(145,132,217,0.28)" },
  buttonGood: { borderWidth: 1, borderColor: "rgba(127,201,166,0.28)" },
};

export const rowEdge = { borderWidth: 1, borderColor: colors.line };
