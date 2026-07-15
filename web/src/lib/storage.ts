export interface StringStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function stored(storage: Pick<StringStorage, "getItem">, key: string, fallback: string) {
  try { return storage.getItem(key) || fallback } catch { return fallback }
}

// Best-effort single-key write that never throws (private mode / quota).
export function persist(storage: Pick<StringStorage, "setItem">, key: string, value: string) {
  try { storage.setItem(key, value) } catch { /* restricted or full storage */ }
}

export function persistPublicSettings(storage: StringStorage, baseUrl: string, model: string) {
  try {
    storage.setItem("colibri.baseUrl", baseUrl)
    storage.setItem("colibri.model", model)
    // API credentials intentionally remain memory-only. Remove values left by
    // older web releases whenever public settings are persisted.
    storage.removeItem("colibri.apiKey")
  } catch { /* restricted storage mode */ }
}
