// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_ABSOLUTE_MS,
  BOOT_AFTER_LOAD_MS,
  BOOT_FALLBACK_ID,
  BOOT_MAX_RELOADS,
  BOOT_RELOAD_STUCK_MS,
  BOOT_RELOAD_WINDOW_MS,
  BOOT_RELOADS_KEY,
  BOOT_WATCHDOG_SCRIPT,
} from '../boot-watchdog-script'

/**
 * One page load: its own window and document, the tab's sessionStorage (which
 * survives a reload), and a `location.reload` that only counts. The script is
 * run as the page runs it, with those names bound to the stand-ins.
 */
type Page = {
  win: EventTarget & { __niBoot?: () => void; __niBooted?: boolean; __niBootWatch?: boolean }
  doc: Document
  reload: ReturnType<typeof vi.fn>
  setVisible: (visible: boolean) => void
  setOnline: (online: boolean) => void
  load: () => void
  fallback: () => HTMLElement | null
}

let storage: Storage

function page(opts: { loaded?: boolean; visible?: boolean; online?: boolean; storage?: Storage } = {}): Page {
  const win = new EventTarget() as Page['win']
  const doc = document.implementation.createHTMLDocument('page')
  let visible = opts.visible ?? true
  let readyState: DocumentReadyState = opts.loaded === false ? 'interactive' : 'complete'
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => readyState })
  const nav = { onLine: opts.online ?? true }
  const reload = vi.fn()
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', BOOT_WATCHDOG_SCRIPT)(
    win,
    doc,
    { reload },
    nav,
    opts.storage ?? storage,
  )
  return {
    win,
    doc,
    reload,
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

  it('gives a page whose load never ends the absolute deadline', () => {
    const p = page({ loaded: false })
    vi.advanceTimersByTime(BOOT_ABSOLUTE_MS - 1)
    expect(p.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.reload).toHaveBeenCalledTimes(1)
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

  it('watches once per page, even if the script is in it twice', () => {
    const p = page()
    new Function('window', 'document', 'location', 'navigator', 'sessionStorage', BOOT_WATCHDOG_SCRIPT)(
      p.win,
      p.doc,
      { reload: p.reload },
      { onLine: true },
      storage,
    )
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
