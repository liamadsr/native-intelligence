'use client'

/**
 * The Team chat sub-nav's own choices, kept on this device (Liam, 11-11:
 * "make the team-chat one look like this"; ./team-chat-panel.tsx):
 *
 *   ni:team-chat-panel:mode               'all' or 'recent' (default all)
 *   ni:team-chat-panel:sort               each sorted section's order:
 *                                         { team, channels, dms }, each
 *                                         'recent' (default) or 'az'
 *   ni:team-chat-panel:favorites:<ws>     the starred conversations' ids,
 *                                         in the order starred, per workspace
 *
 * Favorites are per device for this draft. SEAM: a server-side version is
 * planned (a per-member row, so they follow the person to every device).
 * It replaces readFavorites/writeFavorites below and nothing else: the panel
 * only calls useTeamChatFavorites and toggleTeamChatFavorite.
 *
 * Every read and write is in a try (a private window, blocked storage): the
 * panel works without it, on the defaults. One cached value per key, so a
 * read is stable between changes (useSyncExternalStore); another tab's write
 * is heard (`storage`).
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_TEAM_CHAT_SORTS, type TeamChatPanelMode, type TeamChatSort, type TeamChatSortedSection, type TeamChatSorts } from './team-chat-panel-model'

export const TEAM_CHAT_MODE_KEY = 'ni:team-chat-panel:mode'
export const TEAM_CHAT_SORT_KEY = 'ni:team-chat-panel:sort'
const FAVORITES_PREFIX = 'ni:team-chat-panel:favorites:'
export const teamChatFavoritesKey = (workspaceId: string): string => `${FAVORITES_PREFIX}${workspaceId}`

/** At most this many favorites kept (a short list by nature). */
const FAVORITES_MAX = 100

const cache = new Map<string, unknown>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function readRaw(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage blocked: kept for this page load only.
  }
}

function cached<T>(key: string, parse: (raw: string | null) => T): T {
  if (!cache.has(key)) cache.set(key, parse(readRaw(key)))
  return cache.get(key) as T
}

function put<T>(key: string, value: T, raw: string): void {
  cache.set(key, value)
  writeRaw(key, raw)
  notify()
}

function onStorage(e: StorageEvent): void {
  if (e.key === null) cache.clear()
  else if (e.key === TEAM_CHAT_MODE_KEY || e.key === TEAM_CHAT_SORT_KEY || e.key.startsWith(FAVORITES_PREFIX)) cache.delete(e.key)
  else return
  notify()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

// ── All | Recent ────────────────────────────────────────────────────────────

const parseMode = (raw: string | null): TeamChatPanelMode => (raw === 'recent' ? 'recent' : 'all')

export function useTeamChatPanelMode(): TeamChatPanelMode {
  return useSyncExternalStore(subscribe, () => cached(TEAM_CHAT_MODE_KEY, parseMode), () => 'all')
}

export function setTeamChatPanelMode(mode: TeamChatPanelMode): void {
  put(TEAM_CHAT_MODE_KEY, mode, mode)
}

// ── Each section's order ────────────────────────────────────────────────────

function parseSorts(raw: string | null): TeamChatSorts {
  if (!raw) return DEFAULT_TEAM_CHAT_SORTS
  try {
    const value = JSON.parse(raw) as Partial<Record<TeamChatSortedSection, unknown>>
    const pick = (s: TeamChatSortedSection): TeamChatSort => (value?.[s] === 'az' ? 'az' : 'recent')
    return { team: pick('team'), channels: pick('channels'), dms: pick('dms') }
  } catch {
    return DEFAULT_TEAM_CHAT_SORTS
  }
}

export function useTeamChatSorts(): TeamChatSorts {
  return useSyncExternalStore(subscribe, () => cached(TEAM_CHAT_SORT_KEY, parseSorts), () => DEFAULT_TEAM_CHAT_SORTS)
}

export function setTeamChatSort(section: TeamChatSortedSection, sort: TeamChatSort): void {
  const next = { ...cached(TEAM_CHAT_SORT_KEY, parseSorts), [section]: sort }
  put(TEAM_CHAT_SORT_KEY, next, JSON.stringify(next))
}

// ── Favorites (per device, per workspace: see SEAM above) ───────────────────

const NO_FAVORITES: readonly string[] = Object.freeze([])

function parseFavorites(raw: string | null): readonly string[] {
  if (!raw) return NO_FAVORITES
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return NO_FAVORITES
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))].slice(0, FAVORITES_MAX)
  } catch {
    return NO_FAVORITES
  }
}

function readFavorites(workspaceId: string): readonly string[] {
  return cached(teamChatFavoritesKey(workspaceId), parseFavorites)
}

function writeFavorites(workspaceId: string, ids: readonly string[]): void {
  put(teamChatFavoritesKey(workspaceId), ids, JSON.stringify(ids))
}

/** The starred conversations' ids in this workspace, in the order starred (none without a workspace). */
export function useTeamChatFavorites(workspaceId: string | null): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => (workspaceId ? readFavorites(workspaceId) : NO_FAVORITES),
    () => NO_FAVORITES,
  )
}

/** Star a conversation (last in Favorites), or unstar it. */
export function toggleTeamChatFavorite(workspaceId: string | null, id: string): void {
  if (!workspaceId) return
  const was = readFavorites(workspaceId)
  writeFavorites(workspaceId, was.includes(id) ? was.filter((x) => x !== id) : [...was, id].slice(-FAVORITES_MAX))
}

/** Tests: forget what was read (storage itself is the test's to clear). */
export function __resetTeamChatPanelPrefsForTests(): void {
  cache.clear()
}
