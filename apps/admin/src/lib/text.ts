// Staff names are typed by many hands — "MANDIP MALAKAR", "Mithu sarkar",
// "SUBHAM MONDAL" all exist in the table. Rather than rewrite what people
// entered, normalise at the point of display so every list reads evenly.

/** "MANDIP MALAKAR" / "mithu sarkar" -> "Mandip Malakar" / "Mithu Sarkar" */
export const titleCase = (s: string): string =>
  s
    .toLowerCase()
    .replace(/(^|[^A-Za-z'])([a-z])/g, (_, before: string, ch: string) => before + ch.toUpperCase());

/** alphabetical by displayed name, case- and accent-insensitive */
export const byName = <T extends { full_name: string }>(a: T, b: T): number =>
  a.full_name.localeCompare(b.full_name, "en", { sensitivity: "base" });
