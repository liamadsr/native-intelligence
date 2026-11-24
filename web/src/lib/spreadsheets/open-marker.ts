/**
 * A spreadsheet that took the page down while it opened names itself on the
 * next boot.
 *
 * WHY: the owner's report (11-24, production 1198be57, the desktop app): "I
 * went to the spreadsheet page and it already had one open then it tried to
 * load it and it crashed and landed me on the home page". Sentry had no error
 * at all, so nothing in the page threw: the page itself died. In the desktop
 * app a dead WebContent process (a memory kill, a WebKit crash) is reloaded by
 * the shell's watchdog (desktop/src-tauri/src/native/webcontent_watchdog.rs),
 * which only writes a line to the app's own log. The reloaded page lands on
 * Home, and no script of the old page ran to say why.
 *
 * So the editor marks each open in localStorage (which outlives the dead
 * process) from the moment it starts until its grid has drawn, with the phase
 * it is in and the workbook's size. A page that leaves normally (pagehide)
 * clears it. A marker still there on the next boot, left by another page
 * load, means that page died mid-open: it is reported to Sentry
 * (`spreadsheet-open-died`) and the spreadsheet is held back for a while, so
 * the next boot opens it only when the person asks rather than dying again.
 */
import * as Sentry from '@sentry/nextjs'

export const OPEN_MARKER_KEY = 'ni:spreadsheet-opening'
export const DIED_KEY = 'ni:spreadsheet-died'
/** A marker older than this is a page closed some other way long ago: dropped, not reported. */
export const MARKER_MAX_AGE_MS = 30 * 60_000
/** How long a spreadsheet that died opening waits for the person instead of opening itself. */
export const HOLD_MS = 30 * 60_000

/** Where the open was when the page died. */
export type OpenPhase = 'fetching' | 'engine' | 'workbook' | 'drawing'

export interface OpenMarker {
  /** The page load that wrote it. */
  page: string
  id: string
  phase: OpenPhase
  /** When the open started (ms since epoch). */
  at: number
  /** How long the page had been up when the open started (ms): a launch restore is a few seconds. */
  pageAgeMs: number
  /** The stored workbook's size (base64 characters), once fetched. */
  workbookChars?: number
  /** The JS heap in use (Chromium only; WebKit has none), MB. */
  heapMb?: number
  build?: string
}

/** This page load. */
export const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) store()?.removeItem(key)
    else store()?.setItem(key, JSON.stringify(value))
  } catch {
    /* full or blocked: the marker is a best effort */
  }
}

function heapMb(): number | undefined {
  const mem = (globalThis.performance as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory
  return typeof mem?.usedJSHeapSize === 'number' ? Math.round(mem.usedJSHeapSize / 1048576) : undefined
}

function pageAgeMs(): number {
  try {
    return Math.round(performance.now())
  } catch {
    return 0
  }
}

/** The editor starts opening `id`. */
export function markOpening(id: string, phase: OpenPhase = 'fetching'): void {
  write(OPEN_MARKER_KEY, {
    page: PAGE_ID,
    id,
    phase,
    at: Date.now(),
    pageAgeMs: pageAgeMs(),
    heapMb: heapMb(),
    build: process.env.NEXT_PUBLIC_BUILD_ID || undefined,
  } satisfies OpenMarker)
}

/** The open moved on (only this page's marker for `id` is touched). */
export function markPhase(id: string, phase: OpenPhase, extra: { workbookChars?: number } = {}): void {
  const m = read<OpenMarker>(OPEN_MARKER_KEY)
  if (!m || m.page !== PAGE_ID || m.id !== id) return
  write(OPEN_MARKER_KEY, { ...m, ...extra, phase, heapMb: heapMb() ?? m.heapMb })
}

/** The open ended (drawn, failed with an error shown, or left): this page's marker goes. */
export function clearOpening(id?: string): void {
  const m = read<OpenMarker>(OPEN_MARKER_KEY)
  if (!m || m.page !== PAGE_ID || (id && m.id !== id)) return
  write(OPEN_MARKER_KEY, null)
}

let checked = false

/**
 * Once per page load: a marker another page load left means that page died
 * while opening a spreadsheet. Report it, hold that spreadsheet back, and
 * clear the marker. Returns what was found (for tests and the caller).
 */
export function checkPreviousOpen(now: number = Date.now()): OpenMarker | null {
  if (checked) return null
  checked = true
  const m = read<OpenMarker>(OPEN_MARKER_KEY)
  if (!m || m.page === PAGE_ID) return null
  write(OPEN_MARKER_KEY, null)
  if (typeof m.id !== 'string' || typeof m.at !== 'number' || now - m.at > MARKER_MAX_AGE_MS) return null
  const died = read<Record<string, number>>(DIED_KEY) ?? {}
  died[m.id] = now
  write(DIED_KEY, died)
  Sentry.captureMessage('The page died while opening a spreadsheet', {
    level: 'error',
    fingerprint: ['spreadsheet-open-died'],
    tags: { kind: 'spreadsheet-open-died', spreadsheet_phase: m.phase, launch_restore: m.pageAgeMs < 15_000 ? 'yes' : 'no' },
    extra: { ...m, diedAfterMs: now - m.at },
  })
  return m
}

/** Did `id` take a page down while opening, recently? Then it waits for the person. */
export function heldAfterDeath(id: string, now: number = Date.now()): boolean {
  const died = read<Record<string, number>>(DIED_KEY)
  const at = died?.[id]
  return typeof at === 'number' && now - at < HOLD_MS
}

/** The person asked to open it anyway: release the hold. */
export function releaseHold(id: string): void {
  const died = read<Record<string, number>>(DIED_KEY)
  if (!died || !(id in died)) return
  delete died[id]
  write(DIED_KEY, Object.keys(died).length ? died : null)
}

let pagehideInstalled = false
/** A page leaving normally (reload, navigation, close) clears its own marker: only a death leaves one. */
export function installPagehideClear(): void {
  if (pagehideInstalled || typeof window === 'undefined') return
  pagehideInstalled = true
  window.addEventListener('pagehide', () => clearOpening())
}

/** For tests. */
export function __resetOpenMarkerForTests(): void {
  checked = false
}
