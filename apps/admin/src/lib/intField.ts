/**
 * Whole-number input handler for controlled React inputs.
 *
 * Typing "0" in front of "100" yields the raw string "0100"; Number() maps
 * that back to 100, so React sees no state change, skips the re-render, and
 * the stale "0100" text stays on screen with an unremovable leading zero.
 * Normalising the DOM value here keeps what is displayed identical to what
 * is stored.
 *
 * Order matters: strip leading zeros BEFORE truncating, or "00100" truncates
 * to "0010" and then reads as 10.
 */
export function intFieldHandler(apply: (n: number) => void, maxDigits = 5) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const normalized = e.target.value
      .replace(/\D/g, "")
      .replace(/^0+(?=\d)/, "") // drop leading zeros, keep a lone "0"
      .slice(0, maxDigits);
    e.target.value = normalized;
    apply(normalized === "" ? 0 : parseInt(normalized, 10));
  };
}
