'use client'

import { useSyncExternalStore } from 'react'
import { cleanBlockedSites } from '@/lib/browser-agent/blocked-sites'

/**
 * This window's copy of the sites the user blocked the browser agent from
 * (lib/browser-agent/blocked-sites.ts). The server holds the list; the Agent
 * panel and chip read and change it here.
 *
 * It is NOT what keeps the agent off a site: the command relay is handed the
 * server's list with every command it claims and runs nothing without it.
 * The relay adds this copy on top only so that a site blocked in this window
 * stops a running task at its next step, before the server says so.
 *
 * Loaded on first use; refreshed when the window gains focus and when another
 * window changes the list (a BroadcastChannel message).
 */

export type BlockedSitesStatus = 'loading' | 'ready' | 'error'
export interface BlockedSitesState {
  status: BlockedSitesStatus
  sites: string[]
}
export type BlockedSiteWrite = { ok: true } | { ok: false; error: string }

const ENDPOINT = '/api/account/browser/blocked-sites'
const CHANNEL = 'ni-browser-blocked-sites'
/** The device-local allow lists from before the block list (one per browser
 *  profile, and one older device-wide one): meaningless now, so removed. */
const LEGACY_GRANTS_PREFIX = 'ni-browser-agent-allowed-origins'

const LOADING: BlockedSitesState = { status: 'loading', sites: [] }
let state: BlockedSitesState = LOADING
const listeners = new Set<() => void>()
let started = false
let inflight: Promise<void> | null = null
let channel: BroadcastChannel | null = null

function set(next: BlockedSitesState): void {
  state = next
  for (const listener of listeners) listener()
}

function dropLegacyGrants(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(LEGACY_GRANTS_PREFIX)) keys.push(key)
    }
    for (const key of keys) window.localStorage.removeItem(key)
  } catch {
    /* storage blocked: nothing reads them anyway */
  }
}

/** Fetch the list again. A failure keeps a list already loaded (and says
 *  'error' only when there is none). */
export function refreshBlockedSites(): Promise<void> {
  if (inflight) return inflight
  inflight = fetch(ENDPOINT, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error('blocked sites unavailable')
      const body = (await res.json()) as { sites?: unknown }
      set({ status: 'ready', sites: cleanBlockedSites(body.sites) })
    })
    .catch(() => {
      if (state.status !== 'ready') set({ ...state, status: 'error' })
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  dropLegacyGrants()
  try {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = () => void refreshBlockedSites()
  } catch {
    /* no BroadcastChannel: focus refreshes still keep windows in step */
  }
  window.addEventListener('focus', () => void refreshBlockedSites())
  void refreshBlockedSites()
}

export function subscribeBlockedSites(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getBlockedSitesState(): BlockedSitesState {
  return state
}

/** The sites as this window last saw them ([] before they load). */
export function localBlockedSites(): readonly string[] {
  return state.sites
}

/** This window's blocked sites, kept current. */
export function useBlockedSites(): BlockedSitesState {
  return useSyncExternalStore(subscribeBlockedSites, getBlockedSitesState, () => LOADING)
}

/** Shown at once, then made to match what the server says. A failed write
 *  goes back to the list as it was. */
async function write(method: 'POST' | 'DELETE', site: string, optimistic: string[]): Promise<BlockedSiteWrite> {
  const before = state
  set({ status: before.status === 'error' ? 'loading' : before.status, sites: optimistic })
  try {
    const res = await fetch(ENDPOINT, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site }),
    })
    const body = (await res.json().catch(() => null)) as { sites?: unknown; error?: unknown } | null
    if (!res.ok) {
      set(before)
      return { ok: false, error: typeof body?.error === 'string' ? body.error : 'That didn’t save. Try again.' }
    }
    set({ status: 'ready', sites: cleanBlockedSites(body?.sites) })
    channel?.postMessage('changed')
    return { ok: true }
  } catch {
    set(before)
    return { ok: false, error: 'Couldn’t reach Native Intelligence. Try again.' }
  }
}

/** Block the agent from `site` (an entry from blocked-sites.ts). */
export function blockSite(site: string): Promise<BlockedSiteWrite> {
  return write('POST', site, state.sites.includes(site) ? state.sites : [...state.sites, site])
}

/** Let the agent use `site` again. */
export function unblockSite(site: string): Promise<BlockedSiteWrite> {
  return write('DELETE', site, state.sites.filter((s) => s !== site))
}
