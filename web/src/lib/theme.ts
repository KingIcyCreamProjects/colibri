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
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => { applyTheme(theme) }, [theme])
  return [theme, setTheme] as const
}
