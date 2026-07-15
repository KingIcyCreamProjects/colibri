import { useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleStop,
  Clock,
  Copy,
  Cpu,
  Database,
  Feather,
  Gauge,
  HardDrive,
  KeyRound,
  Layers,
  Link2,
  LoaderCircle,
  MemoryStick,
  Menu,
  MessageSquareText,
  Monitor,
  MonitorDot,
  Moon,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  Sun,
  Timer,
  Trash2,
  WifiOff,
  X,
  Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { friendlyError, getHealth, listModels, streamChat, type ChatMessage, type HealthResponse, type StreamChatResult } from "@/lib/api"
import { activeRequests, supportsCacheSlots } from "@/lib/runtime"
import { Markdown, copyText, visibleAnswer } from "@/lib/markdown"
import { Brain } from "./Brain"
import { persist, persistPublicSettings, stored } from "@/lib/storage"
import { useTheme, type Theme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const message = (role: ChatMessage["role"], content: string): ChatMessage => ({ id: crypto.randomUUID(), role, content })

const PRESETS = [
  { name: "Precise", temp: 0.2, top: 0.9 },
  { name: "Balanced", temp: 0.7, top: 0.95 },
  { name: "Creative", temp: 1.0, top: 1.0 },
]
const THEMES: [Theme, typeof Monitor, string][] = [["auto", Monitor, "Auto"], ["light", Sun, "Light"], ["dark", Moon, "Dark"]]

function loadConversations(): Record<number, ChatMessage[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem("colibri.conversations") || "null")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<number, ChatMessage[]>
  } catch { /* corrupt or unavailable */ }
  return { 0: [] }
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const max = Math.max(...data), min = Math.min(...data)
  const range = max - min || 1
  const w = 42, h = 12
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(" ")
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline points={pts} /></svg>
}

function MessageTools({ item, loading, onRegen, onEdit }: {
  item: ChatMessage; loading: boolean; onRegen: (id: string) => void; onEdit: (item: ChatMessage) => void
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () => {
    void copyText(visibleAnswer(item.content, item.reasoning))
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="msg-tools">
      <button type="button" className={copied ? "ok" : ""} onClick={copy} aria-label="Copy message">
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? "Copied" : "Copy"}
      </button>
      {item.role === "assistant" && (
        <button type="button" onClick={() => onRegen(item.id)} disabled={loading} aria-label="Regenerate response"><RotateCcw className="size-3" /> Retry</button>
      )}
      {item.role === "user" && (
        <button type="button" onClick={() => onEdit(item)} disabled={loading} aria-label="Edit message"><Pencil className="size-3" /> Edit</button>
      )}
    </div>
  )
}

export default function App() {
  // When the page is served by the engine itself (coli web), same-origin is the
  // right default: no CORS, no manual endpoint editing. The Vite dev server
  // (port 5173) keeps the classic default.
  const servedByEngine = typeof window !== "undefined" && window.location.port !== "5173" && window.location.protocol.startsWith("http")
  const defaultBase = servedByEngine ? `${window.location.origin}/v1` : "http://127.0.0.1:8000/v1"
  const [baseUrl, setBaseUrl] = useState(() => {
    const saved = stored(localStorage, "colibri.baseUrl", defaultBase)
    if (servedByEngine && saved === "http://127.0.0.1:8000/v1" && defaultBase !== saved) return defaultBase
    return saved
  })
  const [apiKey, setApiKey] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState(() => stored(localStorage, "colibri.model", "glm-5.2-colibri"))
  const [temperature, setTemperature] = useState(0.7)
  const [topP, setTopP] = useState(0.9)
  const [maxTokens, setMaxTokens] = useState(512)
  const [thinking, setThinking] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState(() => stored(localStorage, "colibri.systemPrompt", ""))
  const [cacheSlot, setCacheSlot] = useState(0)
  const [conversations, setConversations] = useState<Record<number, ChatMessage[]>>(loadConversations)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState("")
  const [lastRun, setLastRun] = useState<StreamChatResult | null>(null)
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [tokenCount, setTokenCount] = useState(0)
  const [tokPerSec, setTokPerSec] = useState<number | null>(null)
  const [spark, setSpark] = useState<number[]>([])
  const [ttft, setTtft] = useState<number | null>(null)
  const [totalTokens, setTotalTokens] = useState({ prompt: 0, completion: 0 })
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [view, setView] = useState<"chat" | "brain">("chat")
  const [error, setError] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [theme, setTheme] = useTheme()
  const autoConnected = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const probeRef = useRef<AbortController | null>(null)
  const backoffRef = useRef<{ n: number; timer: number }>({ n: 0, timer: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messages = conversations[cacheSlot] || []
  const hasMessages = messages.length > 0
  const kvSlots = Math.max(1, health?.kv_slots || 1)
  const active = activeRequests(health)
  const capacity = health?.scheduler?.capacity || kvSlots
  const failures = health?.scheduler ? health.scheduler.rejected + health.scheduler.timed_out + health.scheduler.cancelled : 0

  // Some builds advertise a context window; ours does not, so the gauge stays
  // hidden. A dev query param lets us exercise the UI locally (?nctx=8192).
  const devCtx = import.meta.env.DEV ? Number(new URLSearchParams(window.location.search).get("nctx")) : 0
  const nCtx = health?.n_ctx || (devCtx > 0 ? devCtx : undefined)
  const approxTokens = Math.ceil((systemPrompt.length + draft.length + messages.reduce((n, m) => n + m.content.length, 0)) / 4)

  const activePreset = PRESETS.find((p) => Math.abs(p.temp - temperature) < 1e-6 && Math.abs(p.top - topP) < 1e-6)

  const updateMessages = (next: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) =>
    setConversations((current) => ({
      ...current,
      [cacheSlot]: typeof next === "function" ? next(current[cacheSlot] || []) : next,
    }))

  const clearBackoff = () => { window.clearTimeout(backoffRef.current.timer); backoffRef.current.timer = 0 }

  // EFFECT #1 — persist endpoint + model
  useEffect(() => { persistPublicSettings(localStorage, baseUrl, model) }, [baseUrl, model])

  // EFFECT — persist system prompt (P5)
  useEffect(() => { persist(localStorage, "colibri.systemPrompt", systemPrompt) }, [systemPrompt])

  // EFFECT — persist conversations (P10), debounced to avoid per-token writes
  useEffect(() => {
    const id = window.setTimeout(() => persist(localStorage, "colibri.conversations", JSON.stringify(conversations)), 400)
    return () => window.clearTimeout(id)
  }, [conversations])

  // EFFECT #2 — endpoint/credential change resets connection
  useEffect(() => {
    setConnected(false)
    setHealth(null)
    setHealthError("")
    setReconnecting(false)
    backoffRef.current.n = 0
    clearBackoff()
  }, [baseUrl, apiKey])

  // EFFECT #3 — teardown
  useEffect(() => () => {
    probeRef.current?.abort()
    abortRef.current?.abort()
    clearBackoff()
  }, [])

  // EFFECT #4 — poll health while connected
  useEffect(() => {
    if (!connected) return
    let disposed = false
    const poll = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const result = await getHealth(baseUrl, apiKey)
        if (!disposed) { setHealth(result); setHealthError("") }
      } catch (cause) {
        if (!disposed) setHealthError(friendlyError(cause, baseUrl))
      }
    }
    const timer = window.setInterval(() => void poll(), 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [apiKey, baseUrl, connected])

  // EFFECT #5 — keep the selected slot in range
  useEffect(() => { if (cacheSlot >= kvSlots) setCacheSlot(0) }, [cacheSlot, kvSlots])

  // EFFECT #6 — reset per-slot run metrics on slot change (anche i badge
  // "persistenti": appartengono al run del vecchio slot, non a questo)
  useEffect(() => { setLastRun(null); setTokPerSec(null); setTtft(null); setSpark([]); setTokenCount(0) }, [cacheSlot])

  // EFFECT #7 (P1) — pin to bottom only while the viewport is already at bottom
  useEffect(() => { if (atBottom) bottomRef.current?.scrollIntoView({ block: "end" }) }, [messages, atBottom])

  // EFFECT (P1) — track whether the viewport is at (or within 80px of) the
  // bottom; that tolerance keeps us pinned across font reflow and the last
  // line's line-height without fighting a deliberate scroll-up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    el.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener("scroll", onScroll)
  }, [view, hasMessages])

  const scheduleReconnect = () => {
    if (backoffRef.current.n > 8) { setReconnecting(false); return } // give up auto-retry; manual still works
    const delay = Math.min(30000, 1000 * 2 ** backoffRef.current.n)
    backoffRef.current.n++
    clearBackoff()
    setReconnecting(true)
    backoffRef.current.timer = window.setTimeout(() => { backoffRef.current.timer = 0; void connect() }, delay)
  }

  const connect = async () => {
    clearBackoff()
    probeRef.current?.abort()
    const controller = new AbortController()
    probeRef.current = controller
    setConnecting(true)
    setError("")
    try {
      const found = await listModels(baseUrl, apiKey, controller.signal)
      setModels(found)
      if (found.length && !found.includes(model)) setModel(found[0])
      setConnected(true)
      backoffRef.current.n = 0
      setReconnecting(false)
      try {
        setHealth(await getHealth(baseUrl, apiKey, controller.signal))
        setHealthError("")
      } catch (cause) {
        if (!controller.signal.aborted) {
          setHealth(null)
          setHealthError(friendlyError(cause, baseUrl))
        }
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      setConnected(false)
      setError(friendlyError(cause, baseUrl))
      scheduleReconnect()
    } finally {
      if (probeRef.current === controller) { probeRef.current = null; setConnecting(false) }
    }
  }

  const retryConnect = () => { backoffRef.current.n = 0; void connect() }

  if (servedByEngine && !autoConnected.current && !connected) {
    autoConnected.current = true
    setTimeout(() => connect(), 0)
  }

  const canSend = useMemo(() => draft.trim() && model && !loading, [draft, loading, model])

  // Single streaming path reused by first sends, regenerate and edit-resend.
  // `history` is the full turn list ending at the user message to answer.
  const run = async (history: ChatMessage[], thinkingTurn = thinking) => {
    if (loading) return
    const assistant = message("assistant", "")
    if (thinkingTurn) assistant.reasoning = true
    setError("")
    setEditingId(null)
    setDrawerOpen(false)
    updateMessages([...history, assistant])
    setStreamingId(assistant.id)
    setLoading(true)
    setTokenCount(0)
    setSpark([])
    setAtBottom(true)
    const sys = systemPrompt.trim()
    const reqMessages = sys ? [message("system", sys), ...history] : history
    const t0 = performance.now()
    let firstToken = true
    let count = 0
    let acc = ""
    let thinkClosed = false
    let lastSample = 0
    const samples: number[] = []
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await streamChat({
        baseUrl,
        apiKey,
        model,
        messages: reqMessages,
        temperature,
        topP,
        maxTokens,
        enableThinking: thinkingTurn,
        cacheSlot: supportsCacheSlots(health) ? cacheSlot : undefined,
        signal: controller.signal,
        onDelta: (delta) => {
          if (firstToken) { setTtft(performance.now() - t0); firstToken = false }
          count++
          acc += delta
          setTokenCount(count)
          if (!thinkClosed && acc.includes("</think>")) {
            thinkClosed = true
            const ms = performance.now() - t0
            updateMessages((current) => current.map((item) => (item.id === assistant.id ? { ...item, thinkMs: ms } : item)))
          }
          const secs = (performance.now() - t0) / 1000
          if (secs > 0.3) {
            const tps = count / secs
            setTokPerSec(tps)
            const now = performance.now()
            if (now - lastSample > 150) {
              lastSample = now
              samples.push(tps)
              if (samples.length > 48) samples.shift()
              setSpark(samples.slice())
            }
          }
          updateMessages((current) => current.map((item) => (item.id === assistant.id ? { ...item, content: item.content + delta } : item)))
        },
      })
      const finalElapsed = (performance.now() - t0) / 1000
      if (count > 0 && finalElapsed > 0) setTokPerSec(count / finalElapsed)
      if (result.usage) setTotalTokens((prev) => ({
        prompt: prev.prompt + (result.usage?.prompt_tokens || 0),
        completion: prev.completion + (result.usage?.completion_tokens || 0),
      }))
      setLastRun(result)
      setConnected(true)
    } catch (cause) {
      updateMessages((current) => current.filter((item) => item.id !== assistant.id || item.content))
      if (!controller.signal.aborted) setError(friendlyError(cause, baseUrl))
    } finally {
      abortRef.current = null
      setLoading(false)
      setStreamingId(null)
    }
  }

  const send = () => {
    const content = draft.trim()
    if (!content || loading) return
    setDraft("")
    void run([...messages, message("user", content)])
  }

  // P4: slice history to the user turn that produced this answer and re-run it.
  const regenerate = (assistantId: string) => {
    if (loading) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx < 0) return
    void run(messages.slice(0, idx))
  }

  const startEdit = (item: ChatMessage) => { setEditingId(item.id); setEditDraft(item.content) }

  // P4: truncate after the edited user message and resend the truncated history.
  // The server rebuilds KV from the submitted history, so no stale replay.
  const submitEdit = () => {
    const idx = messages.findIndex((m) => m.id === editingId)
    if (idx < 0 || !editDraft.trim()) { setEditingId(null); return }
    const edited = { ...messages[idx], content: editDraft.trim() }
    void run([...messages.slice(0, idx), edited])
  }

  const clearChat = () => {
    updateMessages([])
    setTokPerSec(null); setTtft(null); setTokenCount(0); setSpark([])
    setTotalTokens({ prompt: 0, completion: 0 })
  }

  const jumpToLatest = () => { setAtBottom(true); bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }) }

  const connError = !connected && !connecting && Boolean(error || healthError)

  return (
    <div className={cn("app-shell", drawerOpen && "drawer-open")}>
      <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Feather className="size-5" /></div>
          <div><h1>colibrì</h1><p>local giant, tiny footprint</p></div>
          <button type="button" className="drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Close menu"><X className="size-4" /></button>
        </div>

        <section className="side-section">
          <div className="section-title"><Link2 className="size-3.5" /> Connection</div>
          <label>API endpoint<Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label>API key<div className="relative"><KeyRound className="field-icon" /><Input className="pl-9" type="password" value={apiKey} placeholder="optional" onChange={(event) => setApiKey(event.target.value)} /></div><span className="field-help">Kept in memory only · sent to this endpoint</span></label>
          <Button type="button" variant="secondary" onClick={retryConnect} disabled={connecting}>
            {connecting ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Probe server
          </Button>
          <div className={cn("connection-state", connected && "connected")} aria-live="polite"><span />{connected ? "Engine reachable" : connecting ? "Probing…" : reconnecting ? "Reconnecting…" : "Not connected"}</div>
        </section>

        <section className="side-section runtime-section" aria-live="polite">
          <div className="section-title"><Activity className="size-3.5" /> Runtime</div>
          {health?.hwinfo ? <div className="hw-panel">
            {health.hwinfo.cpu ? <div className="hw-row"><Cpu className="size-3.5" /><span>{health.hwinfo.cpu}</span></div> : null}
            {health.hwinfo.gpus > 0 ? <div className="hw-row"><MonitorDot className="size-3.5" /><span>{health.hwinfo.gpus}× GPU<small>{health.hwinfo.vram_total_gb.toFixed(0)} GB VRAM</small></span></div> : null}
            <div className="hw-row"><MemoryStick className="size-3.5" /><span>{health.hwinfo.ram_total_gb.toFixed(0)} GB RAM<small>{health.hwinfo.ram_avail_gb.toFixed(0)} GB free</small></span></div>
            <div className="hw-row"><HardDrive className="size-3.5" /><span>{health.hwinfo.cores} cores</span></div>
          </div> : null}
          {health?.scheduler ? <>
            <div className="runtime-grid">
              <div><span>Active</span><strong>{active}<small> / {capacity}</small></strong></div>
              <div><span>Queued</span><strong>{health.scheduler.queued}<small> / {health.scheduler.max_queue}</small></strong></div>
              <div><span>Completed</span><strong>{health.scheduler.completed}</strong></div>
              <div><span>Failures</span><strong>{failures}</strong></div>
            </div>
            {health.tiers ? (() => {
              const t = health.tiers
              const total = Math.max(t.vram + t.ram + t.disk, 1)
              return <div className="tier-panel">
                <div className="tier-bar" role="img" aria-label={`Experts: ${t.vram} VRAM, ${t.ram} RAM, ${t.disk} disk`}>
                  <span className="tier-vram" style={{ width: `${(100 * t.vram) / total}%` }} />
                  <span className="tier-ram" style={{ width: `${(100 * t.ram) / total}%` }} />
                  <span className="tier-disk" style={{ width: `${(100 * t.disk) / total}%` }} />
                </div>
                <div className="tier-legend">
                  <span><i className="tier-vram" />VRAM <strong>{t.vram.toLocaleString()}</strong><small>{t.vram_gb.toFixed(1)} GB</small></span>
                  <span><i className="tier-ram" />RAM <strong>{t.ram.toLocaleString()}</strong><small>{t.ram_gb.toFixed(1)} GB</small></span>
                  <span><i className="tier-disk" />Disk <strong>{t.disk.toLocaleString()}</strong></span>
                </div>
              </div>
            })() : null}
            {totalTokens.prompt + totalTokens.completion > 0 ? <div className="session-stats">
              <span><Database className="size-3" /> Session: <strong>{totalTokens.prompt.toLocaleString()}</strong> prompt + <strong>{totalTokens.completion.toLocaleString()}</strong> completion</span>
            </div> : null}
            <div className="runtime-foot"><span className="runtime-dot" /> Scheduler online <code>{kvSlots} KV</code></div>
          </> : <p className="runtime-unavailable">{connected ? (healthError || "Runtime metrics unavailable") : "Probe the server to inspect runtime state."}</p>}
        </section>

        <section className="side-section">
          <div className="section-title"><SlidersHorizontal className="size-3.5" /> Inference</div>
          <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{models.length ? models.map((id) => <option key={id}>{id}</option>) : <option>{model}</option>}</select></label>
          {health?.kv_slots && health.kv_slots > 1 ? <label>KV session<select value={cacheSlot} onChange={(event) => setCacheSlot(Number(event.target.value))} disabled={loading}>
            {Array.from({ length: kvSlots }, (_, slot) => <option key={slot} value={slot}>Session {slot + 1}</option>)}
          </select><span className="field-help">Isolated context · conversation follows the selected slot</span></label> : null}
          <label><span className="label-line"><span>Temperature</span><code>{temperature.toFixed(2)}</code></span><input className="range" type="range" min="0" max="2" step="0.05" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label>
          <label><span className="label-line"><span>Top P</span><code>{topP.toFixed(2)}</code></span><input className="range" type="range" min="0.05" max="1" step="0.05" value={topP} onChange={(event) => setTopP(Number(event.target.value))} /></label>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" className={activePreset?.name === p.name ? "active" : ""} onClick={() => { setTemperature(p.temp); setTopP(p.top) }}>
                {p.name}<small>{p.temp.toFixed(1)} · {p.top.toFixed(2)}</small>
              </button>
            ))}
          </div>
          <label>Max output tokens<Input type="number" min={1} max={4096} value={maxTokens} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setMaxTokens(Math.min(4096, Math.max(1, Math.round(value)))) }} /></label>
          <button type="button" className={cn("toggle-row", thinking && "active")} aria-pressed={thinking} onClick={() => setThinking((value) => !value)}>
            <span><BrainCircuit className="size-4" /> Reasoning</span><i><b /></i>
          </button>
        </section>

        <section className="side-section">
          <div className="section-title"><ScrollText className="size-3.5" /> System prompt</div>
          <Textarea value={systemPrompt} placeholder="Steer every reply — e.g. “You are a terse C systems expert.”" onChange={(event) => setSystemPrompt(event.target.value)} style={{ minHeight: 70 }} />
          <span className="field-help">Sent as the first message · persists across reloads</span>
        </section>

        <section className="side-section">
          <div className="section-title"><Sun className="size-3.5" /> Appearance</div>
          <div className="theme-switch" role="group" aria-label="Theme">
            {THEMES.map(([value, Icon, label]) => (
              <button key={value} type="button" className={theme === value ? "active" : ""} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </section>

        <div className="sidebar-foot"><Cpu className="size-3.5" /><span>OpenAI-compatible transport</span></div>
      </aside>

      <main className="chat-panel">
        <header className="topbar">
          <button type="button" className="drawer-toggle" onClick={() => setDrawerOpen(true)} aria-label="Open menu"><Menu className="size-4" /></button>
          <div className="topbar-id"><span className="eyebrow">ACTIVE MODEL</span><strong>{model}</strong></div>
          <div className="view-tabs">
            <button className={view === "chat" ? "active" : ""} onClick={() => { setView("chat"); setDrawerOpen(false) }}><MessageSquareText className="size-3.5" /> Chat</button>
            <button className={view === "brain" ? "active" : ""} onClick={() => { setView("brain"); setDrawerOpen(false) }}><BrainCircuit className="size-3.5" /> Brain</button>
          </div>
          <div className="top-actions">
              {loading && tokenCount > 0 ? <Badge className="badge-live"><Zap className="size-3 flash" /> {tokenCount} tokens</Badge> : null}
              {tokPerSec != null ? <Badge className="badge-speed"><Gauge className="size-3" /> {tokPerSec.toFixed(1)} tok/s<Sparkline data={spark} /></Badge> : null}
              {ttft != null ? <Badge><Timer className="size-3" /> TTFT {(ttft / 1000).toFixed(1)}s</Badge> : null}
              {!loading && lastRun?.usage ? <Badge><Layers className="size-3" /> {lastRun.usage.prompt_tokens}→{lastRun.usage.completion_tokens}</Badge> : null}
              {!loading && lastRun?.queueWaitMs != null ? <Badge><Clock className="size-3" /> queue {Math.round(lastRun.queueWaitMs)}ms</Badge> : null}
              <Badge><MonitorDot className="size-3" /> slot {cacheSlot + 1}</Badge>
              <Button variant="ghost" size="sm" onClick={clearChat} disabled={!hasMessages || loading}><Trash2 className="size-3.5" /> Clear</Button>
            </div>
        </header>

        {view === "brain" ? <Brain baseUrl={baseUrl} apiKey={apiKey} connected={connected} /> : <>

        <div className="chat-scroll">
        <div className="conversation" ref={scrollRef}>
          {!hasMessages ? (
            connError ? (
              <div className="empty-state">
                <div className="conn-error">
                  <div className="conn-title"><WifiOff className="size-4" /> Can't reach the engine</div>
                  <p>{friendlyError(error || healthError, baseUrl)}</p>
                  <p>Endpoint <code>{baseUrl}</code></p>
                  <button type="button" className="conn-retry" onClick={retryConnect} disabled={connecting}>
                    {connecting ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Retry now
                  </button>
                  {reconnecting ? <p>Reconnecting automatically…</p> : null}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="orb"><Feather /></div>
                <span className="eyebrow">COLIBRÌ ENGINE</span>
                <h2>Ask the giant.<br /><em>Keep the machine yours.</em></h2>
                <p>Connect to a local colibrì server and stream responses directly from your hardware. Nothing leaves the endpoint you choose.</p>
                <div className="suggestions">
                  {["Explain how expert routing works", "Write a small C benchmark", "Compare RAM and VRAM caching"].map((item) => <button key={item} onClick={() => setDraft(item)}>{item}<ArrowUp className="size-3.5 rotate-45" /></button>)}
                </div>
              </div>
            )
          ) : (
            <div className="message-list">
              {messages.map((item) => (
                <article key={item.id} className={cn("message", item.role)}>
                  <div className="avatar">{item.role === "user" ? "Y" : <Feather className="size-4" />}</div>
                  <div className="message-col">
                    <div className="message-meta">
                      {item.role === "user" ? "You" : "colibrì"}
                      {!loading && editingId !== item.id ? <MessageTools item={item} loading={loading} onRegen={regenerate} onEdit={startEdit} /> : null}
                    </div>
                    {editingId === item.id ? (
                      <div className="edit-box">
                        <textarea value={editDraft} autoFocus onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitEdit() } if (event.key === "Escape") setEditingId(null) }} />
                        <div className="edit-actions">
                          <Button size="sm" onClick={submitEdit} disabled={!editDraft.trim()}>Save & resend</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="message-body">
                        {item.role === "assistant"
                          ? (item.content
                              ? <Markdown content={item.content} streaming={loading && item.id === streamingId} reasoning={item.reasoning} thinkMs={item.thinkMs} />
                              : <span className="typing" aria-label="Generating"><i /><i /><i /></span>)
                          : (item.content || null)}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
          {/* fuori dallo scroller: un figlio absolute di un contenitore overflow
              scrolla col contenuto e sparisce nelle conversazioni lunghe (Wave 3) */}
          {hasMessages && !atBottom ? (
            <button type="button" className="jump-latest" onClick={jumpToLatest}><ChevronDown className="size-4" /> Jump to latest</button>
          ) : null}
        </div>

        <div className="composer-wrap">
          {error && hasMessages && <div className="error-banner" role="alert">{error}</div>}
          {nCtx ? <div className="ctx-gauge">
            <div className="ctx-gauge-head"><span>Context (approx)</span><strong>{approxTokens.toLocaleString()} / {nCtx.toLocaleString()}</strong></div>
            <div className={cn("tier-bar ctx-fill", approxTokens > nCtx && "over")}><span className="tier-vram" style={{ width: `${Math.min(100, (100 * approxTokens) / nCtx)}%` }} /></div>
          </div> : null}
          <div className="composer">
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message colibrì…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
            <div className="composer-foot">
              <span><MessageSquareText className="size-3.5" /> Enter to send · Shift+Enter for newline</span>
              <div className="composer-foot-right">
                {nCtx ? <span className={cn("composer-count", approxTokens > nCtx && "over")}>~{approxTokens.toLocaleString()} tok</span> : null}
                {loading ? <Button variant="destructive" size="icon" aria-label="Stop generation" onClick={() => abortRef.current?.abort()}><CircleStop className="size-4" /></Button> : <Button size="icon" aria-label="Send message" disabled={!canSend} onClick={() => void send()}><ArrowUp className="size-4" /></Button>}
              </div>
            </div>
          </div>
        </div>
        </>}
      </main>
    </div>
  )
}
