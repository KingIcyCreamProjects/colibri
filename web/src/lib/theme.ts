import { useEffect, useState } from "react"

export type Theme = "auto" | "light" | "dark"
const KEY = "colibri.theme"

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY)
    if (value === "light" || value === "dark" || value === "auto") return value
  } catch { /* restricted storage */ }
  return "auto"
}

// "auto" removes the attribute so the prefers-color-scheme media query governs;
// an explicit value stamps data-theme, which the CSS lets win over the query.
export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === "auto") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", theme)
  try { localStorage.setItem(KEY, theme) } catch { /* restricted storage */ }
  // tieni la chrome del browser mobile allineata al tema effettivo (Wave 3)
  const dark = theme === "dark" || (theme === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#080b0d" : "#f2efe7")
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => { applyTheme(theme) }, [theme])
  return [theme, setTheme] as const
}
