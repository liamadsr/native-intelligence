'use client'

/**
 * The picker lists a bot's cards edit with (bots-v4.md Phase 3, "Everything
 * waiting, settled at the bot"): the projects, members and agents of each
 * card's own workspace, for the real AttentionCard's pills in the For you
 * column and on a bot's page. Loaded ONCE per page, not per host: AgentInfraHost, which
 * lives for the page, holds the one useRailPickerData (its cache lives as long
 * as it does) and publishes its lookup here (`publishCardPickers`); every card
 * host reads it (`useCardPickers`), naming the workspaces its cards are in.
 *
 * Lazy, as the rail was: a workspace's lists are fetched only once a host has
 * a card in it to show (`useCardPickers` names it; AgentInfraHost loads what's
 * named: `useWantedCardWorkspaces`), and each once for the page's life. A
 * host that stops naming one (unmounting) fetches nothing again when it
 * comes back. With no AgentInfraHost on the page (a test, or no dashboard),
 * every lookup is null and the cards' pills stay read-only;
 * Accept, Start and Dismiss still work (the server owns those).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { RailPickerData } from '@/hooks/use-rail-picker-data'

/** One workspace's lists, or null while they haven't loaded (or nobody holds them). */
export type CardPickerLookup = (workspaceId: string) => RailPickerData | null

let lookup: CardPickerLookup | null = null
const lookupListeners = new Set<() => void>()

/** Workspaces a host has a card in, with how many hosts name each. */
const wanted = new Map<string, number>()
let wantedKey = ''
const wantedListeners = new Set<() => void>()

function emit(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) listener()
}

/** AgentInfraHost's lookup (useRailPickerData's `get`), or null as it goes. */
export function publishCardPickers(next: CardPickerLookup | null): void {
  if (lookup === next) return
  lookup = next
  emit(lookupListeners)
}

function want(ids: readonly string[], by: 1 | -1): void {
  for (const id of ids) {
    const n = (wanted.get(id) ?? 0) + by
    if (n > 0) wanted.set(id, n)
    else wanted.delete(id)
  }
  const key = [...wanted.keys()].sort().join(',')
  if (key === wantedKey) return
  wantedKey = key
  emit(wantedListeners)
}

const splitCache = new Map<string, string[]>()
/** The ids in `key`, the same array for the same key. */
function idsOf(key: string): string[] {
  let ids = splitCache.get(key)
  if (!ids) {
    ids = key ? key.split(',') : []
    if (splitCache.size > 16) splitCache.clear()
    splitCache.set(key, ids)
  }
  return ids
}

/**
 * The workspaces any host has a card in now, for AgentInfraHost to load (its
 * useRailPickerData keeps what it has loaded, so a workspace no longer named
 * isn't fetched again when it is). The same array while the set doesn't change.
 */
export function useWantedCardWorkspaces(): string[] {
  const key = useSyncExternalStore(
    (listener) => {
      wantedListeners.add(listener)
      return () => wantedListeners.delete(listener)
    },
    () => wantedKey,
    () => '',
  )
  return idsOf(key)
}

/**
 * The lists for a host's cards: names `workspaceIds` (the workspaces its cards
 * are in) for as long as it's mounted, and returns the lookup, live. Null for
 * a workspace not loaded yet, or with no AgentInfraHost to load it.
 */
export function useCardPickers(workspaceIds: readonly string[]): CardPickerLookup {
  const key = [...new Set(workspaceIds)].sort().join(',')
  useEffect(() => {
    const ids = idsOf(key)
    if (ids.length === 0) return
    want(ids, 1)
    return () => want(ids, -1)
  }, [key])
  const current = useSyncExternalStore(
    (listener) => {
      lookupListeners.add(listener)
      return () => lookupListeners.delete(listener)
    },
    () => lookup,
    () => null,
  )
  return useCallback((workspaceId: string) => current?.(workspaceId) ?? null, [current])
}

/** Tests only: no lookup, nothing wanted. */
export function __resetCardPickersForTests(): void {
  lookup = null
  wanted.clear()
  wantedKey = ''
  splitCache.clear()
}
