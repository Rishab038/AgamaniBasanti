// Light or dark, and who decided.
//
// Three states, not two. "System" is the default and is not the same as
// light — a laptop that switches itself at sunset should carry the
// dashboard with it. Choosing explicitly pins it until the owner
// chooses again.
//
// The stored value is read a second time here, having already been read
// by the inline script in index.html. That script runs before the first
// paint and is what stops the page flashing cream on the way to dark;
// this hook only has to keep React in step with it afterwards.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "agamani-theme";

const read = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";           // private mode, or storage switched off
  }
};

/** what the machine is set to right now */
const systemIsDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

const apply = (t: Theme) => {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
};

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(read);
  // only so the button can show which way "system" currently points
  const [systemDark, setSystemDark] = useState(systemIsDark);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // the choice still holds for this visit; it just will not be remembered
    }
  }, []);

  const isDark = theme === "dark" || (theme === "system" && systemDark);

  return { theme, setTheme, isDark };
}
