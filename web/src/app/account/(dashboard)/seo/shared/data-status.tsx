'use client'

/**
 * Search data on the SEO pages: whether lookups can be made at all, and the
 * month's spend, read once from GET /api/account/seo/spend (free).
 *
 *   useSeoData()        the read, with a `refresh` to call after a lookup.
 *   SeoDataNotice       the page-sized notice when lookups are off for this
 *                       server (no provider key) or this person (free plan):
 *                       a first-run style block, never a broken page.
 *   SeoSpendLine        the quiet line "$3.40 of $20 this month · resets
 *                       Dec 1" (text only, like prospecting's): amber when
 *                       what is left is small.
 *   buyBlockedReason    why a control that spends is disabled, for its
 *                       `title`: a disabled control keeps its place and says why.
 *
 * What a workspace already looked up stays readable when lookups are off:
 * pages gate their buying controls, not their stored results.
 */
import * as React from 'react'
import { SearchX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SeoSpendView } from '@/lib/seo/spend-view'

export interface SeoDataState {
  /** null until the first read answers. */
  view: SeoSpendView | null
  loading: boolean
  /** The read failed: lookups are attempted as usual and the route answers for itself. */
  failed: boolean
  refresh: () => void
}

export function useSeoData(): SeoDataState {
  const [view, setView] = React.useState<SeoSpendView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(() => {
    const ask = ++asked.current
    fetch('/api/account/seo/spend')
      .then(async (res) => {
        if (!res.ok) throw new Error(`spend ${res.status}`)
        return (await res.json()) as SeoSpendView
      })
      .then((next) => {
        if (ask !== asked.current) return
        setView(next)
        setFailed(false)
      })
      .catch(() => {
        // A footnote's read: a failure keeps the last good answer and shows nothing new.
        if (ask === asked.current) setFailed(true)
      })
      .finally(() => {
        if (ask === asked.current) setLoading(false)
      })
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  return { view, loading, failed, refresh: load }
}

/** Why a control that buys data is off, for its `title`; null when it may be used. */
export function buyBlockedReason(view: SeoSpendView | null): string | null {
  if (!view || view.can_buy) return null
  if (view.refusal?.code === 'FREE_PLAN') return 'Part of the paid plan'
  if (view.refusal?.code === 'NOT_A_MEMBER') return 'For workspace members'
  if (view.refusal?.code === 'SEO_NOT_CONFIGURED') return 'Search data isn’t set up on this server yet'
  return view.refusal?.message ?? 'Search data is off'
}

const dollars = (n: number) => `$${n.toFixed(2)}`

export function spendLineText(view: Pick<SeoSpendView, 'spent_dollars' | 'cap_dollars' | 'resets_at'>): string {
  const resets = new Date(view.resets_at)
  const when = Number.isNaN(resets.getTime()) ? null : resets.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const cap = Number.isInteger(view.cap_dollars) ? `$${view.cap_dollars}` : dollars(view.cap_dollars)
  return `${dollars(view.spent_dollars)} of ${cap} this month${when ? ` · resets ${when}` : ''}`
}

/** The month's search data spend, quietly. Nothing until it is known; nothing where lookups are off. */
export function SeoSpendLine({ view, warnBelow = 1, className }: { view: SeoSpendView | null; warnBelow?: number; className?: string }) {
  if (!view || !view.configured) return null
  const low = view.cap_dollars - view.spent_dollars <= warnBelow
  return (
    <span
      data-seo-spend=""
      className={cn('text-[11px] tabular-nums', low ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground', className)}
      title={low ? 'This workspace is close to its search data limit for the month' : 'What this workspace has spent on search data this calendar month'}
    >
      {spendLineText(view)}
    </span>
  )
}

/**
 * In place of a page's buying controls when lookups are off: says which and
 * why, in the first-run block's look. `what` names the page's data
 * ("Keyword data", "Rank tracking").
 */
export function SeoDataNotice({ view, what, className }: { view: SeoSpendView; what: string; className?: string }) {
  if (view.can_buy || !view.refusal) return null
  const code = view.refusal.code
  const title =
    code === 'SEO_NOT_CONFIGURED'
      ? `${what} isn’t set up yet`
      : code === 'FREE_PLAN'
        ? `${what} is part of the paid plan`
        : code === 'NOT_A_MEMBER'
          ? `${what} is for workspace members`
          : `${what} is off right now`
  const body =
    code === 'SEO_NOT_CONFIGURED'
      ? 'This server has no search data provider connected, so nothing can be looked up here yet. The site audit works without it.'
      : code === 'FREE_PLAN'
        ? 'Looking this up is bought per search, so it comes with the paid plan. The site audit is free.'
        : code === 'NOT_A_MEMBER'
          ? 'Lookups spend the workspace’s budget, so a guest can read what is already here but not start new ones. Ask a member to run it.'
          : view.refusal.message
  return (
    <div data-seo-data-off={view.refusal.code} className={cn('mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-16 text-center', className)}>
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
