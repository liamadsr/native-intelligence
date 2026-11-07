'use client'

/**
 * The composer menu's server search (docs/plans/slash-search.md): one request
 * to /api/account/search for every record kind the menu needs, in the
 * composer's own workspace (composer-workspace.ts).
 *
 * Every authenticated route costs ~350ms before a byte comes back, so rather
 * than let the list lag the typing, whatever is already loaded is narrowed at
 * once, in the browser, on every keystroke (each typed word in the row's
 * name); the server's answer then replaces it, and can add what the loaded
 * rows didn't hold. The server stays the source of truth: narrowing never
 * widens what it found. Recent answers are kept, so backspacing is instant;
 * one older than CACHE_FRESH_MS still shows at once while a fresh one is
 * asked for. The first view (recent people) is asked for as the composer
 * mounts (usePrefetchMenuSearch), so the first `/` doesn't shift under them.
 * What's already attached to the turn is left out.
 */
import { useEffect, useMemo, useState } from 'react'
import { menuRowId, normalizeQuery, type MenuSearchKind, type MenuSearchResponse, type MenuSearchRow } from '@/lib/search/menu-search'
import { composerWorkspaceHeaders, useComposerWorkspace } from './composer-workspace'
import { rowSearchText } from './command-menu-model'

export type MenuRecords = Partial<Record<MenuSearchKind, MenuSearchRow[]>>

/** Keystrokes coalesce for this long; nothing typed asks at once. */
const DEBOUNCE_MS = 150
/** Answers kept for instant backspacing. */
const CACHE_SIZE = 30
/** An answer younger than this is used as is; an older one shows while it's asked again. */
const CACHE_FRESH_MS = 60_000
const cache = new Map<string, { at: number; records: MenuRecords }>()
/** Prefetches out, by key (two composers mounting ask once). */
const prefetching = new Set<string>()

function remember(key: string, records: MenuRecords) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), records })
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
}

function kept(key: string): { records: MenuRecords; fresh: boolean } | null {
  const hit = cache.get(key)
  return hit ? { records: hit.records, fresh: Date.now() - hit.at < CACHE_FRESH_MS } : null
}

/** For tests: start with no answers kept. */
export function clearMenuSearchCache() {
  cache.clear()
  prefetching.clear()
}

type MenuSearchRequest = { kinds: readonly MenuSearchKind[]; limit: number }

const keyOf = (workspace: string | null, search: MenuSearchRequest, q: string) =>
  `${workspace ?? ''}|${search.kinds.join(',')}|${search.limit}|${normalizeQuery(q)}`

/** One request to the search route; null when it failed. */
async function fetchMenuSearch(search: MenuSearchRequest, q: string, workspace: string | null, signal?: AbortSignal): Promise<MenuRecords | null> {
  const params = new URLSearchParams({ q, types: search.kinds.join(','), limit: String(search.limit) })
  const r = await fetch(`/api/account/search?${params.toString()}`, { signal, headers: composerWorkspaceHeaders(workspace) })
  if (!r.ok) return null
  const data = (await r.json()) as MenuSearchResponse | null
  return data?.results && typeof data.results === 'object' ? (data.results as MenuRecords) : {}
}

/** Ask for what the menu shows before anything is typed, so its first open has it. */
export function usePrefetchMenuSearch(search: MenuSearchRequest | null) {
  const workspace = useComposerWorkspace()
  const key = search ? keyOf(workspace, search, '') : ''
  useEffect(() => {
    if (!search || !key || kept(key)?.fresh || prefetching.has(key)) return
    prefetching.add(key)
    fetchMenuSearch(search, '', workspace)
      .then((records) => {
        if (records) remember(key, records)
      })
      .catch(() => {})
      .finally(() => prefetching.delete(key))
    // `search` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** The loaded rows that still match what's typed: each word in the row's name. */
function narrow(records: MenuRecords, query: string): MenuRecords {
  const words = normalizeQuery(query).split(' ').filter(Boolean)
  if (!words.length) return records
  const out: MenuRecords = {}
  for (const [kind, rows] of Object.entries(records) as [MenuSearchKind, MenuSearchRow[]][]) {
    out[kind] = rows.filter((row) => {
      const text = rowSearchText(row).toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }
  return out
}

export interface MenuSearch {
  records: MenuRecords
  /** A request is out and nothing is shown for it yet. */
  loading: boolean
  /** A request for what's typed now is out (rows shown or not): its answer may still reorder them. */
  searching: boolean
}

export function useMenuSearch(
  search: { kinds: readonly MenuSearchKind[]; limit: number } | null,
  query: string,
  exclude: Partial<Record<MenuSearchKind, readonly string[]>> = {},
): MenuSearch {
  const workspace = useComposerWorkspace()
  const q = query.trim()
  const kindsKey = search ? search.kinds.join(',') : ''
  const key = search ? keyOf(workspace, search, q) : ''

  // The last answer, and the key it answered (so a stale one is narrowed, never shown as is).
  const [answer, setAnswer] = useState<{ key: string; records: MenuRecords }>({ key: '', records: {} })
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!search || !key) return
    const hit = kept(key)
    if (hit) {
      // Shown at once; an old one is asked again behind it (nothing waits on that).
      setAnswer({ key, records: hit.records })
      setPending(null)
      if (hit.fresh) return
    }
    const controller = new AbortController()
    if (!hit) setPending(key)
    const t = setTimeout(
      () => {
        fetchMenuSearch(search, q, workspace, controller.signal)
          .then((records) => {
            if (controller.signal.aborted || !records) return
            remember(key, records)
            setAnswer({ key, records })
          })
          .catch(() => {
            // Aborted or a network error: keep whatever is showing.
          })
          .finally(() => {
            if (!controller.signal.aborted) setPending((p) => (p === key ? null : p))
          })
      },
      q && !hit ? DEBOUNCE_MS : 0,
    )
    return () => {
      clearTimeout(t)
      controller.abort()
    }
    // `search` is read through `kindsKey` and `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const excludeKey = Object.entries(exclude)
    .map(([k, ids]) => `${k}:${(ids ?? []).join(',')}`)
    .join('|')
  return useMemo(() => {
    if (!search) return { records: {}, loading: false, searching: false }
    const wanted = new Set(search.kinds)
    // Another workspace's answer is never narrowed into this one's.
    const sameWorkspace = answer.key.split('|')[0] === (workspace ?? '')
    const shown = answer.key === key ? answer.records : sameWorkspace ? narrow(answer.records, q) : {}
    const records: MenuRecords = {}
    for (const kind of wanted) {
      const skip = new Set(exclude[kind] ?? [])
      records[kind] = (shown[kind] ?? []).filter((row) => !skip.has(menuRowId(row)))
    }
    const empty = Object.values(records).every((rows) => !rows?.length)
    return { records, loading: pending === key && empty, searching: pending === key }
    // `excludeKey` stands for `exclude` (new arrays each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, key, q, pending, kindsKey, excludeKey, workspace])
}
