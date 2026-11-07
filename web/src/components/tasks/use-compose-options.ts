'use client'

/**
 * The compose panel's option loader: everything it needs to ASK a provider,
 * and nothing about what it then draws.
 *
 * Split out of the panel for one reason that matters and one that doesn't. The
 * one that matters: these reads are cached SWR reads through `cachedJson`, and
 * a cache is only correct if its KEYS are, so the key construction wants to sit
 * in one place next to the requests it scopes rather than sprinkled through
 * JSX. The one that doesn't: the panel is long enough already.
 *
 * THREE RULES run through everything below.
 *
 * 1. NOTHING LOADS ON ROW RENDER. Every function here is called from the
 *    panel's open effect or from a field the user just changed. A view can
 *    mount five hundred action rows; if opening the icon cost a request, so
 *    would scrolling past it.
 *
 * 2. A FAILURE IS CLASSIFIED, NOT SWALLOWED. `not_connected` and
 *    `reconnect_required` mean the dropdowns can never populate and the fix is
 *    a reconnect — the same two codes and the same conclusion as the settings
 *    pickers (TASK_PICKER_RECONNECT_CODES). Anything else is a retryable
 *    message. Falling back to `[]` would render "you have no projects" over a
 *    revoked token, which is the exact bug the settings pickers already learned
 *    not to have.
 *
 * 3. TYPED QUERIES BYPASS THE CACHE. A search-as-you-type read is a different
 *    kind of thing from "the list this panel opens with": it is per-keystroke,
 *    unbounded in key space, and stale by design a moment later. Caching it
 *    would fill a 100-entry LRU with one user's typing and evict the lists that
 *    are actually re-read. So `cachedJson` covers the openers; typed queries go
 *    straight to `fetch`.
 */

import { useCallback, useRef, useState } from 'react'
import { cachedJson } from '@/lib/cached-fetch'

/** The two codes that mean "reconnect", shared with the settings pickers. */
export const COMPOSE_RECONNECT_CODES = new Set(['reconnect_required', 'not_connected'])

/** What went wrong loading options, in the only two flavours the panel draws. */
export type ComposeLoadFailure =
  | { kind: 'reconnect' }
  | { kind: 'error'; message: string }

export interface ComposeFetchResult<T> {
  data: T | null
  failure: ComposeLoadFailure | null
}

/**
 * One option-route read, classified.
 *
 * `cache: false` for typed queries (rule 3). The scope is always the workspace
 * id, because every one of these routes resolves the workspace from cookies —
 * the url alone does not identify the answer, so an unscoped key would serve
 * one workspace's projects to another after a switch.
 */
export async function fetchComposeOptions<T>(
  url: string,
  opts: { scope: string; cache?: boolean },
): Promise<ComposeFetchResult<T>> {
  try {
    if (opts.cache !== false) {
      const cached = await cachedJson<T>(url, { scope: opts.scope })
      // cachedJson collapses every failure to null — it cannot tell a 400 from
      // a network drop — so a null answer is re-read once, uncached, purely to
      // learn WHICH failure it was. That second request only ever happens on a
      // path that is already broken.
      if (cached !== null) return { data: cached, failure: null }
    }
    const res = await fetch(url)
    if (res.ok) return { data: (await res.json()) as T, failure: null }
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
    if (body.code && COMPOSE_RECONNECT_CODES.has(body.code)) {
      return { data: null, failure: { kind: 'reconnect' } }
    }
    return { data: null, failure: { kind: 'error', message: body.error || 'Could not load options' } }
  } catch {
    return { data: null, failure: { kind: 'error', message: 'Could not load options' } }
  }
}

// ---------------------------------------------------------------------------
// Option shapes — the exact response bodies of the phase-1 routes
// ---------------------------------------------------------------------------

export interface JiraProjectOption {
  id: string
  key: string
  name: string
}
export interface JiraIssueTypeOption {
  id: string
  name: string
}
export interface JiraUserOption {
  account_id: string
  display_name: string
  /** Nullable BY DESIGN — Jira blanks it per the user's privacy setting. */
  email: string | null
  active: boolean
}
export interface ComposeOption {
  id: string
  name: string
}
export interface JiraComposeMeta {
  has_due_date: boolean
  due_date_required: boolean
  has_labels: boolean
  labels_required: boolean
  has_assignee: boolean
  assignee_required: boolean
  has_priority: boolean
  priority_required: boolean
  priorities: ComposeOption[]
  custom_fields: Array<{
    field_id: string
    name: string
    required: boolean
    options: ComposeOption[]
  }>
  blocking_fields: Array<{ field_id: string; name: string; schema_type: string | null }>
}

export interface AsanaProjectOption {
  gid: string
  name: string
}
export interface AsanaSectionOption {
  gid: string
  name: string
}
export interface AsanaUserOption {
  gid: string
  name: string
  email: string | null
}

export interface LinearTeamOption {
  id: string
  key: string | null
  name: string
}
export interface LinearProjectOption {
  id: string
  name: string
}
export interface LinearMemberOption {
  id: string
  name: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}
export interface LinearLabelOption {
  id: string
  name: string
  color: string | null
  scope: 'team' | 'workspace'
}

// ---------------------------------------------------------------------------
// The panel's slot machinery
// ---------------------------------------------------------------------------

/** One dropdown's worth of state, as the panel renders it. */
export interface OptionSlot<T> {
  options: T[]
  loading: boolean
  /** Set once, by whichever slot failed first — the panel shows one banner. */
  failure: ComposeLoadFailure | null
}

const EMPTY_SLOT: OptionSlot<never> = { options: [], loading: false, failure: null }

export function emptySlot<T>(): OptionSlot<T> {
  return EMPTY_SLOT as unknown as OptionSlot<T>
}

/**
 * A named bag of option slots with one loader per name.
 *
 * The generic map (rather than a field per provider) is what keeps the panel's
 * three provider forms from each growing their own copy of "loading, then
 * options or a failure, and drop the answer if a newer request has started".
 * That last clause is the whole reason this is a hook: a project picker that
 * applied a slow first answer over a fast second one would silently show the
 * wrong project's sections.
 */
export function useOptionSlots(scope: string) {
  const [slots, setSlots] = useState<Record<string, OptionSlot<unknown>>>({})
  /** Per-slot request generation — an older answer never lands on a newer one. */
  const generation = useRef<Record<string, number>>({})

  const load = useCallback(
    async <T,>(
      name: string,
      url: string,
      extract: (data: unknown) => T[],
      options?: { cache?: boolean },
    ): Promise<void> => {
      const gen = (generation.current[name] ?? 0) + 1
      generation.current[name] = gen
      setSlots((prev) => ({
        ...prev,
        [name]: { options: prev[name]?.options ?? [], loading: true, failure: null },
      }))
      const result = await fetchComposeOptions<unknown>(url, {
        scope,
        ...(options?.cache === false ? { cache: false } : {}),
      })
      if (generation.current[name] !== gen) return
      setSlots((prev) => ({
        ...prev,
        [name]: {
          options: result.data ? extract(result.data) : [],
          loading: false,
          failure: result.failure,
        },
      }))
    },
    [scope],
  )

  /** Drop a slot's answer AND invalidate its in-flight request (a parent changed). */
  const reset = useCallback((name: string) => {
    generation.current[name] = (generation.current[name] ?? 0) + 1
    setSlots((prev) => ({ ...prev, [name]: emptySlot() }))
  }, [])

  const clearAll = useCallback(() => {
    for (const name of Object.keys(generation.current)) {
      generation.current[name] = (generation.current[name] ?? 0) + 1
    }
    setSlots({})
  }, [])

  const slot = useCallback(
    <T,>(name: string): OptionSlot<T> => (slots[name] as OptionSlot<T>) ?? emptySlot<T>(),
    [slots],
  )

  /**
   * The first failure across every slot — the panel raises ONE banner, because
   * a dead token fails every picker at once and three identical banners is
   * three times the noise for the same fact.
   */
  const failure = Object.values(slots).find((s) => s.failure)?.failure ?? null

  return { slot, load, reset, clearAll, failure }
}
