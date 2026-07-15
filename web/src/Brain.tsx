import { useEffect, useMemo, useRef, useState } from "react"
import { BrainCircuit, Flame, Layers, LoaderCircle } from "lucide-react"

import { endpoint } from "@/lib/api"

interface ExpertMap { rows: number; cols: number; map: string; hits: string; seq: number }
interface AtlasEntry { affinity: Record<string, number>; entropy: number; top: string; label: string }

const TIER_NAME = ["Disk", "RAM", "VRAM"]
const TIER_RGB: [number, number, number][] = [[58, 71, 80], [90, 155, 216], [78, 214, 165]]

// real GLM layer index for a grid row (mirrors the tooltip: +3 offset, MTP last)
const realLayer = (row: number, rows: number) => (row === rows - 1 ? 78 : row + 3)

// dev-only: synthesize a full-scale 76×256 (19,456-expert) map to prove the
// canvas heatmap stays smooth. Enable with ?mock on the dev server.
function mockExperts(): ExpertMap {
  const rows = 76, cols = 256, n = rows * cols
  let map = ""
  for (let i = 0; i < n; i++) {
    const tier = (Math.random() * 3) | 0
    const heat = Math.random() < 0.14 ? 0 : (Math.random() * 40) | 0
    map += (((tier << 6) | heat) & 0xff).toString(16).padStart(2, "0")
  }
  let hits = ""
  for (let b = 0; b < Math.ceil(n / 8); b++) hits += ((Math.random() * 256) | 0).toString(16).padStart(2, "0")
  return { rows, cols, map, hits, seq: Date.now() }
}

/* Layer-depth heuristic: what this region of the network tends to specialise in.
 * Honest framing — these are the depth roles observed across MoE interpretability
 * work, not per-expert ground truth (that needs co-activation analysis, #119). */
function depthRole(row: number, rows: number, isMtp: boolean): string {
  if (isMtp) return "MTP head — drafts the next token for speculative decoding"
  const f = row / Math.max(rows - 1, 1)
  if (f < 0.2) return "early layers — surface features: tokens, spelling, local syntax"
  if (f < 0.45) return "lower-middle — phrase structure, word relations, simple facts"
  if (f < 0.7) return "upper-middle — semantics, long-range context, reasoning steps"
  if (f < 0.9) return "late layers — planning the answer, style, coherence"
  return "final layers — output shaping: picks the actual next-token distribution"
}

export function Brain({ baseUrl, apiKey, connected }: { baseUrl: string; apiKey: string; connected: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [wrapSize, setWrapSize] = useState({ w: 1200, h: 700 })
  const [data, setData] = useState<ExpertMap | null>(null)
  const [atlas, setAtlas] = useState<Record<string, AtlasEntry> | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; row: number; col: number; tier: number; heat: number } | null>(null)
  const [mode, setMode] = useState<"cumulative" | "turn">("cumulative")
  const pulseRef = useRef<Float32Array | null>(null)   // per-expert pulse intensity 0..1
  const lastSeq = useRef(0)
  const rafRef = useRef(0)
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")

  // load the expert atlas if published (measured topic affinity, #175)
  useEffect(() => {
    fetch("/experts.json").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.experts) setAtlas(d.experts)
    }).catch(() => {})
  }, [])

  // track container size for responsive cell sizing
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWrapSize({ w: el.clientWidth - 24, h: el.clientHeight - 24 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // poll /experts
  useEffect(() => {
    if (mock) { setData(mockExperts()); return }
    if (!connected) return
    let disposed = false
    const base = baseUrl.replace(/\/v1\/?$/, "")
    const poll = async () => {
      try {
        const res = await fetch(endpoint(base, "/experts"), { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} })
        const next = (await res.json()) as ExpertMap
        if (disposed || !next.rows) return
        setData(next)
        if (next.seq !== lastSeq.current && next.hits) {
          lastSeq.current = next.seq
          const n = next.rows * next.cols
          if (!pulseRef.current || pulseRef.current.length !== n) pulseRef.current = new Float32Array(n)
          const p = pulseRef.current
          for (let i = 0; i < n; i++) {
            const byte = parseInt(next.hits.substr((i >> 3) * 2, 2), 16) || 0
            if (byte & (1 << (i & 7))) p[i] = 1
          }
        }
      } catch { /* engine busy or restarting — keep the last frame */ }
    }
    void poll()
    const t = window.setInterval(() => void poll(), 1500)
    return () => { disposed = true; window.clearInterval(t) }
  }, [baseUrl, apiKey, connected, mock])

  // render loop: grid + decaying pulses
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const { rows, cols, map } = data
    const cell = Math.max(2, Math.floor(Math.min(wrapSize.w / cols, wrapSize.h / rows)))
    const gap = cell >= 4 ? 1 : 0
    canvas.width = cols * (cell + gap)
    canvas.height = rows * (cell + gap)

    // decodifica l'EMAP una volta per aggiornamento (il poll e' ogni 1.5s):
    // ri-parsare l'hex di 19k celle dentro ogni frame rAF era lavoro sprecato
    const bytes = new Uint8Array(rows * cols)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(map.substr(i * 2, 2), 16) || 0

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const p = pulseRef.current
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c
          const byte = bytes[i]
          const tier = byte >> 6
          const heat = byte & 63
          const [R, G, B] = TIER_RGB[tier] ?? TIER_RGB[0]
          // heat scales brightness: cold experts dim, hot experts full colour
          const lum = 0.35 + 0.65 * Math.min(heat / 24, 1)
          let rr = R * lum, gg = G * lum, bb = B * lum
          const pulse = p ? p[i] : 0
          if (pulse > 0.01) { rr += (255 - rr) * pulse; gg += (255 - gg) * pulse; bb += (255 - bb) * pulse }
          ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`
          ctx.fillRect(c * (cell + gap), r * (cell + gap), cell, cell)
        }
      }
      let alive = false
      if (p) for (let i = 0; i < p.length; i++) { if (p[i] > 0.01) { p[i] *= 0.94; alive = true } else p[i] = 0 }
      if (alive) rafRef.current = requestAnimationFrame(draw)
    }
    draw()
    const keepalive = window.setInterval(() => { if (!rafRef.current) draw(); rafRef.current = 0 }, 400)
    return () => { cancelAnimationFrame(rafRef.current); window.clearInterval(keepalive) }
  }, [data, wrapSize])

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!data) return
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = e.currentTarget.width / rect.width
    const scaleY = e.currentTarget.height / rect.height
    const cell = Math.max(2, Math.floor(Math.min(wrapSize.w / data.cols, wrapSize.h / data.rows)))
    const gap = cell >= 4 ? 1 : 0
    const col = Math.floor(((e.clientX - rect.left) * scaleX) / (cell + gap))
    const row = Math.floor(((e.clientY - rect.top) * scaleY) / (cell + gap))
    if (row < 0 || row >= data.rows || col < 0 || col >= data.cols) { setTip(null); return }
    const byte = parseInt(data.map.substr((row * data.cols + col) * 2, 2), 16) || 0
    setTip({ x: e.clientX, y: e.clientY, row, col, tier: byte >> 6, heat: byte & 63 })
  }

  // tier totals + routing diagnostics in a single pass over the map/hits.
  // ponytail: heat is log2-scaled (~2^heat selections), so cumulative "share"
  // uses 2^heat as the weight — good enough for a caption, not a hit counter.
  const stats = useMemo(() => {
    if (!data) return null
    const { rows, cols, map, hits } = data
    const n = rows * cols
    const totals = [0, 0, 0]
    let sum = 0, maxW = -1, maxIdx = 0, deadCum = 0
    for (let i = 0; i < n; i++) {
      const byte = parseInt(map.substr(i * 2, 2), 16) || 0
      totals[byte >> 6]++
      const heat = byte & 63
      const w = heat === 0 ? 0 : Math.pow(2, heat)
      sum += w
      if (w > maxW) { maxW = w; maxIdx = i }
      if (heat === 0) deadCum++
    }
    let routed = 0, maxRow = 0, maxRowCount = 0
    const rowCounts = new Array(rows).fill(0)
    if (hits) for (let i = 0; i < n; i++) {
      const byte = parseInt(hits.substr((i >> 3) * 2, 2), 16) || 0
      if (byte & (1 << (i & 7))) { routed++; const r = (i / cols) | 0; if (++rowCounts[r] > maxRowCount) { maxRowCount = rowCounts[r]; maxRow = r } }
    }
    return {
      totals, n,
      cum: { hotLabel: `L${realLayer((maxIdx / cols) | 0, rows)}·E${maxIdx % cols}`, hotPct: sum > 0 ? (maxW / sum) * 100 : 0, dead: deadCum, active: n - deadCum },
      turn: { maxRow, maxRowCount, routed, idle: n - routed },
    }
  }, [data])
  const totals = stats?.totals ?? [0, 0, 0]

  return (
    <div className="brain-page">
      <div className="brain-head">
        <div className="section-title"><BrainCircuit className="size-4" /> Expert Cortex — {data ? `${data.rows} layers × ${data.cols} experts` : "waiting for engine"}</div>
        <div className="brain-legend">
          <span><i style={{ background: "#4ed6a5" }} /> VRAM {totals[2].toLocaleString()}</span>
          <span><i style={{ background: "#5a9bd8" }} /> RAM {totals[1].toLocaleString()}</span>
          <span><i style={{ background: "#3a4750" }} /> Disk {totals[0].toLocaleString()}</span>
          <span><Flame className="size-3" /> brightness = routing heat</span>
          <span className="brain-pulse-hint">⚡ white flash = routed this turn</span>
        </div>
      </div>
      {data && stats ? (
        <div className="brain-diag">
          {mode === "cumulative" ? <>
            <div className="brain-stat hot"><span>Hottest expert</span><strong>{stats.cum.hotLabel} <small>{stats.cum.hotPct.toFixed(stats.cum.hotPct < 10 ? 1 : 0)}% of routing</small></strong></div>
            <div className="brain-stat"><span>Active experts</span><strong>{stats.cum.active.toLocaleString()} <small>{((stats.cum.active / stats.n) * 100).toFixed(0)}%</small></strong></div>
            <div className="brain-stat dead"><span>Never routed</span><strong>{stats.cum.dead.toLocaleString()} <small>{((stats.cum.dead / stats.n) * 100).toFixed(0)}% dead</small></strong></div>
          </> : <>
            <div className="brain-stat hot"><span>Hottest layer</span><strong>L{realLayer(stats.turn.maxRow, data.rows)} <small>{stats.turn.maxRowCount} experts fired</small></strong></div>
            <div className="brain-stat"><span>Routed this turn</span><strong>{stats.turn.routed.toLocaleString()} <small>{((stats.turn.routed / stats.n) * 100).toFixed(1)}%</small></strong></div>
            <div className="brain-stat dead"><span>Idle this turn</span><strong>{stats.turn.idle.toLocaleString()} <small>{((stats.turn.idle / stats.n) * 100).toFixed(0)}%</small></strong></div>
          </>}
          <div className="brain-toggle" role="group" aria-label="Routing window">
            <button type="button" className={mode === "cumulative" ? "active" : ""} onClick={() => setMode("cumulative")}>Cumulative</button>
            <button type="button" className={mode === "turn" ? "active" : ""} onClick={() => setMode("turn")}>This turn</button>
          </div>
        </div>
      ) : null}
      <div className="brain-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
        {data ? null : !connected ? (
          <div className="brain-placeholder"><div className="ph-inner"><BrainCircuit className="size-7" /><strong>Cortex offline</strong><p>Connect to a colibrì engine to watch expert routing light up in real time.</p></div></div>
        ) : (
          <div className="brain-placeholder"><div className="ph-inner"><LoaderCircle className="size-6 animate-spin" /><strong>Waiting for the routing table…</strong><p>The heatmap appears as soon as the model reports its expert map.</p></div></div>
        )}
      </div>
      {tip && data && (() => {
        const isMtp = tip.row === data.rows - 1
        const realLayer = isMtp ? 78 : tip.row + 3
        const entry = atlas?.[`${realLayer}:${tip.col}`]
        return (
        <div className="brain-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <div className="brain-tip-title"><Layers className="size-3" /> Layer {realLayer}{isMtp ? " (MTP)" : ""} · Expert {tip.col}</div>
          <div>Tier: <strong style={{ color: ["#8b9aa3", "#5a9bd8", "#4ed6a5"][tip.tier] }}>{TIER_NAME[tip.tier]}</strong></div>
          <div>Heat: <strong>{tip.heat === 0 ? "never routed" : `~2^${tip.heat} selections`}</strong></div>
          {entry ? <>
            <div className={entry.label.startsWith("specialist") ? "brain-tip-spec" : undefined}>
              {entry.label.startsWith("specialist") ? `⭐ Specialist: ${entry.top}` : "Generalist"}
              <small> (entropy {entry.entropy})</small>
            </div>
            <div className="brain-tip-aff">{Object.entries(entry.affinity).sort((a, b) => b[1] - a[1]).slice(0, 3)
              .map(([c, p]) => `${c} ${Math.round(p * 100)}%`).join(" · ")}</div>
          </> : <div className="brain-tip-role">{depthRole(tip.row, data.rows, isMtp)}</div>}
        </div>
        )
      })()}
    </div>
  )
}
