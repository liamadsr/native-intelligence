'use client'

/**
 * Data layer for the Agents & Skills page.
 *
 * Owns the three source lists (Discover / Workspace / Mine) plus the mutating
 * actions (fork, create/edit, delete) and the live-sync wiring. Extracted from
 * the view so the orchestrator component stays about layout + which dialog is
 * open, not fetch plumbing. The careful dedupe that scopes each list lives in
 * `library-filter.ts` (pure, tested); this hook only fetches and mutates.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import {
  LIBRARY_CATEGORY_LABELS as CATEGORY_LABELS,
} from '@/lib/types/library'
import type { LibraryRow, LibraryCategory } from './library-types'

/**
 * The outcome of a save(). Discriminated on `ok` so a caller can't confuse "the
 * request failed" with "the request succeeded but the body didn't parse into a
 * row". An ok response with an unparseable body is still `{ ok: true, item: null }`
 * — the mutation landed, so the caller should close its dialog and fall back to
 * its own known name for the toast; only `{ ok: false }` (error already toasted
 * inside save) should leave the dialog open.
 */
export type SaveResult = { ok: true; item: LibraryRow | null; body?: Record<string, unknown> | null } | { ok: false }

/**
 * Pick the right account endpoint to POST/PATCH/DELETE for a category. The two
 * account routes are symmetric apart from category-specific response keys.
 */
function endpointFor(category: LibraryCategory): string {
  switch (category) {
    case 'skill':
      return '/api/account/skills'
    case 'agent':
      return '/api/account/agents'
  }
}

/**
 * The account endpoints return the created/updated row under a category-
 * specific key. Normalize to a single shape.
 */
function extractItem(body: unknown, category: LibraryCategory): LibraryRow | null {
  if (!body || typeof body !== 'object') return null
  const key: Record<LibraryCategory, string> = { skill: 'skill', agent: 'agent' }
  return (body as Record<string, LibraryRow>)[key[category]] || null
}

export interface UseLibraryItems {
  discoverItems: LibraryRow[]
  workspaceItems: LibraryRow[]
  myItems: LibraryRow[]
  isLoading: boolean
  /** Id of the item currently being forked, for the row's "Adding…" state. */
  forking: string | null
  refetchOwned: () => void
  refetchAll: () => void
  fork: (itemId: string) => Promise<void>
  remove: (item: LibraryRow) => Promise<void>
  /** POST (create) or PATCH (edit) a row. Resolves `{ ok: true, item }` on a 2xx
   *  (item may be null if the body didn't parse) and `{ ok: false }` on failure
   *  (the error toast is raised inside save). */
  save: (args: {
    isEditMode: boolean
    editingId: string | null
    category: LibraryCategory
    body: Record<string, unknown>
  }) => Promise<SaveResult>
}

export function useLibraryItems(): UseLibraryItems {
  const [discoverItems, setDiscoverItems] = useState<LibraryRow[]>([])
  const [workspaceItems, setWorkspaceItems] = useState<LibraryRow[]>([])
  const [myItems, setMyItems] = useState<LibraryRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [forking, setForking] = useState<string | null>(null)

  // Discover is the whole public catalog — no search/category params, since the
  // page filters client-side (the scope filter needs the full set to dedupe
  // Discover against the workspace anyway). limit=100 matches the prior page.
  const fetchDiscoverItems = useCallback(async () => {
    const res = await fetch('/api/marketplace/library?limit=100')
    if (res.ok) {
      const data = await res.json()
      setDiscoverItems(data.items || [])
    }
  }, [])

  // Workspace + Mine each aggregate across both categories. Fan out two
  // concurrent requests and merge — keeps each endpoint focused on one
  // category while giving the page a single unified list per scope.
  const fetchAccountItems = useCallback(async (mineOnly: boolean): Promise<LibraryRow[]> => {
    const mineParam = mineOnly ? '?mine=true' : ''
    const [skillsRes, agentsRes] = await Promise.all([
      fetch(`/api/account/skills${mineParam}`),
      fetch(`/api/account/agents${mineParam}`),
    ])
    const merged: LibraryRow[] = []
    if (skillsRes.ok) merged.push(...((await skillsRes.json()).skills || []))
    if (agentsRes.ok) merged.push(...((await agentsRes.json()).agents || []))
    return merged
  }, [])

  const fetchWorkspaceItems = useCallback(async () => {
    setWorkspaceItems(await fetchAccountItems(false))
  }, [fetchAccountItems])

  const fetchMyItems = useCallback(async () => {
    setMyItems(await fetchAccountItems(true))
  }, [fetchAccountItems])

  useEffect(() => {
    setIsLoading(true)
    Promise.all([fetchDiscoverItems(), fetchWorkspaceItems(), fetchMyItems()]).finally(() =>
      setIsLoading(false),
    )
  }, [fetchDiscoverItems, fetchWorkspaceItems, fetchMyItems])

  const refetchOwned = useCallback(() => {
    fetchWorkspaceItems()
    fetchMyItems()
  }, [fetchWorkspaceItems, fetchMyItems])

  const refetchAll = useCallback(() => {
    fetchWorkspaceItems()
    fetchMyItems()
    fetchDiscoverItems()
  }, [fetchWorkspaceItems, fetchMyItems, fetchDiscoverItems])

  // Live-sync the workspace-owned lists (Mine + Workspace) when a recipe
  // (agent/skill) is created, updated, or deleted elsewhere — an MCP tool, a
  // teammate, or another tab. Discover is the community catalog and stays put
  // (a workspace recipe change doesn't alter the public listing).
  useEntityListSync(['recipe'], refetchOwned)

  const fork = useCallback(
    async (itemId: string) => {
      setForking(itemId)
      try {
        const res = await fetch(`/api/marketplace/library/${itemId}/fork`, { method: 'POST' })
        if (res.ok) {
          const data = await res.json()
          toast.success(`"${data.item.name}" added to your workspace`)
          refetchOwned()
        } else {
          const err = await res.json().catch(() => ({ error: 'Failed to add to workspace' }))
          toast.error(err.error || 'Failed to add to workspace')
        }
      } finally {
        setForking(null)
      }
    },
    [refetchOwned],
  )

  const remove = useCallback(async (item: LibraryRow) => {
    const res = await fetch(`${endpointFor(item.category)}/${item.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(`${CATEGORY_LABELS[item.category]} deleted`)
      setWorkspaceItems((prev) => prev.filter((r) => r.id !== item.id))
      setMyItems((prev) => prev.filter((r) => r.id !== item.id))
      setDiscoverItems((prev) => prev.filter((r) => r.id !== item.id))
    } else {
      const err = await res.json().catch(() => ({ error: 'Failed to delete' }))
      toast.error(err.error || 'Failed to delete')
    }
  }, [])

  const save = useCallback<UseLibraryItems['save']>(
    async ({ isEditMode, editingId, category, body }) => {
      const url = isEditMode ? `${endpointFor(category)}/${editingId}` : endpointFor(category)
      const method = isEditMode ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        // Parse the row if we can, but a 2xx with an unparseable body still
        // counts as success — the mutation landed. Return item: null and let the
        // caller fall back to its own name.
        const data = await res.json().catch(() => null)
        const saved = data ? extractItem(data, category) : null
        refetchAll()
        // The whole answer too: an agent's create also says what became of its bot.
        return { ok: true, item: saved, body: data && typeof data === 'object' ? (data as Record<string, unknown>) : null }
      }
      const fallback = isEditMode ? 'Failed to update' : 'Failed to create'
      const err = await res.json().catch(() => ({ error: fallback }))
      toast.error(err.error || fallback)
      return { ok: false }
    },
    [refetchAll],
  )

  return {
    discoverItems,
    workspaceItems,
    myItems,
    isLoading,
    forking,
    refetchOwned,
    refetchAll,
    fork,
    remove,
    save,
  }
}
