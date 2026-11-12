'use client'

/**
 * One list of a looked-up site's backlinks profile (the links, the linking
 * sites, or its most-linked pages), a page at a time from POST
 * …/backlinks/profile. Every page is paid unless the route answers from its
 * stored copy (12 hours), so nothing loads by itself: the tab's "Load …"
 * button starts it, and after that a sort, a filter or "Show more" asks again
 * (the spend line is read again after anything that spent).
 *
 * The state lives in the site's view, so a tab switch keeps what was loaded;
 * a request counter keeps a slow answer from overwriting a newer one.
 */
import * as React from 'react'
import {
  BACKLINKS_DEFAULT_SORT,
  DEFAULT_BACKLINKS_PAGE_SIZE,
  type BacklinksOverview,
  type BacklinksProfilePage,
  type BacklinksRowsFilters,
  type BacklinksTab,
} from '@/lib/seo/backlinks/view'
import { errorMessage } from '../api'
import { fetchProfile, paidFailure } from './api'
import { LIST_WORDS } from './helpers'

export type ProfileRow<T extends BacklinksTab> = Extract<BacklinksProfilePage, { tab: T }>['rows'][number]

export interface ProfileControls {
  sort: string
  /** The Links tab's filters (the other tabs ignore them). */
  hideLost: boolean
  hideSpam: boolean
  /** Words the linking address must contain (the route's `include`). */
  include: string
  /** One linking site's links only (from the Sites tab's "See its links"). */
  domainFrom: string | null
}

export function defaultControls(tab: BacklinksTab): ProfileControls {
  return { sort: BACKLINKS_DEFAULT_SORT[tab].field, hideLost: false, hideSpam: true, include: '', domainFrom: null }
}

export interface ProfileProblem {
  kind: 'limit' | 'field' | 'failed'
  message: string
}

export const PAGE_SIZE = DEFAULT_BACKLINKS_PAGE_SIZE

/** The request body's filters for a tab's controls. */
export function profileFilters(tab: BacklinksTab, c: ProfileControls): BacklinksRowsFilters {
  const include = c.include.trim()
  if (tab !== 'backlinks') return include ? { include } : {}
  return {
    ...(include ? { include } : {}),
    ...(c.hideLost ? { hideLost: true } : {}),
    ...(c.domainFrom ? { domainFrom: c.domainFrom } : {}),
  }
}

export function useProfile<T extends BacklinksTab>(
  tab: T,
  overview: BacklinksOverview,
  { canBuy, onSpent, onOff }: { canBuy: boolean; onSpent: () => void; onOff: (err: unknown) => void },
) {
  const [controls, setControls] = React.useState<ProfileControls>(() => defaultControls(tab))
  const [started, setStarted] = React.useState(false)
  const [rows, setRows] = React.useState<Array<ProfileRow<T>>>([])
  const [page, setPage] = React.useState(0)
  const [hasMore, setHasMore] = React.useState(false)
  const [total, setTotal] = React.useState<number | null>(null)
  const [stored, setStored] = React.useState<{ from_cache: boolean; fetched_at: string } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [problem, setProblem] = React.useState<ProfileProblem | null>(null)
  const asked = React.useRef(0)
  const current = React.useRef(controls)
  const latest = React.useRef({ canBuy, onSpent, onOff })
  React.useEffect(() => {
    latest.current = { canBuy, onSpent, onOff }
  })

  const load = React.useCallback(
    async (c: ProfileControls, nextPage: number, refresh = false) => {
      if (!latest.current.canBuy) return
      const ask = ++asked.current
      setStarted(true)
      setProblem(null)
      setLoading(true)
      if (nextPage === 1) setRows([])
      try {
        const out = await fetchProfile({
          tab,
          target: overview.display_target,
          scope: overview.scope,
          page: nextPage,
          page_size: PAGE_SIZE,
          sort_field: c.sort,
          sort_order: 'desc',
          filters: profileFilters(tab, c),
          ...(tab === 'backlinks' ? { mode: c.domainFrom ? 'as_is' : 'one_per_domain', hide_spam: c.hideSpam } : {}),
          refresh,
        })
        if (ask !== asked.current) return
        if (!out.from_cache) latest.current.onSpent()
        const got = out.rows as Array<ProfileRow<T>>
        setRows((r) => (nextPage > 1 ? [...r, ...got] : got))
        setPage(nextPage)
        setHasMore(out.has_more)
        setTotal(out.total_count)
        if (nextPage === 1) setStored({ from_cache: out.from_cache, fetched_at: out.fetched_at })
      } catch (err) {
        if (ask !== asked.current) return
        const failure = paidFailure(err)
        if (failure === 'off') latest.current.onOff(err)
        setProblem({
          kind: failure === 'limit' ? 'limit' : failure === 'field' ? 'field' : 'failed',
          message: failure === 'failed' || failure === 'off' ? LIST_WORDS[tab].failed : errorMessage(err, LIST_WORDS[tab].failed),
        })
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [tab, overview.display_target, overview.scope],
  )

  /** The tab's "Load …" button: the first page with the controls as they are. */
  const start = React.useCallback(() => void load(current.current, 1), [load])
  /** A sort or filter changed: the first page again (it spends unless stored). */
  const change = React.useCallback(
    (patch: Partial<ProfileControls>) => {
      const next = { ...current.current, ...patch }
      current.current = next
      setControls(next)
      void load(next, 1)
    },
    [load],
  )
  const more = React.useCallback(() => {
    if (hasMore) void load(current.current, page + 1)
  }, [load, hasMore, page])
  const retry = React.useCallback(() => void load(current.current, rows.length > 0 ? page + 1 : 1), [load, rows.length, page])
  /** Buy the first page again, fresh. */
  const refresh = React.useCallback(() => void load(current.current, 1, true), [load])

  return { tab, controls, change, started, start, rows, hasMore, total, stored, loading, problem, more, retry, refresh }
}

export type ProfileState<T extends BacklinksTab> = ReturnType<typeof useProfile<T>>
