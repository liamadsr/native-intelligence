/**
 * What the page holds right now, in counts: `window.__niPerfSnapshot()`.
 *
 * The desktop app's main window stays open for days, and a page that slows over
 * hours (10-19: every style pass ~100 ms after 13 h, fine again after a reload)
 * has piled something up. This says what, without a profiler: the elements and
 * where they sit (pages parked out of sight, the chat thread, the capture
 * panels, what was left on <body>), the animations still running, the canvases,
 * the style sheets and their rules, the realtime channels. Read it in the
 * desktop app's Web Inspector (Safari ▸ Develop ▸ the Mac ▸ Native Intelligence): the release
 * build is inspectable.
 *
 * Computed only when called (a walk of the DOM, a few ms to a few tens of ms on
 * a heavy page): nothing runs in between. It reads no text: only tag names,
 * ids, attribute names and short attribute values (a UUID reads `<id>`).
 */

export interface PerfSnapshot {
  /** When it was taken (ISO). */
  at: string
  /** Minutes since this page loaded: how long things have had to pile up. */
  uptimeMin: number
  /** Every element in the document (open shadow roots' not among them: see `shadow`). */
  elements: number
  /** Open shadow roots (an email's body) and the elements in them. */
  shadow: { roots: number; elements: number }
  /** The SVG elements among them (icons, the sky): each one styled too. */
  svgElements: number
  /** Elements under `inert`/`aria-hidden` subtrees: never seen, still styled and laid out. */
  hiddenElements: number
  /** Kept pages (chat-cards/show-tool-card.tsx): parked out of sight, docked, full screen. */
  pages: {
    /** Cards mounted at all (each has one hidden page anchor), whether or not their page is. */
    cards: number
    /** Parked and awake: styled and laid out with everything else. */
    parked: number
    parkedElements: number
    /** Parked and dormant (display: none): no style or layout work. */
    dormant: number
    dormantElements: number
    fullScreen: number
    docked: number
    /** Cards drawn in the chat's replies. */
    inline: number
    /** Of those, the ones whose page sleeps in its frame (display: none), far from what the chat shows. */
    inlineAsleep: number
    inlineAsleepElements: number
    pills: number
  }
  chat: {
    /** Message rows drawn in the thread (chat-message-list.tsx). */
    messages: number
    elements: number
  }
  /** Capture panels mounted (capture-detail-panel.tsx), and their elements. */
  capturePanels: { count: number; elements: number }
  animations: {
    total: number
    running: number
    paused: number
    finished: number
    infinite: number
    /** Under a parked page (they hold still there, but still count). */
    parked: number
    /** The names seen most, with their counts (CSS animations and transitions). */
    top: Array<[string, number]>
  }
  canvases: { count: number; megapixels: number }
  media: { audio: number; video: number; iframes: number; images: number }
  styles: {
    sheets: number
    /** Top-level and nested rules together (an @media's rules count). */
    rules: number
    /** Rules whose selector uses `:has(`: each one re-checked as the DOM under it changes. */
    hasRules: number
    styleTags: number
    adopted: number
  }
  /** Supabase realtime channels open, by topic prefix (before the first `:`). */
  realtime: { channels: number; topics: Array<[string, number]> } | null
  /** <body>'s direct children: portals and layers, with their element counts. */
  body: Array<{ label: string; elements: number }>
  /** The elements with the most direct children: where a list grows. */
  widest: Array<{ label: string; children: number; within: string | null }>
  /** Chromium only (the browser, not the desktop app's WebKit). */
  heapMB?: number
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const NOT_DRAWN = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'STYLE', 'META'])

function attrValue(value: string): string {
  const v = value.replace(UUID, '<id>')
  return v.length > 24 ? `${v.slice(0, 21)}…` : v
}

/** A short, content-free name for an element: tag, id, its first data-* attribute and first class. */
export function describeElement(el: Element): string {
  let label = el.tagName.toLowerCase()
  if (el.id) label += `#${attrValue(el.id)}`
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-') || attr.name === 'data-state' || attr.name === 'data-slot') continue
    label += attr.value ? `[${attr.name}=${attrValue(attr.value)}]` : `[${attr.name}]`
    break
  }
  const role = el.getAttribute('role')
  if (role) label += `[role=${role}]`
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
  if (cls) label += `.${cls.length > 24 ? `${cls.slice(0, 21)}…` : cls}`
  return label
}

/** The nearest ancestor worth naming (an id or a data-* attribute other than state). */
function landmark(el: Element): string | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.id || Array.from(p.attributes).some((a) => a.name.startsWith('data-') && a.name !== 'data-state' && a.name !== 'data-slot')) {
      return describeElement(p)
    }
  }
  return null
}

function countUnder(root: ParentNode, selector: string): { count: number; elements: number } {
  const roots = Array.from(root.querySelectorAll(selector))
  let elements = 0
  // A root inside another counted root is counted once, with its outer one.
  for (const el of roots) if (!roots.some((other) => other !== el && other.contains(el))) elements += el.getElementsByTagName('*').length + 1
  return { count: roots.length, elements }
}

function countRules(rules: CSSRuleList | undefined): { rules: number; hasRules: number } {
  let total = 0
  let has = 0
  if (!rules) return { rules: 0, hasRules: 0 }
  for (const rule of Array.from(rules)) {
    total += 1
    const selector = (rule as CSSStyleRule).selectorText
    if (selector && selector.includes(':has(')) has += 1
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested && nested.length) {
      const inner = countRules(nested)
      total += inner.rules
      has += inner.hasRules
    }
  }
  return { rules: total, hasRules: has }
}

function animationName(a: Animation): string {
  const named = a as Animation & { animationName?: string; transitionProperty?: string }
  if (named.animationName) return named.animationName
  if (named.transitionProperty) return `transition:${named.transitionProperty}`
  return a.id || a.constructor?.name || 'animation'
}

function topCounts(names: Iterable<string>, n: number): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n)
}

export interface PerfSnapshotSources {
  /** The realtime channels' topics, or null where there is no client. */
  realtimeTopics?: () => string[] | null
}

export function takePerfSnapshot(doc: Document = document, sources: PerfSnapshotSources = {}): PerfSnapshot {
  const all = doc.getElementsByTagName('*')
  const svg = doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', '*')

  // Hidden subtrees, outermost only.
  const hidden = countUnder(doc, '[inert], [aria-hidden="true"]')

  const parked = countUnder(doc, '[data-card-parked]:not([data-card-dormant=""])')
  const dormant = countUnder(doc, '[data-card-parked][data-card-dormant=""]')
  const inlineAsleep = countUnder(doc, '[data-chat-card] [data-card-dormant=""]')
  const chat = countUnder(doc, '.group\\/msg')
  const panels = countUnder(doc, '[data-testid="capture-detail"]')

  // Animations, if the engine lists them.
  const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations() : []
  let running = 0
  let paused = 0
  let finished = 0
  let infinite = 0
  let underParked = 0
  for (const a of animations) {
    if (a.playState === 'running') running += 1
    else if (a.playState === 'paused') paused += 1
    else if (a.playState === 'finished') finished += 1
    const effect = a.effect as KeyframeEffect | null
    if (effect?.getTiming?.().iterations === Infinity) infinite += 1
    const target = effect?.target
    if (target && target.closest?.('[data-card-parked]')) underParked += 1
  }

  let megapixels = 0
  const canvases = doc.getElementsByTagName('canvas')
  for (const c of Array.from(canvases)) megapixels += (c.width * c.height) / 1e6

  let rules = 0
  let hasRules = 0
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      const counted = countRules(sheet.cssRules)
      rules += counted.rules
      hasRules += counted.hasRules
    } catch {
      // A cross-origin sheet: its rules can't be read.
    }
  }
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []
  for (const sheet of adopted) {
    const counted = countRules(sheet.cssRules)
    rules += counted.rules
    hasRules += counted.hasRules
  }

  let realtime: PerfSnapshot['realtime'] = null
  try {
    const topics = sources.realtimeTopics?.() ?? null
    if (topics) realtime = { channels: topics.length, topics: topCounts(topics.map((t) => t.replace(/^realtime:/, '').split(':')[0]), 8) }
  } catch {
    realtime = null
  }

  // Scripts and the like hold no layout: left out.
  const body = doc.body
    ? Array.from(doc.body.children)
        .filter((el) => !NOT_DRAWN.has(el.tagName))
        .map((el) => ({ label: describeElement(el), elements: el.getElementsByTagName('*').length + 1 }))
    : []

  // The five elements with the most direct children, and the open shadow roots.
  const wide: Array<{ el: Element; children: number }> = []
  let shadowRoots = 0
  let shadowElements = 0
  for (const el of Array.from(all)) {
    if (el.shadowRoot) {
      shadowRoots += 1
      shadowElements += el.shadowRoot.querySelectorAll('*').length
    }
    const children = el.childElementCount
    if (children < 20) continue
    if (wide.length < 5 || children > wide[wide.length - 1].children) {
      wide.push({ el, children })
      wide.sort((a, b) => b.children - a.children)
      if (wide.length > 5) wide.pop()
    }
  }

  const heap = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number } } | undefined)?.memory

  return {
    at: new Date().toISOString(),
    uptimeMin: Math.round((globalThis.performance?.now() ?? 0) / 60_000),
    elements: all.length,
    shadow: { roots: shadowRoots, elements: shadowElements },
    svgElements: svg.length,
    hiddenElements: hidden.elements,
    pages: {
      cards: doc.querySelectorAll('[data-card-body-anchor]').length,
      parked: parked.count,
      parkedElements: parked.elements,
      dormant: dormant.count,
      dormantElements: dormant.elements,
      fullScreen: doc.querySelectorAll('[data-chat-card-fullscreen]').length,
      docked: doc.querySelectorAll('[data-chat-card-docked]').length,
      inline: doc.querySelectorAll('[data-chat-card]:not([data-chat-card-docked])').length,
      inlineAsleep: inlineAsleep.count,
      inlineAsleepElements: inlineAsleep.elements,
      pills: doc.querySelectorAll('[data-chat-card-pill]').length,
    },
    chat: { messages: chat.count, elements: chat.elements },
    capturePanels: { count: panels.count, elements: panels.elements },
    animations: {
      total: animations.length,
      running,
      paused,
      finished,
      infinite,
      parked: underParked,
      top: topCounts(animations.map(animationName), 5),
    },
    canvases: { count: canvases.length, megapixels: Math.round(megapixels * 10) / 10 },
    media: {
      audio: doc.getElementsByTagName('audio').length,
      video: doc.getElementsByTagName('video').length,
      iframes: doc.getElementsByTagName('iframe').length,
      images: doc.getElementsByTagName('img').length,
    },
    styles: {
      sheets: doc.styleSheets.length + adopted.length,
      rules,
      hasRules,
      styleTags: doc.getElementsByTagName('style').length,
      adopted: adopted.length,
    },
    realtime,
    body,
    widest: wide.map(({ el, children }) => ({ label: describeElement(el), children, within: landmark(el) })),
    ...(heap ? { heapMB: Math.round(heap.usedJSHeapSize / 1e6) } : {}),
  }
}

/**
 * What changes in the page over a while: `window.__niPerfChurn(seconds)`.
 * A snapshot says how much there is to style; this says what keeps asking
 * for it. A `<style>` going in or out, or an attribute on <html>/<body>,
 * restyles the whole window; a class or style written over and over restyles
 * the element (and what inherits from it) every time.
 */
export interface PerfChurn {
  seconds: number
  /** Attribute writes, childList changes and text changes seen. */
  mutations: { attributes: number; childList: number; text: number }
  /** <style>/<link> elements added or removed anywhere: each one a whole-window restyle. */
  styleSheetChanges: number
  /** Attribute writes on <html> or <body>, by name. */
  root: Array<[string, number]>
  /** The elements written to most (attribute@element), with how many elements sit under each. */
  topAttributes: Array<{ label: string; writes: number; subtree: number }>
  /** The parents whose children changed most. */
  topChildLists: Array<{ label: string; changes: number; subtree: number }>
  animationsRunning: number
}

export function watchPerfChurn(doc: Document = document, ms = 10_000): Promise<PerfChurn> {
  const attrs = new Map<Element, Map<string, number>>()
  const lists = new Map<Node, number>()
  const root = new Map<string, number>()
  const mutations = { attributes: 0, childList: 0, text: 0 }
  let styleSheetChanges = 0
  const observer = new MutationObserver((records) => {
    for (const m of records) {
      if (m.type === 'attributes') {
        mutations.attributes += 1
        const el = m.target as Element
        const name = m.attributeName ?? '?'
        if (el === doc.documentElement || el === doc.body) root.set(`${el.tagName.toLowerCase()}@${name}`, (root.get(`${el.tagName.toLowerCase()}@${name}`) ?? 0) + 1)
        const byName = attrs.get(el) ?? new Map<string, number>()
        byName.set(name, (byName.get(name) ?? 0) + 1)
        attrs.set(el, byName)
      } else if (m.type === 'childList') {
        mutations.childList += 1
        lists.set(m.target, (lists.get(m.target) ?? 0) + 1)
        for (const n of [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]) if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') styleSheetChanges += 1
      } else {
        mutations.text += 1
        if (m.target.parentNode?.nodeName === 'STYLE') styleSheetChanges += 1
      }
    }
  })
  observer.observe(doc, { subtree: true, attributes: true, childList: true, characterData: true })
  return new Promise((resolve) => {
    setTimeout(() => {
      observer.disconnect()
      const size = (n: Node) => (n.nodeType === 1 ? (n as Element).getElementsByTagName('*').length + 1 : 0)
      const topAttributes = [...attrs]
        .flatMap(([el, byName]) => [...byName].map(([name, writes]) => ({ label: `${name}@${describeElement(el)}`, writes, subtree: size(el) })))
        .sort((a, b) => b.writes - a.writes)
        .slice(0, 8)
      const topChildLists = [...lists]
        .map(([n, changes]) => ({ label: n.nodeType === 1 ? describeElement(n as Element) : n.nodeName, changes, subtree: size(n) }))
        .sort((a, b) => b.changes - a.changes)
        .slice(0, 8)
      resolve({
        seconds: ms / 1000,
        mutations,
        styleSheetChanges,
        root: [...root].sort((a, b) => b[1] - a[1]),
        topAttributes,
        topChildLists,
        animationsRunning: typeof doc.getAnimations === 'function' ? doc.getAnimations().filter((a) => a.playState === 'running').length : 0,
      })
    }, ms)
  })
}

declare global {
  interface Window {
    __niPerfSnapshot?: () => PerfSnapshot
    __niPerfChurn?: (seconds?: number) => Promise<PerfChurn>
  }
}

/** Puts `window.__niPerfSnapshot` and `__niPerfChurn` on the page; returns their removal. */
export function installPerfSnapshot(sources: PerfSnapshotSources = {}): () => void {
  if (typeof window === 'undefined') return () => {}
  const snapshot = () => takePerfSnapshot(document, sources)
  const churn = (seconds = 10) => watchPerfChurn(document, Math.max(1, Math.min(120, seconds)) * 1000)
  window.__niPerfSnapshot = snapshot
  window.__niPerfChurn = churn
  return () => {
    if (window.__niPerfSnapshot === snapshot) delete window.__niPerfSnapshot
    if (window.__niPerfChurn === churn) delete window.__niPerfChurn
  }
}
