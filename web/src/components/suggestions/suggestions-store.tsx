'use client'

/**
 * The client half of suggestions everywhere (docs/plans/suggestions-everywhere.md,
 * Phase 4): one store of suggestions keyed by id, so the same suggestion shown
 * in a chat answer and a document stays in step, with
 *   • loading by ids or by home (a document, a conversation, a capture),
 *   • one Realtime channel per home in view, bursts debounced into one refetch,
 *   • optimistic accept / dismiss / modify / undo with rollback on failure,
 *   • the workspace directory (members, agents, contacts, projects) the cards'
 *     pills need, loaded once per workspace.
 *
 * Every write goes through /api/account/suggestions (src/lib/suggestions/settle.ts),
 * which works for any home and any of the person's workspaces.
 *
 * Mount <SuggestionsProvider> once near the root of a surface; cards read it
 * with useSuggestion(id). Outside a provider a card falls back to a private
 * store, so a stray card still works.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cachedJson } from '@/lib/cached-fetch'
import type { ProposedChange } from '@/lib/proposed-changes/types'

/** A suggestion as the routes return it: a proposed_change row plus drift. */
export type Suggestion = ProposedChange & {
  document_id?: string | null
  conversation_id?: string | null
  expires_at?: string | null
  expire_reason?: string | null
  /** Set when someone else changed the target since it was staged. */
  drift?: Array<{ field: string; was: unknown; now: unknown }>
}

export type SuggestionHomeKey = `document:${string}` | `conversation:${string}` | `capture:${string}`

export interface Directory {
  members: { id: string; display_name: string; avatar_url: string | null }[]
  aiMembers: { id: string; name: string; avatar_url: string | null }[]
  contacts: { id: string; full_name: string; email: string | null }[]
  projects: { id: string; name: string }[]
}

const EMPTY_DIRECTORY: Directory = { members: [], aiMembers: [], contacts: [], projects: [] }

type Listener = () => void

/** Outcome of a settle call, for callers that branch on it (the card's drift prompt). */
export type SettleOutcome =
  | { ok: true; entityId?: string | null }
  | { ok: false; code?: string; error: string; details?: unknown }

/**
 * The store proper. Plain class + useSyncExternalStore so a card re-renders
 * only when ITS row changes (getSnapshot returns the same object otherwise).
 */
export class SuggestionStore {
  private rows = new Map<string, Suggestion>()
  private listeners = new Set<Listener>()
  private pendingIds = new Set<string>()
  private idTimer: ReturnType<typeof setTimeout> | null = null
  private homeChannels = new Map<string, { count: number; dispose: () => void }>()
  private directories = new Map<string, Promise<Directory>>()

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  get(id: string): Suggestion | undefined {
    return this.rows.get(id)
  }

  listHome(home: SuggestionHomeKey): Suggestion[] {
    const [kind, id] = home.split(':') as [string, string]
    const col = kind === 'document' ? 'document_id' : kind === 'conversation' ? 'conversation_id' : 'capture_id'
    return [...this.rows.values()]
      .filter((r) => (r as unknown as Record<string, unknown>)[col] === id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  }

  /** Merge fresh rows, keeping object identity for unchanged ones. */
  merge(rows: Suggestion[]) {
    let changed = false
    for (const r of rows) {
      const prev = this.rows.get(r.id)
      if (prev && prev.updated_at === r.updated_at && prev.status === r.status && !r.drift && !prev.drift) continue
      this.rows.set(r.id, r)
      changed = true
    }
    if (changed) this.emit()
  }

  private patch(id: string, fields: Partial<Suggestion>) {
    const prev = this.rows.get(id)
    if (!prev) return
    this.rows.set(id, { ...prev, ...fields })
    this.emit()
  }

  // ── Loading ────────────────────────────────────────────────────────────
  /** Ask for ids; requests within ~25ms are batched into one GET. */
  request(ids: string[]) {
    for (const id of ids) if (!this.rows.has(id)) this.pendingIds.add(id)
    if (this.pendingIds.size === 0 || this.idTimer) return
    this.idTimer = setTimeout(() => {
      this.idTimer = null
      const batch = [...this.pendingIds].slice(0, 100)
      for (const id of batch) this.pendingIds.delete(id)
      void this.fetchQuery(`ids=${batch.join(',')}`)
      if (this.pendingIds.size) this.request([])
    }, 25)
  }

  async loadHome(home: SuggestionHomeKey) {
    const [kind, id] = home.split(':')
    await this.fetchQuery(`${kind}_id=${id}`)
  }

  private async fetchQuery(query: string) {
    try {
      const res = await fetch(`/api/account/suggestions?${query}`)
      if (!res.ok) return
      const data = (await res.json()) as { suggestions?: Suggestion[] }
      this.merge(data.suggestions ?? [])
    } catch {
      /* best-effort: a card keeps its last known state */
    }
  }

  /** Live updates for one home. Ref-counted: the last watcher closes the channel. */
  watchHome(home: SuggestionHomeKey): () => void {
    const existing = this.homeChannels.get(home)
    if (existing) {
      existing.count++
      return () => this.unwatch(home)
    }
    const [kind, id] = home.split(':')
    const col = kind === 'document' ? 'document_id' : kind === 'conversation' ? 'conversation_id' : 'capture_id'
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel(`suggestions:${home}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'proposed_change', filter: `${col}=eq.${id}` }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void this.loadHome(home), 300)
      })
      .subscribe()
    this.homeChannels.set(home, {
      count: 1,
      dispose: () => {
        if (timer) clearTimeout(timer)
        void supabase.removeChannel(channel)
      },
    })
    return () => this.unwatch(home)
  }

  private unwatch(home: string) {
    const entry = this.homeChannels.get(home)
    if (!entry) return
    entry.count--
    if (entry.count <= 0) {
      entry.dispose()
      this.homeChannels.delete(home)
    }
  }

  /** The pills' lists for a workspace, loaded once. Only the current workspace's
   *  endpoints exist, so another workspace's suggestion gets an empty directory
   *  (its pills show the names it was staged with). */
  directory(workspaceId: string | null | undefined, currentWorkspaceId: string | null | undefined): Promise<Directory> {
    if (!workspaceId || workspaceId !== currentWorkspaceId) return Promise.resolve(EMPTY_DIRECTORY)
    let p = this.directories.get(workspaceId)
    if (!p) {
      p = loadDirectory(workspaceId)
      this.directories.set(workspaceId, p)
    }
    return p
  }

  // ── Writes (optimistic) ────────────────────────────────────────────────
  private async post(path: string, body?: unknown, method = 'POST'): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    try {
      const res = await fetch(`/api/account/suggestions/${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { ok: res.ok, data }
    } catch (err) {
      return { ok: false, data: { error: err instanceof Error ? err.message : 'Network error' } }
    }
  }

  private failure(data: Record<string, unknown>): SettleOutcome {
    return {
      ok: false,
      code: data.code as string | undefined,
      error: (data.error as string) ?? 'Something went wrong',
      details: data.details,
    }
  }

  async apply(id: string, opts: { force?: boolean } = {}): Promise<SettleOutcome> {
    const prev = this.rows.get(id)
    if (!prev) return { ok: false, error: 'Not loaded' }
    this.patch(id, { status: 'applied', drift: undefined })
    const { ok, data } = await this.post(`${id}/apply`, opts.force ? { force: true } : {})
    if (ok) {
      const change = data.change as Suggestion | undefined
      if (change) this.merge([{ ...prev, ...change, drift: undefined }])
      return { ok: true, entityId: (data.entity_id as string | null) ?? null }
    }
    // The server's word wins: an expired row comes back expired, a drifted one
    // goes back to pending with what changed.
    const details = data.details as { change?: Suggestion; fields?: Suggestion['drift'] } | undefined
    if (details?.change) this.merge([{ ...prev, ...details.change }])
    else this.rows.set(id, { ...prev, ...(details?.fields ? { drift: details.fields } : {}) })
    this.emit()
    return this.failure(data)
  }

  async applyMany(ids: string[]): Promise<{ applied: number; skipped: number; failed: number }> {
    const pending = ids.filter((id) => this.rows.get(id)?.status === 'pending')
    for (const id of pending) this.patch(id, { status: 'applied' })
    const { ok, data } = await this.post('apply-all', { ids: pending })
    // Reload the truth either way: skipped rows may have expired or drifted.
    this.request([])
    await this.fetchQuery(`ids=${pending.join(',')}`)
    if (!ok) return { applied: 0, skipped: 0, failed: pending.length }
    return {
      applied: Number(data.applied ?? 0),
      skipped: Number(data.skipped ?? 0),
      failed: Number(data.failed ?? 0),
    }
  }

  async dismiss(id: string): Promise<SettleOutcome> {
    const prev = this.rows.get(id)
    if (!prev) return { ok: false, error: 'Not loaded' }
    this.patch(id, { status: 'dismissed' })
    const { ok, data } = await this.post(`${id}/dismiss`)
    if (ok) {
      if (data.change) this.merge([data.change as Suggestion])
      return { ok: true }
    }
    this.rows.set(id, prev)
    this.emit()
    return this.failure(data)
  }

  async undo(id: string): Promise<SettleOutcome> {
    const prev = this.rows.get(id)
    if (!prev) return { ok: false, error: 'Not loaded' }
    this.patch(id, { status: 'pending', result_entity_id: null })
    const { ok, data } = await this.post(`${id}/undo`)
    if (ok) {
      if (data.change) this.merge([data.change as Suggestion])
      return { ok: true }
    }
    this.rows.set(id, prev)
    this.emit()
    return this.failure(data)
  }

  async edit(id: string, updates: Record<string, unknown>): Promise<SettleOutcome> {
    const prev = this.rows.get(id)
    if (!prev) return { ok: false, error: 'Not loaded' }
    this.patch(id, updates as Partial<Suggestion>)
    const { ok, data } = await this.post(id, updates, 'PATCH')
    if (ok) {
      if (data.change) this.merge([data.change as Suggestion])
      return { ok: true }
    }
    this.rows.set(id, prev)
    this.emit()
    return this.failure(data)
  }
}

async function loadDirectory(workspaceId: string): Promise<Directory> {
  const [members, ws, contacts, projects] = await Promise.all([
    cachedJson<{ members?: Directory['members'] }>('/api/account/workspace/members', { scope: workspaceId }),
    cachedJson<{ aiMembers?: Directory['aiMembers'] }>('/api/account/workspace', { scope: workspaceId }),
    cachedJson<{ contacts?: Directory['contacts'] }>('/api/account/contacts?limit=100', { scope: workspaceId }),
    cachedJson<{ projects?: Directory['projects'] }>('/api/account/projects?minimal=1', { scope: workspaceId }),
  ])
  return {
    members: (members?.members ?? []).map((m) => ({ id: m.id, display_name: m.display_name, avatar_url: m.avatar_url })),
    aiMembers: (ws?.aiMembers ?? []).map((m) => ({ id: m.id, name: m.name, avatar_url: m.avatar_url })),
    contacts: (contacts?.contacts ?? []).map((c) => ({ id: c.id, full_name: c.full_name, email: c.email })),
    projects: (projects?.projects ?? []).filter((p) => p.name !== '__default__').map((p) => ({ id: p.id, name: p.name })),
  }
}

// ── React bindings ─────────────────────────────────────────────────────────

/** Opens an entity a card points at (the dashboard passes its tab navigation). */
export type OpenSuggestionEntity = (entityType: string, id: string, title: string) => void

const StoreContext = createContext<{ store: SuggestionStore; openEntity?: OpenSuggestionEntity } | null>(null)
let fallbackStore: SuggestionStore | null = null

export function SuggestionsProvider({
  children,
  openEntity,
}: {
  children: React.ReactNode
  openEntity?: OpenSuggestionEntity
}) {
  const [store] = useState(() => new SuggestionStore())
  const value = useMemo(() => ({ store, openEntity }), [store, openEntity])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useSuggestionStore(): SuggestionStore {
  const ctx = useContext(StoreContext)
  if (ctx) return ctx.store
  fallbackStore ??= new SuggestionStore()
  return fallbackStore
}

/** The provider's entity opener; undefined outside the dashboard (cards then hide "open"). */
export function useOpenSuggestionEntity(): OpenSuggestionEntity | undefined {
  return useContext(StoreContext)?.openEntity
}

/** One suggestion, loaded on demand (batched with every other card on the page). */
export function useSuggestion(id: string): Suggestion | undefined {
  const store = useSuggestionStore()
  const row = useSyncExternalStore(store.subscribe, () => store.get(id), () => undefined)
  useEffect(() => {
    if (!store.get(id)) store.request([id])
  }, [store, id])
  return row
}

/** Several suggestions by id (loaded on demand), in the order given; missing ones are left out. */
export function useSuggestions(ids: string[]): Suggestion[] {
  const store = useSuggestionStore()
  const key = ids.join(',')
  const cache = useRef<{ sig: string; rows: Suggestion[] }>({ sig: '', rows: EMPTY })
  const snapshot = useCallback(() => {
    const rows = key ? key.split(',').map((id) => store.get(id)).filter((r): r is Suggestion => !!r) : EMPTY
    const sig = rows.map((r) => `${r.id}:${r.status}:${r.updated_at}`).join('|')
    if (sig !== cache.current.sig) cache.current = { sig, rows }
    return cache.current.rows
  }, [store, key])
  const rows = useSyncExternalStore(store.subscribe, snapshot, () => EMPTY)
  useEffect(() => {
    if (key) store.request(key.split(','))
  }, [store, key])
  return rows
}

/** Every suggestion in a home, kept live (Realtime) unless `live: false`.
 *  Pass null to skip. */
export function useSuggestionHome(home: SuggestionHomeKey | null, opts: { live?: boolean } = {}): Suggestion[] {
  const live = opts.live ?? true
  const store = useSuggestionStore()
  const getSnapshot = useCallback(() => {
    // listHome builds a new array; cache by a cheap signature so React sees a
    // stable snapshot until a row in the home changes.
    return home ? store.listHome(home) : EMPTY
  }, [store, home])
  const cache = useRef<{ sig: string; rows: Suggestion[] }>({ sig: '', rows: EMPTY })
  const stable = useCallback(() => {
    const rows = getSnapshot()
    const sig = rows.map((r) => `${r.id}:${r.status}:${r.updated_at}`).join('|')
    if (sig !== cache.current.sig) cache.current = { sig, rows }
    return cache.current.rows
  }, [getSnapshot])
  const rows = useSyncExternalStore(store.subscribe, stable, () => EMPTY)
  useEffect(() => {
    if (!home) return
    void store.loadHome(home)
    return live ? store.watchHome(home) : undefined
  }, [store, home, live])
  return rows
}

const EMPTY: Suggestion[] = []

/** The pills' directory for a suggestion's workspace. */
export function useSuggestionDirectory(workspaceId: string | null | undefined, currentWorkspaceId: string | null | undefined): Directory {
  const store = useSuggestionStore()
  const [dir, setDir] = useState<Directory>(EMPTY_DIRECTORY)
  useEffect(() => {
    let live = true
    void store.directory(workspaceId, currentWorkspaceId).then((d) => {
      if (live) setDir(d)
    })
    return () => {
      live = false
    }
  }, [store, workspaceId, currentWorkspaceId])
  return dir
}

/** Toast a settle failure the way every surface does. */
export function toastSettleFailure(outcome: SettleOutcome, verb: string) {
  if (outcome.ok) return
  if (outcome.code === 'already_true') {
    toast.info('Already done', { description: 'That change was made another way.' })
    return
  }
  if (outcome.code === 'target_deleted') {
    toast.info('No longer there', { description: 'What this suggestion changes was deleted.' })
    return
  }
  if (outcome.code === 'not_pending') {
    toast.info('Already handled', { description: 'Someone settled this just now.' })
    return
  }
  toast.error(`Could not ${verb}`, { description: outcome.error })
}
