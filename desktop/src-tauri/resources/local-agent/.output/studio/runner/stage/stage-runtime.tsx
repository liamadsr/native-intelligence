// The stage page that mounts a product's components outside the product (bundled with the product's own React).
// It stands in for the app around a component, so the component renders the way it does in the app:
//  - the app's providers wrap it (each one skipped on its own if it can't start here);
//  - a stand-in backend answers the app's API calls with sample data read from the app's own route types, Supabase
//    with empty results, and anything else with an "empty" value that is safe to read, map and render;
//  - the app's theme (dark class, root classes, html attributes) and a sized box that h-full layouts can fill.
// The job comes in the URL hash: {component, props, width, height (0 = natural), theme, pad, preview}.
import React, { Component, Suspense, lazy, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createDomDriver, createPlayer, describeTargets, type ScriptStep } from './kit-script.js'
import { rowsFromSelect } from './kit-world.js'

type Loader = () => Promise<Record<string, unknown>>
type ProviderSpec = { name: string; load: Loader; export: string; props?: Record<string, unknown> }
/** A kit's own answers for endpoints whose shape depends on the request (a generic query endpoint, say). */
export type BackendRequest = { method: string; path: string; query: URLSearchParams; body: any }
export type BackendContext = {
  rows: (select: string, table: string, n: number) => Record<string, unknown>[]
  selects: Record<string, string>
  sample?: unknown
}
type Adapter = (request: BackendRequest, context: BackendContext) => unknown
type Options = {
  loaders: Record<string, { load: Loader; export: string }>
  providers: ProviderSpec[]
  rootClass?: string
  previewClass?: string
  htmlAttributes?: Record<string, string>
  backend?: () => Promise<{ default: Adapter }>
}
type Route = { method: string; pattern: string; sample: unknown; re: RegExp }
const w = window as unknown as Record<string, any>

// ------------------------------------------------------------------------------------------------------------ values
function Icon({ className, size, style }: { className?: string; size?: number; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? '1em'}
      height={size ?? '1em'}
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M9 12h6" />
    </svg>
  )
}
export function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive)
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if ('$fn' in o) return o.async ? async () => undefined : () => undefined
  if ('$date' in o) return new Date(String(o.$date))
  if ('$set' in o) return new Set(revive(o.$set) as unknown[])
  if ('$map' in o) return new Map(revive(o.$map) as [unknown, unknown][])
  if ('$icon' in o) return Icon
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]))
}
/** A value that is safe to read anything from: an empty array whose unknown properties are more of the same. */
function empty(): unknown {
  return new Proxy([] as unknown[], {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) return Reflect.get(t, k)
      if (k === 'then' || k === 'toJSON' || k === '$$typeof' || k === 'constructor' || k === 'nodeType') return undefined
      return empty()
    },
  })
}

// ----------------------------------------------------------------------------------------------------------- backend
function installBackend(routes: Route[], adapter: Adapter | null, selects: Record<string, string>) {
  const real = window.fetch.bind(window)
  w.__pending = 0
  w.__calls = [] as { method: string; path: string; answer: string }[]
  const note = (method: string, url: URL, answer: string) => {
    if (w.__calls.length < 200) w.__calls.push({ method, path: url.pathname + url.search, answer })
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, location.href)
    if (url.origin !== location.origin || url.pathname.startsWith('/__stage/')) return real(input, init)
    const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' && /\.[a-z0-9]{2,5}$/i.test(url.pathname) && !url.pathname.startsWith('/api/')) return real(input, init)
    w.__pending++
    try {
      // Answered right away (no timer): on a capture's paused clock, data arrives without time passing.
      await Promise.resolve()
      const accept = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)).get('accept') ?? ''
      if (url.pathname.startsWith('/rest/v1/')) {
        // A database read: rows shaped by the columns it selects; writes answer with what they were given.
        note(method, url, 'database')
        const table = url.pathname.slice(9).split('/')[0] ?? 'row',
          single = accept.includes('vnd.pgrst.object')
        if (method !== 'GET' && method !== 'HEAD') return json(single ? {} : [])
        if (url.pathname.startsWith('/rest/v1/rpc/')) return json([])
        const rows = rowsFromSelect(url.searchParams.get('select') ?? '*', table, single ? 1 : Math.min(Number(url.searchParams.get('limit')) || 5, 8))
        return json(single ? rows[0] : rows)
      }
      if (url.pathname.startsWith('/auth/v1/')) return json({})
      if (url.pathname.startsWith('/storage/v1/') || url.pathname.startsWith('/functions/v1/')) return json({})
      const hit =
        routes.find((r) => r.method === method && r.re.test(url.pathname)) ??
        (method === 'HEAD' ? routes.find((r) => r.method === 'GET' && r.re.test(url.pathname)) : undefined)
      if (adapter) {
        let body: unknown = undefined
        try {
          const raw = init?.body ?? (typeof input === 'object' && 'body' in input ? await (input as Request).clone().text() : undefined)
          body = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          /* not JSON */
        }
        try {
          const answer = adapter({ method, path: url.pathname, query: url.searchParams, body }, { rows: rowsFromSelect, selects, sample: hit?.sample })
          if (answer !== undefined) {
            note(method, url, 'kit')
            return json(answer)
          }
        } catch (e) {
          console.warn('[stage] backend adapter failed', e)
        }
      }
      note(method, url, hit ? hit.pattern : 'none')
      if (hit) return json(structuredClone(hit.sample))
      if (method !== 'GET') return json({ ok: true })
      const response = json({})
      Object.defineProperty(response, 'json', { value: async () => empty() })
      return response
    } finally {
      w.__pending--
    }
  }
  // Live channels (Supabase realtime, server-sent events) stay quiet: nothing to connect to here.
  const RealSocket = window.WebSocket
  class QuietSocket extends EventTarget {
    readyState = 0
    url: string
    protocol = ''
    bufferedAmount = 0
    extensions = ''
    binaryType = 'blob'
    onopen = null
    onclose = null
    onerror = null
    onmessage = null
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url: string | URL) {
      super()
      this.url = String(url)
    }
    send() {}
    close() {
      this.readyState = 3
    }
  }
  w.WebSocket = new Proxy(RealSocket, {
    construct(target, args) {
      const u = new URL(String(args[0]), location.href)
      return u.host === location.host ? new QuietSocket(u) : Reflect.construct(target, args)
    },
  })
  class QuietEvents extends EventTarget {
    readyState = 0
    url: string
    withCredentials = false
    onopen = null
    onmessage = null
    onerror = null
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    constructor(url: string | URL) {
      super()
      this.url = String(url)
    }
    close() {
      this.readyState = 2
    }
  }
  w.EventSource = QuietEvents
  navigator.sendBeacon = () => true
}

/** The page's "now" becomes the sample data's now (it keeps ticking), so relative times read naturally. */
function shiftClock(now: number) {
  const Real = Date,
    shift = now - Real.now()
  class ShiftedDate extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(Real.now() + shift)
      else super(...(args as [string]))
    }
    static now() {
      return Real.now() + shift
    }
  }
  w.Date = ShiftedDate
}

// ------------------------------------------------------------------------------------------------------------- mount
class Guard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  componentDidCatch() {
    w.__status = 'error: ' + this.state.error
  }
  render() {
    return this.state.error ? (
      <div style={{ font: '12px ui-monospace, monospace', color: '#b42318', padding: 12, whiteSpace: 'pre-wrap' }}>
        This component needs more of the app around it to render here:{'\n'}
        {this.state.error}
      </div>
    ) : (
      this.props.children
    )
  }
}
/** One of the app's providers. If it can't start outside the app it steps aside and the rest still render. */
class SafeProvider extends Component<{ name: string; wrap: (children: ReactNode) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.warn(`[stage] ${this.props.name} skipped: ${e instanceof Error ? e.message : e}`)
    ;(w.__skipped ??= []).push(this.props.name)
  }
  render() {
    return this.state.failed ? this.props.children : this.props.wrap(this.props.children)
  }
}
function Ready({ children }: { children: ReactNode }) {
  useEffect(() => {
    w.__status ??= 'ok'
    w.__mounted = true
  }, [])
  return <>{children}</>
}

/** An interaction script on the stage. A capture drives it (window.__scriptAt(t) → the input it performs for real);
 *  the gallery preview plays it live with DOM events, then replays from the start. */
function setupScript(job: { script?: ScriptStep[]; cursor?: boolean; drive?: string }) {
  if (!job.script?.length) return
  let player: ReturnType<typeof createPlayer> | null = null
  const get = () => (player ??= createPlayer(job.script!, document.getElementById('cap')!, { cursor: job.cursor }))
  w.__scriptAt = (t: number) => get().at(t)
  w.__scriptEnd = () => get().end
  if (job.drive === 'capture') return
  const drive = createDomDriver()
  const begin = () => {
    const start = performance.now()
    const tick = () => {
      const t = performance.now() - start
      drive(get().at(t))
      if (t < get().end + 1600) requestAnimationFrame(tick)
      else location.reload()
    }
    requestAnimationFrame(tick)
  }
  const wait = () => (w.__mounted && !w.__pending ? setTimeout(begin, 900) : setTimeout(wait, 100))
  wait()
}

export async function mountStage(options: Options) {
  const job = JSON.parse(decodeURIComponent(location.hash.slice(1) || '{}')) as {
    component?: string
    props?: Record<string, unknown>
    width?: number
    height?: number
    theme?: string
    pad?: number
    preview?: boolean
    script?: ScriptStep[]
    cursor?: boolean
    drive?: string
  }
  window.addEventListener('hashchange', () => location.reload())
  const html = document.documentElement
  for (const [k, v] of Object.entries(options.htmlAttributes ?? {})) html.setAttribute(k, v)
  html.classList.toggle('dark', job.theme === 'dark')
  html.style.colorScheme = job.theme === 'dark' ? 'dark' : 'light'
  for (const c of (options.rootClass ?? '').split(/\s+/).filter(Boolean)) document.body.classList.add(c)
  if (job.preview) for (const c of (options.previewClass ?? '').split(/\s+/).filter(Boolean)) document.body.classList.add(c)
  else document.body.style.background = 'transparent'

  const backend = (await fetch('backend.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))) as { now?: number; routes?: Omit<Route, 're'>[] }
  if (backend.now) shiftClock(backend.now)
  const routes = backend.routes ?? []
  const adapter = options.backend
    ? await options
        .backend()
        .then((m) => m.default)
        .catch((e) => {
          console.warn('[stage] backend adapter unavailable', e)
          return null
        })
    : null
  const selects = (await fetch('selects.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))) as Record<string, string>
  installBackend(
    routes.map((r) => ({
      ...r,
      re: new RegExp(
        '^' +
          r.pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/:[^/]+/g, '[^/]+')
            .replace(/\*/g, '.*') +
          '/?$',
      ),
    })),
    adapter,
    selects,
  )

  const providers = (
    await Promise.all(
      options.providers.map((p) =>
        p
          .load()
          .then((m) => ({ ...p, C: (m[p.export] ?? m.default) as React.ComponentType<any> }))
          .catch((e) => {
            console.warn(`[stage] ${p.name} unavailable: ${e?.message ?? e}`)
            return null
          }),
      ),
    )
  ).filter((p) => p?.C) as (ProviderSpec & { C: React.ComponentType<any> })[]

  const entry = job.component ? options.loaders[job.component] : undefined
  const Comp = entry
    ? lazy(() => entry.load().then((m) => ({ default: (m[entry.export] ?? m.default) as React.ComponentType<any> })))
    : () => <div>Unknown component</div>
  let tree: ReactNode = (
    <Guard>
      <Suspense fallback={null}>
        <Ready>
          <Comp {...(revive(job.props ?? {}) as Record<string, unknown>)} />
        </Ready>
      </Suspense>
    </Guard>
  )
  for (const p of [...providers].reverse()) {
    const inner = tree
    tree = (
      <SafeProvider key={p.name} name={p.name} wrap={(c) => <p.C {...(revive(p.props ?? {}) as Record<string, unknown>)}>{c}</p.C>}>
        {inner}
      </SafeProvider>
    )
  }

  // How often the page changed: lazily loaded parts (a card's page, a chart) keep it changing after the first mount,
  // so "settled" means mounted, no data calls in flight, and no changes for a moment (counted, not timed: a capture
  // runs on a paused virtual clock).
  w.__changes = 0
  /** Still showing a loading placeholder (a Suspense fallback, a busy region)? */
  w.__loading = () =>
    !!document.querySelector('#cap [aria-busy="true"]') ||
    Array.from(document.querySelectorAll('#cap *')).some((el) => el.children.length === 0 && /^loading(…|\.\.\.)?$/i.test((el.textContent ?? '').trim()))
  new MutationObserver(() => {
    w.__changes++
  }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  setupScript(job)
  w.__describe = () => describeTargets(document.getElementById('cap')!)
  const natural = !job.height
  createRoot(document.getElementById('root')!).render(
    <div
      id="cap"
      className={options.rootClass}
      style={{ width: job.width ?? 720, height: natural ? 'auto' : job.height, padding: job.pad ?? 0, boxSizing: 'content-box', position: 'relative' }}
    >
      <div
        id="fit"
        style={{
          width: '100%',
          height: natural ? 'auto' : '100%',
          minHeight: natural ? 0 : undefined,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {tree}
      </div>
    </div>,
  )
}
