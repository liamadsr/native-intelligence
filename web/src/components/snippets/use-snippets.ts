'use client'

/**
 * The person's snippets, as every `;` menu reads them (docs/plans/snippets.md):
 * one shared, lazily loaded list per workspace (GET /api/account/snippets),
 * read through useSyncExternalStore. It loads the first time a menu or the
 * settings page asks, again when it is older than STALE_MS and a menu asks,
 * and at once after a change made here (refreshSnippets). No timers.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import type { Snippet } from '@/lib/snippets/types'

const STALE_MS = 60_000

interface SnippetsState {
  workspaceId: string | null
  snippets: readonly Snippet[]
  /** The person's name, for the `{{my_name}}` fill-ins (the list's answer carries it). */
  myName: string | null
  loaded: boolean
  at: number
}

let state: SnippetsState = { workspaceId: null, snippets: [], myName: null, loaded: false, at: 0 }
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: SnippetsState) {
  state = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const get = () => state
const EMPTY: SnippetsState = { workspaceId: null, snippets: [], myName: null, loaded: false, at: 0 }
const getServer = () => EMPTY

/** Load the list (again). A load already running is shared. */
export function refreshSnippets(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (inFlight) return inFlight
  const workspaceId = getClientWorkspaceId()
  inFlight = fetch('/api/account/snippets', { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as { snippets?: Snippet[]; me?: { name?: string | null } }
      const myName = typeof json.me?.name === 'string' && json.me.name.trim() ? json.me.name.trim() : null
      set({ workspaceId, snippets: Array.isArray(json.snippets) ? json.snippets : [], myName, loaded: true, at: Date.now() })
    })
    .catch(() => {
      // A failed load leaves what was there; the next ask tries again.
      set({ ...state, loaded: state.workspaceId === workspaceId && state.loaded, at: 0 })
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Load when nothing is loaded for this workspace, or what is loaded is old. */
export function ensureSnippets(now = Date.now()): void {
  if (typeof window === 'undefined') return
  const current = getClientWorkspaceId()
  if (!state.loaded || state.workspaceId !== current || now - state.at > STALE_MS) void refreshSnippets()
}

/** Put a list in place (the settings page after a change, tests). */
export function setSnippets(snippets: readonly Snippet[], myName: string | null = state.myName): void {
  set({ workspaceId: getClientWorkspaceId(), snippets, myName, loaded: true, at: Date.now() })
}

/**
 * The snippets of the workspace in use. `active`: a menu wants them now (it
 * loads them when needed); false reads what is there and loads nothing.
 */
export function useSnippets(active = true): { snippets: readonly Snippet[]; loaded: boolean } {
  const s = useSyncExternalStore(subscribe, get, getServer)
  useEffect(() => {
    if (active) ensureSnippets()
  }, [active])
  const current = typeof window === 'undefined' ? null : getClientWorkspaceId()
  const same = s.workspaceId === current
  return { snippets: same ? s.snippets : [], loaded: same && s.loaded }
}

/** The person's name for the fill-ins (null until the list has loaded, or when none is known). */
export function snippetsMyName(): string | null {
  return state.workspaceId === getClientWorkspaceId() ? state.myName : null
}

/** Read without React (the TipTap extension asks whether to open at all). */
export function currentSnippets(): readonly Snippet[] {
  return state.workspaceId === getClientWorkspaceId() ? state.snippets : []
}
