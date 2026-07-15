import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { BrainCircuit, Check, ChevronRight, Copy } from "lucide-react"

import { cn } from "@/lib/utils"

/* Hand-rolled markdown + reasoning renderer.
 *
 * We deliberately avoid react-markdown / a highlighter dependency: the whole
 * feature is a few hundred lines and keeps the bundle flat (see the JS-size
 * budget in the Wave-2A brief). The tradeoffs are marked with `ponytail:`. */

// ----------------------------------------------------------------------------
// syntax highlighting
// ponytail: regex tokenizer, not a real parser — it only has to LOOK right in a
// chat bubble. Upgrade path if correctness ever matters: a real grammar lib.
// ----------------------------------------------------------------------------
const KEYWORDS = new Set(
  ("const let var function return if else for while do switch case break continue class new this super " +
   "extends implements interface type enum import export from default async await try catch finally throw " +
   "typeof instanceof in of void delete yield static get set public private protected readonly abstract " +
   "def elif except lambda pass raise with as global nonlocal and or not is del assert print " +
   "int float double char bool long short unsigned signed struct union sizeof volatile extern inline " +
   "fn impl pub mod use match where move ref Some Ok Err Box Vec String Option Result usize isize " +
   "func package defer chan range select go map make " +
   "namespace using template typename virtual override final " +
   "null true false none None True False undefined nil self").split(/\s+/),
)

const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|console|yaml|yml|toml|rb|ruby|r|make|makefile|ini|conf|cfg|dockerfile|perl|pl|nim|elixir|ex)$/

function tokenize(code: string, lang: string): ReactNode[] {
  const hash = HASH_LANGS.test(lang.toLowerCase())
  const comment = hash ? "#[^\\n]*" : "//[^\\n]*|/\\*[\\s\\S]*?\\*/"
  const re = new RegExp(
    `(${comment})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d[\\w.]*\\b)|([A-Za-z_$][\\w$]*)`,
    "g",
  )
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    last = re.lastIndex
    if (m[1]) out.push(<span key={k++} className="tok-com">{m[1]}</span>)
    else if (m[2]) out.push(<span key={k++} className="tok-str">{m[2]}</span>)
    else if (m[3]) out.push(<span key={k++} className="tok-num">{m[3]}</span>)
    else if (m[4]) {
      const word = m[4]
      if (KEYWORDS.has(word)) out.push(<span key={k++} className="tok-kw">{word}</span>)
      else if (code[re.lastIndex] === "(") out.push(<span key={k++} className="tok-fn">{word}</span>)
      else out.push(word)
    }
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

// ----------------------------------------------------------------------------
// clipboard (works on plain-http localhost where navigator.clipboard is absent)
// ----------------------------------------------------------------------------
export function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  fallbackCopy(text)
  return Promise.resolve()
}
function fallbackCopy(text: string) {
  const el = document.createElement("textarea")
  el.value = text
  el.style.position = "fixed"
  el.style.opacity = "0"
  document.body.appendChild(el)
  el.select()
  try { document.execCommand("copy") } catch { /* nothing more we can do */ }
  document.body.removeChild(el)
}

function useCopied() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const fire = (text: string) => {
    void copyText(text)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1400)
  }
  return [copied, fire] as const
}

// ----------------------------------------------------------------------------
// block splitting: fenced code vs prose
// ----------------------------------------------------------------------------
type Block =
  | { t: "code"; lang: string; code: string; key: string }
  | { t: "md"; text: string; key: string }

export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n")
  const out: Block[] = []
  let prose: string[] = []
  // index-based keys keep finished blocks mounted so they never re-layout while
  // the trailing (streaming) block grows.
  const flush = () => { if (prose.length) { out.push({ t: "md", text: prose.join("\n"), key: `m${out.length}` }); prose = [] } }
  let i = 0
  while (i < lines.length) {
    const open = /^\s*```([\w+#.-]*)\s*$/.exec(lines[i])
    if (open) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++ // consume closing fence (absent while still streaming)
      out.push({ t: "code", lang: open[1] || "", code: code.join("\n"), key: `c${out.length}` })
    } else {
      prose.push(lines[i++])
    }
  }
  flush()
  return out
}

// ----------------------------------------------------------------------------
// inline markdown: `code`, **bold**, *italic*, [label](url)
// ----------------------------------------------------------------------------
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    last = INLINE.lastIndex
    if (m[1]) out.push(<code key={k++} className="md-code">{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{m[2].slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{m[3].slice(1, -1)}</em>)
    else if (m[4]) {
      const cut = m[4].indexOf("](")
      const label = m[4].slice(1, cut)
      const href = m[4].slice(cut + 2, -1)
      out.push(<a key={k++} href={href} target="_blank" rel="noreferrer noopener">{label}</a>)
    }
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ----------------------------------------------------------------------------
// prose block: headings, lists, blockquotes, rules, paragraphs
// ----------------------------------------------------------------------------
function Prose({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  const lines = text.split("\n")
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []
  let key = 0

  const flushPara = () => {
    if (!para.length) return
    nodes.push(<p key={key++}>{para.flatMap((l, ix) => (ix ? [<br key={ix} />, ...inline(l)] : inline(l)))}</p>)
    para = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((it, ix) => <li key={ix}>{inline(it)}</li>)
    nodes.push(list.ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>)
    list = null
  }
  const flushQuote = () => {
    if (!quote.length) return
    nodes.push(<blockquote key={key++}>{quote.flatMap((l, ix) => (ix ? [<br key={ix} />, ...inline(l)] : inline(l)))}</blockquote>)
    quote = []
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const bq = /^>\s?(.*)$/.exec(line)
    if (!line.trim()) { flushAll(); continue }
    if (heading) {
      flushAll()
      const level = heading[1].length
      const Tag = (`h${Math.min(level + 1, 6)}`) as "h2"
      nodes.push(<Tag key={key++}>{inline(heading[2])}</Tag>)
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll(); nodes.push(<hr key={key++} />)
    } else if (li) {
      flushPara(); flushQuote()
      const ordered = /\d/.test(li[2])
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
      list.items.push(li[3])
    } else if (bq) {
      flushPara(); flushList()
      quote.push(bq[1])
    } else {
      flushList(); flushQuote()
      para.push(line)
    }
  }
  flushAll()
  return <>{nodes}</>
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopied()
  const tokens = useMemo(() => tokenize(code, lang), [code, lang])
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <button type="button" className="code-copy" onClick={() => copy(code)} aria-label="Copy code">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{tokens}</code></pre>
    </div>
  )
}

function renderBlocks(text: string): ReactNode {
  return splitBlocks(text).map((b) =>
    b.t === "code" ? <CodeBlock key={b.key} lang={b.lang} code={b.code} /> : <Prose key={b.key} text={b.text} />)
}

// ----------------------------------------------------------------------------
// reasoning (<think>) block
// ----------------------------------------------------------------------------
function ThinkBlock({ body, answered, thinkMs, live }: {
  body: string; answered: boolean; thinkMs?: number; live: boolean
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const collapsed = override ?? answered // auto-collapse once the answer begins
  const label = thinkMs != null
    ? `Thought for ${thinkMs < 9500 ? (thinkMs / 1000).toFixed(1) : Math.round(thinkMs / 1000)}s`
    : live ? "Thinking…" : "Thought process"
  return (
    <div className={cn("think-block", collapsed && "collapsed", live && !answered && "live")}>
      <button type="button" className="think-head" onClick={() => setOverride(!collapsed)} aria-expanded={!collapsed}>
        <ChevronRight className={cn("think-caret", !collapsed && "open")} />
        <BrainCircuit className="size-3.5" />
        <span>{label}</span>
      </button>
      {!collapsed && <div className="think-body">{renderBlocks(body) || null}</div>}
    </div>
  )
}

// ----------------------------------------------------------------------------
// throttled parse source: re-parse at most every `ms` while streaming so the
// highlighter never runs per-token (keeps the render flicker-free + cheap).
// ----------------------------------------------------------------------------
function useThrottled(value: string, active: boolean, ms = 60) {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const timer = useRef<number>(0)
  useEffect(() => {
    if (!active) { window.clearTimeout(timer.current); setShown(value); return }
    const wait = ms - (Date.now() - last.current)
    if (wait <= 0) { last.current = Date.now(); setShown(value); return }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { last.current = Date.now(); setShown(value) }, wait)
    return () => window.clearTimeout(timer.current)
  }, [value, active, ms])
  return shown
}

// ----------------------------------------------------------------------------
// public renderer for an assistant message
// ----------------------------------------------------------------------------
// Thinking primes the prompt with an open <think>, so the stream arrives as
// "reasoning…</think>answer" (no opening tag). Split on the close tag; a leading
// <think> (if the model does emit one) is stripped too.
export function splitReasoning(content: string): { think: string; answer: string } | null {
  const i = content.indexOf("</think>")
  if (i < 0) return null
  return { think: content.slice(0, i).replace(/^\s*<think>/, ""), answer: content.slice(i + 8) }
}

export function Markdown({ content, streaming, reasoning, thinkMs }: {
  content: string; streaming: boolean; reasoning?: boolean; thinkMs?: number
}) {
  const shown = useThrottled(content, streaming)
  const split = splitReasoning(shown)
  // Before </think> exists, treat the whole stream as live reasoning when this
  // turn is a thinking turn.
  if (split) {
    return (
      <div className="md">
        <ThinkBlock body={split.think} answered={split.answer.trim().length > 0} thinkMs={thinkMs} live={streaming} />
        {renderBlocks(split.answer)}
      </div>
    )
  }
  if (reasoning) {
    return (
      <div className="md">
        <ThinkBlock body={shown.replace(/^\s*<think>/, "")} answered={false} live={streaming} />
      </div>
    )
  }
  return <div className="md">{renderBlocks(shown)}</div>
}

export { Fragment }
