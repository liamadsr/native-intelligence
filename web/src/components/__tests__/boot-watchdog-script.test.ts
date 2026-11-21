// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_ABSOLUTE_MS,
  BOOT_AFTER_LOAD_MS,
  BOOT_FALLBACK_ID,
  BOOT_LOAD_POLL_MS,
  BOOT_MAX_RELOADS,
  BOOT_REFETCH_MS,
  BOOT_RELOAD_STUCK_MS,
  BOOT_RELOAD_WINDOW_MS,
  BOOT_RELOADS_KEY,
  BOOT_STALL_MS,
  BOOT_WATCHDOG_SCRIPT,
} from '../boot-watchdog-script'

type Win = EventTarget & {
  __niBoot?: () => void
  __niBooted?: boolean
  __niBootWatch?: boolean
  self?: unknown
  top?: unknown
}

/**
 * One page load: its own window and document, the tab's sessionStorage (which
 * survives a reload), a `location.reload` that only counts, and a resource
 * timeline the test moves on (`finish`). The script is run as the page runs
 * it, with those names bound to the stand-ins.
 */
type Page = {
  win: Win
  doc: Document
  reload: ReturnType<typeof vi.fn>
  setVisible: (visible: boolean) => void
  setOnline: (online: boolean) => void
  load: () => void
  /** One more resource finished downloading. */
  finish: () => void
  fallback: () => HTMLElement | null
}

let storage: Storage

const SCRIPT_GLOBALS = ['window', 'document', 'location', 'navigator', 'sessionStorage', 'performance', 'fetch'] as const
const ORIGIN = 'https://app.test'

function page(
  opts: {
    loaded?: boolean
    visible?: boolean
    online?: boolean
    storage?: Storage
    frame?: boolean
    noTimeline?: boolean
    /** The page's fetch; none (the default) means the script reloads at once, without fetching. */
    fetch?: (url: string) => Promise<unknown>
    /** <script src> on the page. */
    scripts?: string[]
    /** <link rel="preload" as="script"> on the page. */
    preloads?: string[]
  } = {},
): Page {
  const win = new EventTarget() as Win
  win.self = win
  win.top = opts.frame ? {} : win
  const doc = document.implementation.createHTMLDocument('page')
  for (const src of opts.scripts ?? []) {
    const s = doc.createElement('script')
    s.src = src
    doc.head.appendChild(s)
  }
  for (const href of opts.preloads ?? []) {
    const l = doc.createElement('link')
    l.rel = 'preload'
    l.setAttribute('as', 'script')
    l.href = href
    doc.head.appendChild(l)
  }
  let visible = opts.visible ?? true
  let readyState: DocumentReadyState = opts.loaded === false ? 'interactive' : 'complete'
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => readyState })
  const nav = { onLine: opts.online ?? true }
  const reload = vi.fn()
  let resources = 0
  const perf = opts.noTimeline ? {} : { getEntriesByType: (type: string) => (type === 'resource' ? new Array(resources) : []) }
  new Function(...SCRIPT_GLOBALS, BOOT_WATCHDOG_SCRIPT)(
    win,
    doc,
    { reload, origin: ORIGIN },
    nav,
    opts.storage ?? storage,
    perf,
    opts.fetch,
  )
  return {
    win,
    doc,
    reload,
    finish() {
      resources++
    },
    setVisible(v) {
      visible = v
      doc.dispatchEvent(new Event('visibilitychange'))
    },
    setOnline(v) {
      nav.onLine = v
      if (v) win.dispatchEvent(new Event('online'))
    },
    load() {
      readyState = 'complete'
      win.dispatchEvent(new Event('load'))
    },
    fallback: () => doc.getElementById(BOOT_FALLBACK_ID),
  }
}

describe('the boot watchdog script', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
    storage = sessionStorage
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves a page that started alone', () => {
    const p = page()
    p.win.__niBoot!()
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS * 2)
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.fallback()).toBeNull()
  })

  it('reloads a page that never started, a moment after its load, and counts the reload', () => {
    const p = page({ loaded: false })
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS * 2)
    expect(p.reload).not.toHaveBeenCalled() // the clock starts at load, not at the HTML
    p.load()
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS - 1)
    expect(p.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(BOOT_RELOADS_KEY)!)).toHaveLength(1)
  })

  it('reloads a load that never ends once it is old enough and nothing has finished downloading for a while', () => {
    const p = page({ loaded: false })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS - BOOT_LOAD_POLL_MS)
    expect(p.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BOOT_LOAD_POLL_MS)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('leaves a slow load alone while chunks keep arriving, and reloads once they stop', () => {
    const p = page({ loaded: false })
    // A slow link: a chunk finishes every 10 s, well past the deadline.
    for (let t = 0; t < BOOT_ABSOLUTE_MS * 2; t += 10_000) {
      p.finish()
      vi.advanceTimersByTime(10_000)
    }
    expect(p.reload).not.toHaveBeenCalled()
    // Then nothing more arrives.
    vi.advanceTimersByTime(BOOT_STALL_MS + BOOT_LOAD_POLL_MS)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('a slow load that ends hands over to the after-load check', () => {
    const p = page({ loaded: false })
    for (let t = 0; t < BOOT_ABSOLUTE_MS; t += 10_000) {
      p.finish()
      vi.advanceTimersByTime(10_000)
    }
    p.load()
    p.win.__niBoot!()
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS * 2)
    expect(p.reload).not.toHaveBeenCalled()
  })

  it('without a resource timeline, a load that never ends gets the plain deadline', () => {
    const p = page({ loaded: false, noTimeline: true })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS - BOOT_LOAD_POLL_MS)
    expect(p.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BOOT_LOAD_POLL_MS)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing in a frame', () => {
    const p = page({ frame: true })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS * 3)
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.fallback()).toBeNull()
    expect(p.win.__niBoot).toBeUndefined()
    expect(storage.getItem(BOOT_RELOADS_KEY)).toBeNull()
  })

  it('waits for a hidden window to come back into view', () => {
    const p = page({ visible: false })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS * 2)
    expect(p.reload).not.toHaveBeenCalled()
    p.setVisible(true)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('waits for the network to come back', () => {
    const p = page({ online: false })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS * 2)
    expect(p.reload).not.toHaveBeenCalled()
    p.setOnline(true)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload a page that started while it waited', () => {
    const p = page({ visible: false })
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    p.win.__niBoot!()
    p.setVisible(true)
    expect(p.reload).not.toHaveBeenCalled()
  })

  it(`stops after ${BOOT_MAX_RELOADS} reloads and says the page did not finish loading, with a Reload button`, () => {
    for (let i = 0; i < BOOT_MAX_RELOADS; i++) {
      const p = page()
      vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
      expect(p.reload).toHaveBeenCalledTimes(1)
    }
    const last = page()
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS)
    expect(last.reload).not.toHaveBeenCalled()
    const shown = last.fallback()
    expect(shown?.textContent).toContain("This page didn't finish loading.")
    const button = shown!.querySelector('button')!
    expect(button.textContent).toBe('Reload')
    button.click()
    expect(last.reload).toHaveBeenCalledTimes(1)
  })

  it('counts only the reloads of the last few minutes', () => {
    for (let i = 0; i < BOOT_MAX_RELOADS; i++) {
      page()
      vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    }
    vi.advanceTimersByTime(BOOT_RELOAD_WINDOW_MS)
    const later = page()
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    expect(later.reload).toHaveBeenCalledTimes(1)
    expect(later.fallback()).toBeNull()
  })

  it('a page that starts clears the count and takes the message away', () => {
    for (let i = 0; i < BOOT_MAX_RELOADS; i++) {
      page()
      vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    }
    const slow = page()
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    expect(slow.fallback()).not.toBeNull()
    slow.win.__niBoot!()
    expect(slow.fallback()).toBeNull()
    expect(storage.getItem(BOOT_RELOADS_KEY)).toBeNull()
    expect(slow.win.__niBooted).toBe(true)
  })

  it('tries again when a reload never left the page', () => {
    const p = page()
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    expect(p.reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BOOT_RELOAD_STUCK_MS)
    expect(p.reload).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.getItem(BOOT_RELOADS_KEY)!)).toHaveLength(2)
  })

  it('never reloads where it cannot count its reloads (it could loop), and shows the message', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {},
    } as unknown as Storage
    const p = page({ storage: broken })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS)
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.fallback()).not.toBeNull()
  })

  it('reads a garbled count as no reloads yet, and writes a clean one', () => {
    for (const garbled of ['{not json', '{"a":1}', '7']) {
      storage.setItem(BOOT_RELOADS_KEY, garbled)
      const p = page()
      vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
      expect(p.reload).toHaveBeenCalledTimes(1)
      expect(JSON.parse(storage.getItem(BOOT_RELOADS_KEY)!)).toHaveLength(1)
    }
  })

  describe('fetches the page\'s own scripts before it reloads (WebKit reuses a failed preload otherwise)', () => {
    const runtime = `${ORIGIN}/_next/static/chunks/runtime.js`
    const other = `${ORIGIN}/_next/static/chunks/other.js`

    it('fetches each same-origin script and script preload once, then reloads', async () => {
      const fetched: string[] = []
      const p = page({
        scripts: [runtime, other, 'https://cdn.elsewhere.test/lib.js'],
        preloads: [runtime],
        fetch: async (url) => {
          fetched.push(url)
        },
      })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS)
      expect(fetched.sort()).toEqual([other, runtime])
      expect(p.reload).toHaveBeenCalledTimes(1)
    })

    it('does not reload before the fetches are back', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const p = page({ scripts: [runtime], fetch: () => gate })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS)
      expect(p.reload).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(p.reload).toHaveBeenCalledTimes(1)
    })

    it('reloads anyway when a fetch fails, or hangs past the limit', async () => {
      const failing = page({ scripts: [runtime], fetch: () => Promise.reject(new TypeError('Load failed')) })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS)
      expect(failing.reload).toHaveBeenCalledTimes(1)

      const hanging = page({ scripts: [runtime], fetch: () => new Promise(() => {}) })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS + BOOT_REFETCH_MS - 1)
      expect(hanging.reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(hanging.reload).toHaveBeenCalledTimes(1)
    })

    it('does not reload a page that started while its scripts were being fetched', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const p = page({ scripts: [runtime], fetch: () => gate })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS)
      p.win.__niBoot!()
      release()
      await vi.advanceTimersByTimeAsync(BOOT_REFETCH_MS)
      expect(p.reload).not.toHaveBeenCalled()
    })

    it('the Reload button fetches the scripts first too', async () => {
      for (let i = 0; i < BOOT_MAX_RELOADS; i++) {
        page()
        vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
      }
      const fetched: string[] = []
      const last = page({ scripts: [runtime], fetch: async (url) => void fetched.push(url) })
      await vi.advanceTimersByTimeAsync(BOOT_AFTER_LOAD_MS)
      expect(last.reload).not.toHaveBeenCalled()
      last.fallback()!.querySelector('button')!.click()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetched).toEqual([runtime])
      expect(last.reload).toHaveBeenCalledTimes(1)
    })
  })

  it('watches once per page, even if the script is in it twice', () => {
    const p = page()
    new Function(...SCRIPT_GLOBALS, BOOT_WATCHDOG_SCRIPT)(p.win, p.doc, { reload: p.reload }, { onLine: true }, storage, {})
    // Short of the stuck-reload retry: one watch reloads once, two would reload twice.
    vi.advanceTimersByTime(BOOT_AFTER_LOAD_MS)
    expect(p.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(BOOT_RELOADS_KEY)!)).toHaveLength(1)
  })
})

describe('BootWatchdogScript', () => {
  it('renders nothing outside a production build', async () => {
    const { BootWatchdogScript } = await import('../boot-watchdog-script')
    vi.stubEnv('NODE_ENV', 'development')
    try {
      expect(BootWatchdogScript()).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
