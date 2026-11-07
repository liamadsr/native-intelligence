'use client'

/**
 * The agent's computer, as the app shows it (docs/plans/cloud-browser.md, C3):
 * the side panel's computer card (its state and a small preview of the page)
 * and the live view it opens. One store for the window.
 *
 * Flat cost: the state is read when the card shows, and every 15 s while it
 * shows on a visible page; the preview only while the browser runs (never
 * waking it), and the last frame is kept for when it sleeps.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { BrowserExitStatus } from '@/lib/tauri-bridge'

export type ComputerStatus = 'starting' | 'running' | 'stopping' | 'stopped'

export interface ComputerState {
  /** null until the first read; false while the person's agent has never used its browser. */
  exists: boolean | null
  status: ComputerStatus | null
  driver: 'agent' | 'person'
  /** A task is running on it now. */
  busy: boolean
  /** The live view is set up on this server (its signing key). */
  liveView: boolean
  /** The last frame of the agent's tab (an object URL), kept while it sleeps. */
  thumbnail: string | null
  viewOpen: boolean
  /** Bumped when the live view must connect again (the driver changed in another window). */
  viewEpoch: number
  /** C4: a Mac of the person's carries the browser's traffic (the server's word, on any device). */
  macConnected: boolean
  /** C4: this Mac's own exit, on the desktop that drives it (browser-exit-client.ts); null elsewhere. */
  mac: BrowserExitStatus | null
}

const INITIAL: ComputerState = { exists: null, status: null, driver: 'agent', busy: false, liveView: false, thumbnail: null, viewOpen: false, viewEpoch: 0,
  macConnected: false, mac: null }
export const COMPUTER_POLL_MS = 15_000

let state = INITIAL
const listeners = new Set<() => void>()
function set(next: Partial<ComputerState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const getComputer = () => state
export function subscribeComputer(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useComputer(): ComputerState {
  return useSyncExternalStore(subscribeComputer, getComputer, () => INITIAL)
}

/** The card's one-line summary, or null when there's no computer to show (the card hides). */
export function computerSummary(computer: Pick<ComputerState, 'exists' | 'status' | 'driver' | 'busy'>): string | null {
  if (!computer.exists || !computer.status) return null
  if (computer.status === 'running' && computer.driver === 'person') return 'You’re driving'
  if (computer.status === 'running') return computer.busy ? 'Working' : 'Ready'
  if (computer.status === 'starting') return 'Waking…'
  return 'Asleep'
}

export async function refreshComputer(): Promise<void> {
  try {
    const response = await fetch('/api/account/browser/live', { cache: 'no-store' })
    if (!response.ok) return
    const body = await response.json() as { exists?: boolean; status?: ComputerStatus; driver?: string; busy?: boolean; liveView?: boolean; macConnected?: boolean }
    set({ exists: body.exists === true, status: body.status ?? null, driver: body.driver === 'person' ? 'person' : 'agent',
      busy: body.busy === true, liveView: body.liveView === true, macConnected: body.macConnected === true })
  } catch { /* offline: the card keeps what it showed */ }
}

/**
 * A viewer token for the hub. `thumbnail`, and `view` with `wake: false` (a
 * view connecting again by itself), never wake the browser (state `asleep` then).
 */
export async function liveViewTicket(mode: 'view' | 'thumbnail', wake = true): Promise<
  { state: 'running'; token: string; viewerUrl: string; thumbnailUrl: string; control: boolean; driver: 'agent' | 'person' } |
  { state: 'asleep' } | { state: 'error'; message: string }> {
  try {
    const response = await fetch('/api/account/browser/live', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, wake }) })
    const body = await response.json().catch(() => null)
    if (!response.ok) return { state: 'error', message: typeof body?.error === 'string' ? body.error : 'Your browser could not be reached.' }
    return body
  } catch {
    return { state: 'error', message: 'Your browser could not be reached.' }
  }
}

export async function refreshThumbnail(): Promise<void> {
  const ticket = await liveViewTicket('thumbnail')
  if (ticket.state !== 'running') return
  try {
    const response = await fetch(ticket.thumbnailUrl, { headers: { authorization: `Bearer ${ticket.token}` }, cache: 'no-store' })
    if (response.status !== 200) return
    const url = URL.createObjectURL(await response.blob())
    const previous = state.thumbnail
    set({ thumbnail: url })
    if (previous) URL.revokeObjectURL(previous)
  } catch { /* the last frame stays */ }
}

/**
 * Read the computer's state while `active` (the card is on screen), and its
 * preview while it runs, every COMPUTER_POLL_MS on a visible page.
 */
export function useComputerPolling(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let stopped = false
    const tick = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      await refreshComputer()
      if (!stopped && state.status === 'running' && state.liveView) await refreshThumbnail()
    }
    void tick()
    const timer = setInterval(() => void tick(), COMPUTER_POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active])
}

export function openLiveView() { set({ viewOpen: true }) }

/** This Mac's exit as the desktop reports it (browser-exit-client.ts). */
export function setMacStatus(mac: BrowserExitStatus | null) { set({ mac }) }

/**
 * The agent puts the view away (close_browser). Never while the person drives:
 * the agent doesn't end their session.
 */
export function hideLiveView() { if (state.driver !== 'person') set({ viewOpen: false }) }

/** The person closes the view. Closing while driving hands the browser back: the agent never waits on a window nobody has open. */
export function closeLiveView() {
  if (state.viewOpen && state.driver === 'person') void setDriver('agent')
  set({ viewOpen: false })
}

/** The driver changed elsewhere: an open view connects again, with input or without. */
export function reconnectLiveView() { set({ viewEpoch: state.viewEpoch + 1 }) }

/** The page is going away while the person drives: hand back on the way out (a fetch that outlives the page). */
export function handBackOnExit() {
  if (state.driver !== 'person') return
  try {
    void fetch('/api/account/browser/driver', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ driver: 'agent' }) })
  } catch { /* the stop at idle gives it back */ }
}

/** Take the browser over (input reaches it; the agent stops) or hand it back. */
export async function setDriver(driver: 'agent' | 'person'): Promise<boolean> {
  try {
    const response = await fetch('/api/account/browser/driver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ driver }) })
    if (!response.ok) return false
    set({ driver })
    return true
  } catch {
    return false
  }
}

/** Test-only: back to the first render. */
export function __resetComputerForTests() { state = INITIAL }
