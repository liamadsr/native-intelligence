'use client'

/**
 * A PDF, in the browser, with pdf.js (Apache-2.0, the build `unpdf` ships, so
 * no second copy of pdf.js): every page in one scrolling column, each drawn
 * when it nears the screen and dropped when it is far away.
 *
 *   Zoom        out, in, fit to width (the default), and ⌘/Ctrl + / −.
 *   Pages       a thumbnail rail (toggle), a "page n of m" box that jumps.
 *   Find        ⌘/Ctrl F or the search button: every match across the
 *               document, Enter / Shift+Enter for the next and the previous,
 *               the current one marked on its page (its text layer).
 *   Text        selectable and copyable, through pdf.js's text layer.
 *   Overlay     a slot drawn over each page (phase 4's comment pins), given
 *               the page's number and size on screen.
 *
 * The document is read from its bytes only. No script in it runs (pdf.js
 * runs none: this viewer has no scripting layer), its links are not followed
 * (no annotation layer), and no font or file is fetched from anywhere.
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, Loader2, Minus, PanelLeft, Plus, Search, X } from 'lucide-react'
import { findInPages, matchSpans, pageTextOf, type FindMatch } from '@/lib/files/find-text'
import { cn } from '@/lib/utils'

type PdfJs = typeof import('unpdf/pdfjs')
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>

/** What phase 4 draws over a page: comment pins and the "place a comment" layer. */
export type PdfPageOverlay = (page: { pageNumber: number; width: number; height: number }) => React.ReactNode

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const ZOOM_STEP = 1.2
const PAGE_GAP = 16

/** The zoom after one step in or out, clamped. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  const next = dir > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 100) / 100))
}

let pdfjsPromise: Promise<PdfJs> | null = null
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('unpdf/pdfjs')
  return pdfjsPromise
}

// pdf.js's text layer, written for this viewer: spans are invisible but
// selectable, sized from the variables pdf.js sets on them.
const TEXT_LAYER_CSS = `
.ni-pdf-text{position:absolute;inset:0;overflow:hidden;line-height:1;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
.ni-pdf-text span,.ni-pdf-text br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.ni-pdf-text>span,.ni-pdf-text .markedContent span{font-size:calc(var(--text-scale-factor) * var(--font-height,0px));transform:rotate(var(--rotate,0deg)) scaleX(var(--scale-x,1)) scale(var(--min-font-size-inv))}
.ni-pdf-text .markedContent{display:contents}
.ni-pdf-text ::selection{background:rgba(37,99,235,.3)}
.ni-pdf-text mark{background:rgba(250,204,21,.5);color:transparent;border-radius:2px}
.ni-pdf-text mark[data-current]{background:rgba(249,115,22,.65)}
`

export default function PdfViewer({ blob, overlay, jump }: { blob: Blob; overlay?: PdfPageOverlay; jump?: { page: number; n: number } | null }) {
  const [pdfjs, setPdfjs] = React.useState<PdfJs | null>(null)
  const [doc, setDoc] = React.useState<PdfDoc | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [baseSize, setBaseSize] = React.useState<{ width: number; height: number } | null>(null)
  const [scale, setScale] = React.useState<number | null>(null) // null: fit to width
  const [thumbs, setThumbs] = React.useState(false)
  const [current, setCurrent] = React.useState(1)
  const [width, setWidth] = React.useState(0)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pageEls = React.useRef(new Map<number, HTMLDivElement>())

  // Load the document.
  React.useEffect(() => {
    let live = true
    let loaded: PdfDoc | null = null
    let task: ReturnType<PdfJs['getDocument']> | null = null
    void (async () => {
      try {
        const lib = await loadPdfJs()
        const data = new Uint8Array(await blob.arrayBuffer())
        task = lib.getDocument({ data, stopAtErrors: false, disableFontFace: false, useSystemFonts: false })
        loaded = await task.promise
        const first = await loaded.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        if (!live) return
        setPdfjs(lib)
        setBaseSize({ width: vp.width, height: vp.height })
        setDoc(loaded)
      } catch (err) {
        if (!live) return
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
        setError(name === 'PasswordException' ? 'This PDF is protected by a password. Download it to open it.' : 'This PDF could not be read.')
      }
    })()
    return () => {
      live = false
      void task?.destroy()
    }
  }, [blob])

  // The column's width, for "fit to width".
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [doc])

  const fitScale = baseSize && width ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, (width - 48) / baseSize.width)) : 1
  const effective = scale ?? fitScale

  // Which page is in view.
  React.useEffect(() => {
    const root = scrollRef.current
    if (!root || !doc) return
    const seen = new Map<number, number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(Number((e.target as HTMLElement).dataset.pdfPage), e.intersectionRatio)
        let best = 0
        let at = 1
        for (const [n, r] of seen) if (r > best) [best, at] = [r, n]
        if (best > 0) setCurrent(at)
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    for (const el of pageEls.current.values()) io.observe(el)
    return () => io.disconnect()
  }, [doc, effective])

  const goTo = React.useCallback((n: number) => {
    const el = pageEls.current.get(n)
    const root = scrollRef.current
    if (el && root) root.scrollTo({ top: el.offsetTop - 12, behavior: 'auto' })
  }, [])

  // Asked to show a page (a comment's thread): scroll to it.
  React.useEffect(() => {
    if (jump && doc) goTo(Math.min(Math.max(1, jump.page), doc.numPages))
  }, [jump, doc, goTo])

  // Find.
  const [finding, setFinding] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [texts, setTexts] = React.useState<{ text: string; starts: number[]; strs: string[] }[] | null>(null)
  const [matchAt, setMatchAt] = React.useState(0)
  const findInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (!finding || !doc || texts) return
    let live = true
    void (async () => {
      const out: { text: string; starts: number[]; strs: string[] }[] = []
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n)
        const content = await page.getTextContent()
        const items = content.items.filter((i): i is { str: string; hasEOL: boolean } & typeof i => 'str' in i)
        out.push({ ...pageTextOf(items), strs: items.map((i) => i.str) })
        if (!live) return
      }
      if (live) setTexts(out)
    })()
    return () => {
      live = false
    }
  }, [finding, doc, texts])
  const matches = React.useMemo<FindMatch[]>(() => (texts && query.trim() ? findInPages(texts.map((t) => t.text), query) : []), [texts, query])
  React.useEffect(() => setMatchAt(0), [query])
  const active = matches[matchAt] ?? null
  React.useEffect(() => {
    if (active) goTo(active.page)
  }, [active, goTo])
  const stepMatch = (dir: 1 | -1) => matches.length && setMatchAt((i) => (i + dir + matches.length) % matches.length)

  // Keys: find, zoom.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFinding(true)
        requestAnimationFrame(() => findInput.current?.select())
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setScale((s) => stepZoom(s ?? fitScale, 1))
      } else if (mod && e.key === '-') {
        e.preventDefault()
        setScale((s) => stepZoom(s ?? fitScale, -1))
      } else if (mod && e.key === '0') {
        e.preventDefault()
        setScale(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fitScale])

  if (error) return <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">{error}</div>
  if (!doc || !pdfjs || !baseSize)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    )

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1)
  const pageMatches = (n: number) => matches.filter((m) => m.page === n)
  return (
    <div className="flex h-full flex-col" data-file-viewer-pdf="">
      <style>{TEXT_LAYER_CSS}</style>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1 text-xs">
        <ToolButton label={thumbs ? 'Hide pages' : 'Show pages'} pressed={thumbs} onClick={() => setThumbs((t) => !t)}>
          <PanelLeft className="size-3.5" />
        </ToolButton>
        <PageBox current={current} total={doc.numPages} onGo={goTo} />
        <div className="mx-auto flex items-center gap-1">
          <ToolButton label="Zoom out" onClick={() => setScale(stepZoom(effective, -1))}>
            <Minus className="size-3.5" />
          </ToolButton>
          <button type="button" data-pdf-zoom="" onClick={() => setScale(null)} title="Fit to width" className="h-7 min-w-14 rounded-md px-2 tabular-nums text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            {Math.round(effective * 100)}%
          </button>
          <ToolButton label="Zoom in" onClick={() => setScale(stepZoom(effective, 1))}>
            <Plus className="size-3.5" />
          </ToolButton>
        </div>
        {finding ? (
          <div className="flex items-center gap-1" data-pdf-find="">
            <input
              ref={findInput}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepMatch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              placeholder="Find in document"
              aria-label="Find in document"
              className="h-7 w-44 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-foreground/30"
            />
            <span className="w-16 text-center tabular-nums text-muted-foreground" data-pdf-find-count="">
              {!query.trim() ? '' : !texts ? '…' : matches.length ? `${matchAt + 1} of ${matches.length}` : 'None'}
            </span>
            <ToolButton label="Previous match" onClick={() => stepMatch(-1)}>
              <ChevronUp className="size-3.5" />
            </ToolButton>
            <ToolButton label="Next match" onClick={() => stepMatch(1)}>
              <ChevronDown className="size-3.5" />
            </ToolButton>
            <ToolButton
              label="Close find"
              onClick={() => {
                setFinding(false)
                setQuery('')
              }}
            >
              <X className="size-3.5" />
            </ToolButton>
          </div>
        ) : (
          <ToolButton label="Find in document" onClick={() => setFinding(true)}>
            <Search className="size-3.5" />
          </ToolButton>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {thumbs && (
          <nav aria-label="Pages" className="w-36 shrink-0 overflow-y-auto border-r border-border bg-background p-2" data-pdf-thumbs="">
            {pages.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => goTo(n)}
                aria-current={n === current ? 'page' : undefined}
                className={cn('mb-2 block w-full rounded-md p-1 text-center', n === current ? 'bg-foreground/[0.08]' : 'hover:bg-muted/60')}
              >
                <Thumbnail doc={doc} pageNumber={n} base={baseSize} />
                <span className="text-[10px] tabular-nums text-muted-foreground">{n}</span>
              </button>
            ))}
          </nav>
        )}
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-auto" data-pdf-scroll="">
          <div className="flex flex-col items-center py-4" style={{ gap: PAGE_GAP }}>
            {pages.map((n) => (
              <PageView
                key={n}
                doc={doc}
                pdfjs={pdfjs}
                pageNumber={n}
                scale={effective}
                base={baseSize}
                root={scrollRef}
                matches={pageMatches(n)}
                activeIndex={active?.page === n ? active.index : -1}
                texts={texts?.[n - 1] ?? null}
                overlay={overlay}
                register={(el) => (el ? pageEls.current.set(n, el) : pageEls.current.delete(n))}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground', pressed && 'bg-foreground/[0.08] text-foreground')}
    >
      {children}
    </button>
  )
}

function PageBox({ current, total, onGo }: { current: number; total: number; onGo: (n: number) => void }) {
  const [typed, setTyped] = React.useState<string | null>(null)
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <input
        aria-label="Page"
        data-pdf-page-input=""
        value={typed ?? String(current)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => setTyped(null)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const n = Number(typed)
          if (n >= 1 && n <= total) onGo(n)
          setTyped(null)
          ;(e.target as HTMLInputElement).blur()
        }}
        className="h-7 w-10 rounded-md border border-border bg-background text-center tabular-nums outline-none focus:border-foreground/30"
      />
      <span className="tabular-nums">of {total}</span>
    </span>
  )
}

/** Is `el` within a screen or so of the scroll box? */
function useNear(el: React.RefObject<HTMLElement | null>, root: React.RefObject<HTMLElement | null>, margin = '800px'): boolean {
  const [near, setNear] = React.useState(false)
  React.useEffect(() => {
    if (!el.current) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: `${margin} 0px` })
    io.observe(el.current)
    return () => io.disconnect()
  }, [el, root, margin])
  return near
}

function PageView({
  doc,
  pdfjs,
  pageNumber,
  scale,
  base,
  root,
  matches,
  activeIndex,
  texts,
  overlay,
  register,
}: {
  doc: PdfDoc
  pdfjs: PdfJs
  pageNumber: number
  scale: number
  base: { width: number; height: number }
  root: React.RefObject<HTMLDivElement | null>
  matches: FindMatch[]
  activeIndex: number
  texts: { text: string; starts: number[]; strs: string[] } | null
  overlay?: PdfPageOverlay
  register: (el: HTMLDivElement | null) => void
}) {
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const textRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState<{ width: number; height: number }>({ width: base.width * scale, height: base.height * scale })
  const [textReady, setTextReady] = React.useState(0)
  const near = useNear(boxRef, root)
  const pageRef = React.useRef<PdfPage | null>(null)
  // The text layer's spans, one per text item (an empty one is never put on the page).
  const divsRef = React.useRef<HTMLElement[]>([])

  React.useEffect(() => {
    if (!near) {
      // Far away: let the canvas go, keep the page's place.
      const c = canvasRef.current
      if (c) {
        c.width = 0
        c.height = 0
      }
      if (textRef.current) textRef.current.replaceChildren()
      divsRef.current = []
      return
    }
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null
    let textLayer: { cancel: () => void } | null = null
    void (async () => {
      const page = pageRef.current ?? (await doc.getPage(pageNumber))
      pageRef.current = page
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      setSize({ width: viewport.width, height: viewport.height })
      const canvas = canvasRef.current
      if (!canvas) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      renderTask = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      try {
        await renderTask.promise
      } catch {
        return // cancelled
      }
      if (cancelled || !textRef.current) return
      const container = textRef.current
      container.replaceChildren()
      container.style.setProperty('--total-scale-factor', String(scale))
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport })
      textLayer = layer
      try {
        await layer.render()
        divsRef.current = layer.textDivs
        if (!cancelled) setTextReady((n) => n + 1)
      } catch {
        /* cancelled */
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [near, doc, pdfjs, pageNumber, scale])

  // Mark find matches on the page's text layer.
  React.useEffect(() => {
    const container = textRef.current
    if (!container) return
    const spans = divsRef.current
    // Undo the last marks: each span back to its own words.
    for (const [i, span] of spans.entries()) if (span.querySelector('mark') && texts?.strs[i] !== undefined) span.textContent = texts.strs[i]
    if (!texts || !matches.length) return
    if (spans.length !== texts.strs.length) return // the layer and the text disagree: mark nothing rather than the wrong words
    const byItem = new Map<number, { from: number; to: number; current: boolean }[]>()
    for (const m of matches) {
      for (const part of matchSpans(texts.starts, texts.strs, m.offset, m.length)) {
        const list = byItem.get(part.item) ?? []
        list.push({ from: part.from, to: part.to, current: m.index === activeIndex })
        byItem.set(part.item, list)
      }
    }
    for (const [item, parts] of byItem) {
      const span = spans[item]
      const str = span.textContent ?? ''
      if (str !== texts.strs[item]) continue
      span.replaceChildren()
      let at = 0
      for (const p of parts.sort((a, b) => a.from - b.from)) {
        if (p.from < at) continue
        if (p.from > at) span.append(document.createTextNode(str.slice(at, p.from)))
        const mark = document.createElement('mark')
        mark.textContent = str.slice(p.from, p.to)
        if (p.current) mark.setAttribute('data-current', '')
        span.append(mark)
        at = p.to
      }
      if (at < str.length) span.append(document.createTextNode(str.slice(at)))
    }
    if (activeIndex >= 0) container.querySelector('mark[data-current]')?.scrollIntoView({ block: 'center' })
  }, [texts, matches, activeIndex, textReady])

  return (
    <div
      ref={(el) => {
        boxRef.current = el
        register(el)
      }}
      data-pdf-page={pageNumber}
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/5"
      style={{ width: size.width, height: size.height }}
    >
      <canvas ref={canvasRef} aria-label={`Page ${pageNumber}`} role="img" className="absolute inset-0" />
      <div ref={textRef} className="ni-pdf-text" />
      {overlay?.({ pageNumber, width: size.width, height: size.height })}
    </div>
  )
}

function Thumbnail({ doc, pageNumber, base }: { doc: PdfDoc; pageNumber: number; base: { width: number; height: number } }) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const box = React.useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = React.useState(false)
  const width = 112
  const height = Math.round((base.height / base.width) * width)
  React.useEffect(() => {
    if (drawn || !box.current) return
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null
    let cancelled = false
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      void (async () => {
        const page = await doc.getPage(pageNumber)
        const vp1 = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / vp1.width })
        const canvas = ref.current
        if (!canvas || cancelled) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        task = page.render({ canvas, viewport })
        try {
          await task.promise
          if (!cancelled) setDrawn(true)
        } catch {
          /* cancelled */
        }
      })()
    })
    io.observe(box.current)
    return () => {
      cancelled = true
      io.disconnect()
      task?.cancel()
    }
  }, [doc, pageNumber, drawn])
  return (
    <div ref={box} className="mx-auto mb-1 bg-white ring-1 ring-black/10" style={{ width, height }}>
      <canvas ref={ref} className="h-full w-full" />
    </div>
  )
}
