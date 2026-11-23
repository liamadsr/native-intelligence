'use client'

/**
 * Reviews as a card (docs/plans/github-reviews.md, phase 1): the person's
 * GitHub pull requests, read live from GitHub with their own sign-in
 * (GET /api/account/github/reviews).
 *
 *   Sections  Review requests, Authored by me, Assigned to me, Involves me.
 *   Filters   Open / Closed / All; repo, author, assignee, label, review
 *             state, linked work; sorted by recently updated or newest.
 *   Layouts   List, and Board (Draft, In review, Checks failing, Conflicts,
 *             Ready to merge, Merged: lib/github/reviews.ts boardColumn).
 *   A row     opens the pull request's panel (./reviews/pull-panel.tsx): its
 *             description, checks, linked actions, the files changed with a
 *             read-only diff, and Merge (only when ready, confirmed first).
 *             Approving and commenting stay on GitHub: the panel links out.
 *   A linked  action opens over the page, inside the card, as Files opens a
 *             record.
 *
 * The section, filters and layout are remembered on this device.
 */
import * as React from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { GitPullRequest, LayoutGrid, List, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  LINKED_FILTERS,
  REVIEW_DECISIONS,
  REVIEW_SECTIONS,
  REVIEW_STATES,
  SECTION_LABEL,
  boardColumn,
  prKey,
  reviewFiltersQuery,
  type BoardColumn,
  type ReviewFilters,
  type ReviewPr,
} from '@/lib/github/reviews'
import { CardCovered } from '../card-covered'
import { CardHeaderSlot, useCardHeaderSlots } from '../card-header-slot'
import { RecordOverlay, usePageRecords } from './record-overlay'
import { usePagePlace, type PageCardProps } from './page-card'
import { PullPanel } from './reviews/pull-panel'
import { ChecksIcon, PrStateIcon } from './reviews/icons'

const PREFS_KEY = 'ni:reviews:prefs'

type Layout = 'list' | 'board'

interface Prefs {
  filters: ReviewFilters
  layout: Layout
}

const DEFAULT_PREFS: Prefs = {
  filters: { section: 'review_requests', state: 'open', sort: 'updated', linked: 'any' },
  layout: 'list',
}

function readPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Partial<Prefs>
    return {
      layout: p.layout === 'board' ? 'board' : 'list',
      filters: { ...DEFAULT_PREFS.filters, ...(p.filters ?? {}) },
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(p: Prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* private mode: kept for the visit only */
  }
}

interface ReviewsAnswer {
  viewer?: { login: string | null }
  total?: number
  cursor?: string | null
  prs?: ReviewPr[]
  error?: string
  code?: string
}

function useReviews(filters: ReviewFilters) {
  const [prs, setPrs] = React.useState<ReviewPr[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [total, setTotal] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<{ message: string; code?: string } | null>(null)
  const query = reviewFiltersQuery(filters)
  const seq = React.useRef(0)

  const load = React.useCallback(
    async (after: string | null) => {
      const n = ++seq.current
      setLoading(true)
      if (!after) setError(null)
      try {
        const res = await fetch(`/api/account/github/reviews?${query}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
        const json = (await res.json().catch(() => ({}))) as ReviewsAnswer
        if (n !== seq.current) return
        if (!res.ok) {
          setError({ message: json.error ?? 'Could not load your pull requests.', code: json.code })
          if (!after) setPrs([])
          setCursor(null)
          return
        }
        const page = json.prs ?? []
        setPrs((prev) => (after ? [...prev, ...page.filter((p) => !prev.some((q) => q.id === p.id))] : page))
        setCursor(json.cursor ?? null)
        setTotal(typeof json.total === 'number' ? json.total : null)
      } catch {
        if (n === seq.current) setError({ message: 'Could not reach the server.' })
      } finally {
        if (n === seq.current) setLoading(false)
      }
    },
    [query],
  )

  React.useEffect(() => {
    void load(null)
  }, [load])

  return { prs, cursor, total, loading, error, reload: () => load(null), more: () => cursor && load(cursor) }
}

export default function ReviewsCard(props: PageCardProps) {
  const { toolCallId, store, onCount } = props
  const records = usePageRecords(toolCallId, store)
  const inCard = useCardHeaderSlots() !== null
  const [prefs, setPrefs] = React.useState<Prefs>(DEFAULT_PREFS)
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    setPrefs(readPrefs())
    setReady(true)
  }, [])
  const update = React.useCallback((patch: Partial<ReviewFilters> | null, layout?: Layout) => {
    setPrefs((p) => {
      const next = { layout: layout ?? p.layout, filters: patch ? { ...p.filters, ...patch } : p.filters }
      writePrefs(next)
      return next
    })
  }, [])

  const { prs, cursor, total, loading, error, reload, more } = useReviews(prefs.filters)
  // The panel open is the card's place (`owner/name#12`): a GitHub notice opens the card on it, and Back walks it.
  const place = usePagePlace(props)
  const openKey = place.at?.type === 'github_pr' ? place.at.id : null
  const setOpenKey = React.useCallback(
    (key: string | null) => {
      if (!key) return place.go(null)
      const pr = prs.find((p) => prKey(p.repo, p.number) === key)
      place.go({ type: 'github_pr', id: key, ...(pr ? { label: pr.title } : {}) })
    },
    [place, prs],
  )
  const open = openKey ? (prs.find((p) => prKey(p.repo, p.number) === openKey) ?? stubPr(openKey, place.at?.label)) : null
  const [focus, setFocus] = React.useState(0)

  React.useEffect(() => {
    onCount?.(loading || !ready ? null : (total ?? prs.length))
  }, [onCount, loading, ready, total, prs.length])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (prefs.layout !== 'list' || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      setFocus((i) => Math.min(prs.length - 1, i + 1))
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus((i) => Math.max(0, i - 1))
    } else if ((e.key === 'Enter' || e.key === 'o') && prs[focus] && t.tagName !== 'BUTTON' && t.tagName !== 'A') {
      e.preventDefault()
      setOpenKey(prKey(prs[focus].repo, prs[focus].number))
    }
  }

  const notConnected = error?.code === 'github_not_connected' || error?.code === 'github_unauthorized'
  const f = prefs.filters

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
        {inCard && (
          <CardHeaderSlot side="right">
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh"
              data-reviews-refresh=""
              onClick={() => void reload()}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </button>
          </CardHeaderSlot>
        )}
        <div className="flex h-full min-h-0">
          <div className="flex min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
            <div className="flex shrink-0 flex-wrap items-center gap-1 px-5 pt-3">
              <div role="tablist" aria-label="Section" className="flex flex-wrap items-center gap-1">
                {REVIEW_SECTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={f.section === s}
                    data-reviews-section={s}
                    onClick={() => update({ section: s })}
                    className={chip(f.section === s)}
                  >
                    {SECTION_LABEL[s]}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1">
                <div role="radiogroup" aria-label="State" className="flex items-center gap-1">
                  {REVIEW_STATES.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={f.state === s} data-reviews-state={s} onClick={() => update({ state: s })} className={chip(f.state === s)}>
                      {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'All'}
                    </button>
                  ))}
                </div>
                <div role="radiogroup" aria-label="Layout" className="ml-1 flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                  <button type="button" role="radio" aria-checked={prefs.layout === 'list'} aria-label="List" title="List" data-reviews-layout="list" onClick={() => update(null, 'list')} className={iconChip(prefs.layout === 'list')}>
                    <List className="size-3.5" />
                  </button>
                  <button type="button" role="radio" aria-checked={prefs.layout === 'board'} aria-label="Board" title="Board" data-reviews-layout="board" onClick={() => update(null, 'board')} className={iconChip(prefs.layout === 'board')}>
                    <LayoutGrid className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <FilterRow filters={f} onChange={(patch) => update(patch)} />
            <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
              {error ? (
                <div data-reviews-error={error.code ?? ''} className="flex flex-col items-center gap-2 py-16 text-center">
                  <GitPullRequest className="h-7 w-7 text-muted-foreground/60" aria-hidden />
                  <p className="max-w-sm text-sm text-muted-foreground">{error.message}</p>
                  {notConnected && (
                    <a href="/account/settings/connectors" className="text-sm font-medium text-foreground underline underline-offset-2">
                      Open Connectors
                    </a>
                  )}
                </div>
              ) : prs.length === 0 && loading ? (
                <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading pull requests…
                </p>
              ) : prs.length === 0 ? (
                <div data-reviews-empty="" className="flex flex-col items-center gap-2 py-16 text-center">
                  <GitPullRequest className="h-7 w-7 text-muted-foreground/60" aria-hidden />
                  <p className="text-sm text-muted-foreground">No pull requests here.</p>
                </div>
              ) : prefs.layout === 'board' ? (
                <Board prs={prs} onOpen={(p) => setOpenKey(prKey(p.repo, p.number))} openKey={openKey} />
              ) : (
                <ul role="listbox" aria-label="Pull requests" tabIndex={0} className="divide-y divide-border outline-none">
                  {prs.map((p, i) => (
                    <PrRow
                      key={p.id}
                      pr={p}
                      focused={i === focus}
                      selected={openKey === prKey(p.repo, p.number)}
                      onOpen={() => {
                        setFocus(i)
                        setOpenKey(prKey(p.repo, p.number))
                      }}
                      onOpenAction={(id) => records.open({ type: 'action', id })}
                    />
                  ))}
                </ul>
              )}
              {!error && cursor && (
                <div className="flex justify-center pt-3">
                  <button type="button" data-reviews-more="" disabled={loading} onClick={() => void more()} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50">
                    {loading ? 'Loading…' : 'Show more'}
                  </button>
                </div>
              )}
            </div>
          </div>
          {open && (
            <PullPanel
              key={openKey!}
              summary={open}
              onClose={() => setOpenKey(null)}
              onMerged={() => void reload()}
              onOpenAction={(id) => records.open({ type: 'action', id })}
            />
          )}
        </div>
      </CardCovered>
      <RecordOverlay records={records} page={props} />
    </div>
  )
}

/** A pull request not in the list (a notice opened it): its panel reads the rest. */
function stubPr(key: string, title?: string): ReviewPr | null {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(key)
  if (!m) return null
  const [, repo, n] = m
  return {
    id: key, repo, number: Number(n), title: title ?? key, url: `https://github.com/${repo}/pull/${n}`, state: 'open', draft: false,
    mergeable: null, mergeState: null, reviewDecision: null, checks: null, createdAt: '', updatedAt: '', additions: 0, deletions: 0,
    changedFiles: 0, headRef: null, headSha: null, baseRef: null, author: null, labels: [], assignees: [], permission: null, mergeMethods: [], linked: [],
  }
}

function chip(on: boolean) {
  return cn('h-7 rounded-lg px-2.5 text-xs transition-colors', on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')
}

function iconChip(on: boolean) {
  return cn('flex size-6 items-center justify-center rounded-md', on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground')
}

/** A text filter applied on Enter or when the field is left. */
function TextFilter({ label, value, placeholder, onApply, name }: { label: string; value: string | null | undefined; placeholder: string; onApply: (v: string | null) => void; name: string }) {
  const [typed, setTyped] = React.useState(value ?? '')
  React.useEffect(() => setTyped(value ?? ''), [value])
  const apply = () => {
    const v = typed.trim()
    if ((v || null) !== (value ?? null)) onApply(v || null)
  }
  return (
    <input
      aria-label={label}
      data-reviews-filter={name}
      value={typed}
      placeholder={placeholder}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') apply()
      }}
      className="h-7 w-32 min-w-0 rounded-lg border border-border bg-transparent px-2 text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

const REVIEW_LABEL: Record<(typeof REVIEW_DECISIONS)[number], string> = {
  none: 'No reviews',
  required: 'Review required',
  approved: 'Approved',
  changes_requested: 'Changes requested',
}

function FilterRow({ filters, onChange }: { filters: ReviewFilters; onChange: (patch: Partial<ReviewFilters>) => void }) {
  const select = 'h-7 rounded-lg border border-border bg-transparent px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 pb-2 pt-2">
      <TextFilter name="repo" label="Repository" placeholder="owner/repo" value={filters.repo} onApply={(v) => onChange({ repo: v })} />
      <TextFilter name="author" label="Author" placeholder="author" value={filters.author} onApply={(v) => onChange({ author: v })} />
      <TextFilter name="assignee" label="Assignee" placeholder="assignee" value={filters.assignee} onApply={(v) => onChange({ assignee: v })} />
      <TextFilter name="label" label="Label" placeholder="label" value={filters.label} onApply={(v) => onChange({ label: v })} />
      <select aria-label="Review state" data-reviews-filter="review" value={filters.review ?? ''} onChange={(e) => onChange({ review: (e.target.value || null) as ReviewFilters['review'] })} className={select}>
        <option value="">Any review</option>
        {REVIEW_DECISIONS.map((r) => (
          <option key={r} value={r}>
            {REVIEW_LABEL[r]}
          </option>
        ))}
      </select>
      <select aria-label="Linked work" data-reviews-filter="linked" value={filters.linked ?? 'any'} onChange={(e) => onChange({ linked: e.target.value as ReviewFilters['linked'] })} className={select}>
        {LINKED_FILTERS.map((l) => (
          <option key={l} value={l}>
            {l === 'any' ? 'Any work' : l === 'linked' ? 'Linked to an action' : 'Not linked'}
          </option>
        ))}
      </select>
      <select aria-label="Sort" data-reviews-filter="sort" value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as ReviewFilters['sort'] })} className={select}>
        <option value="updated">Recently updated</option>
        <option value="created">Newest</option>
      </select>
    </div>
  )
}

function reviewWord(pr: ReviewPr): string | null {
  if (pr.reviewDecision === 'APPROVED') return 'Approved'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested'
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'Review required'
  return null
}

function ago(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? formatDistanceToNowStrict(t, { addSuffix: true }) : ''
}

function LinkedChips({ pr, onOpenAction }: { pr: ReviewPr; onOpenAction: (id: string) => void }) {
  if (pr.linked.length === 0) return null
  return (
    <>
      {pr.linked.slice(0, 3).map((a) => (
        <button
          key={a.id}
          type="button"
          data-reviews-linked={a.id}
          title={a.title ?? undefined}
          onClick={(e) => {
            e.stopPropagation()
            onOpenAction(a.id)
          }}
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {a.identifier ?? 'Action'}
        </button>
      ))}
    </>
  )
}

function PrRow({ pr, focused, selected, onOpen, onOpenAction }: { pr: ReviewPr; focused: boolean; selected: boolean; onOpen: () => void; onOpenAction: (id: string) => void }) {
  const review = reviewWord(pr)
  const ref = React.useRef<HTMLLIElement>(null)
  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focused])
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      data-reviews-row={prKey(pr.repo, pr.number)}
      onClick={onOpen}
      className={cn('flex cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 hover:bg-muted/40', selected && 'bg-muted/60', focused && 'ring-1 ring-inset ring-ring/40')}
    >
      <PrStateIcon pr={pr} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{pr.title}</span>
          <ChecksIcon checks={pr.checks} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {pr.repo}#{pr.number}
          </span>
          {pr.author && <span>by {pr.author.login}</span>}
          {review && <span className={cn(pr.reviewDecision === 'APPROVED' && 'text-green-600', pr.reviewDecision === 'CHANGES_REQUESTED' && 'text-red-600')}>{review}</span>}
          <span className="tabular-nums">
            <span className="text-green-600">+{pr.additions}</span> <span className="text-red-600">−{pr.deletions}</span>
          </span>
          {pr.labels.slice(0, 3).map((l) => (
            <span key={l.name} className="rounded-full border border-border px-1.5 text-[11px]">
              {l.name}
            </span>
          ))}
          <LinkedChips pr={pr} onOpenAction={onOpenAction} />
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{ago(pr.updatedAt)}</span>
    </li>
  )
}

function Board({ prs, onOpen, openKey }: { prs: ReviewPr[]; onOpen: (pr: ReviewPr) => void; openKey: string | null }) {
  const columns = React.useMemo(() => {
    const by = new Map<BoardColumn, ReviewPr[]>(BOARD_COLUMNS.map((c) => [c, []]))
    let closed = 0
    for (const p of prs) {
      const c = boardColumn(p)
      if (c) by.get(c)!.push(p)
      else closed++
    }
    return { by, closed }
  }, [prs])
  return (
    <div className="pt-1">
      {/* Six columns that share the width, scrolling sideways only when it is narrow. */}
      <div className="grid min-w-[840px] grid-cols-6 gap-3">
        {BOARD_COLUMNS.map((c) => {
          const list = columns.by.get(c)!
          return (
            <section key={c} data-reviews-column={c} aria-label={BOARD_COLUMN_LABEL[c]} className="flex min-w-0 flex-col rounded-xl bg-muted/30 p-2">
              <h3 className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                <span>{BOARD_COLUMN_LABEL[c]}</span>
                <span className="tabular-nums">{list.length}</span>
              </h3>
              <div className="flex flex-col gap-2">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-reviews-card={prKey(p.repo, p.number)}
                    onClick={() => onOpen(p)}
                    className={cn('rounded-lg border border-border bg-background p-2 text-left hover:border-foreground/20', openKey === prKey(p.repo, p.number) && 'border-foreground/30')}
                  >
                    <div className="flex items-start gap-1.5">
                      <PrStateIcon pr={p} className="mt-0.5 size-3.5" />
                      <span className="line-clamp-2 text-xs font-medium text-foreground">{p.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {p.repo.split('/')[1]}#{p.number}
                      </span>
                      <ChecksIcon checks={p.checks} />
                      <span className="ml-auto tabular-nums">
                        <span className="text-green-600">+{p.additions}</span> <span className="text-red-600">−{p.deletions}</span>
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
      {columns.closed > 0 && (
        <p data-reviews-closed-note="" className="pt-3 text-xs text-muted-foreground">
          {columns.closed} closed without merging {columns.closed === 1 ? 'is' : 'are'} not on the board: see them in List.
        </p>
      )}
    </div>
  )
}
