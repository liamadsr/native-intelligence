'use client'

/**
 * The Keywords page's Saved tab: the workspace's saved keywords (free to
 * read and change), a page at a time from GET keywords/saved.
 *
 *   Above the list   a search box, the tags as filter chips (each with its
 *                    count; several match any of them), the sort.
 *   A row            the same grid as Research's, the keyword's tags under
 *                    it, and its market when it differs from the picker's;
 *                    "Numbers from <when>" in the numbers' `title`.
 *   Selecting rows   the island: Refresh numbers (POST keywords/metrics per
 *                    market, which spends, and says so), Tag, Remove
 *                    (ConfirmDialog).
 *   Empty            "No saved keywords yet" and a way to Research.
 *
 * Lookups off: the list still works; Refresh numbers stays, disabled, saying why.
 */
import * as React from 'react'
import { Bookmark, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SavedKeyword, SavedKeywordTagCount } from '@/lib/seo/keywords/view'
import { normalizeTag } from '@/lib/seo/keywords/view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { count, relativeWhen } from '../ui-helpers'
import { fetchKeywordMetrics, fetchSaved, removeSaved, retagSaved } from './api'
import { FilterField, SmallSelect } from './controls'
import { SAVED_SORT_OPTIONS, marketLabel, sameMarket, type Market } from './keyword-helpers'
import { ISLAND_BUTTON, KeywordGridHeader, KeywordGridRow, SelectionIsland, ShowMore } from './keyword-rows'
import { ProblemBanner, problemOf, type Problem } from './problem'

const LIMIT = 50

export function SavedTab({
  market,
  version,
  blocked,
  onSpent,
  onTotal,
  onResearch,
}: {
  /** The picker's market: a row in another one says which. */
  market: Market
  /** Bumped when keywords were saved elsewhere: the list reads again. */
  version: number
  /** Why buying is off (Refresh numbers waits, saying so), or null. */
  blocked: string | null
  onSpent: () => void
  /** How many saved keywords match what is shown, for the card header and the tab. */
  onTotal: (total: number | null) => void
  onResearch: () => void
}) {
  const [typed, setTyped] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [tags, setTags] = React.useState<ReadonlySet<string>>(() => new Set())
  const [sortKey, setSortKey] = React.useState(SAVED_SORT_OPTIONS[0].value)
  const [rows, setRows] = React.useState<SavedKeyword[]>([])
  const [tagCounts, setTagCounts] = React.useState<SavedKeywordTagCount[]>([])
  const [total, setTotal] = React.useState<number | null>(null)
  const [next, setNext] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [problem, setProblem] = React.useState<Problem | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const asked = React.useRef(0)

  // The search box asks once typing pauses.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])

  const sort = SAVED_SORT_OPTIONS.find((o) => o.value === sortKey) ?? SAVED_SORT_OPTIONS[0]
  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setError(false)
      try {
        const page = await fetchSaved({ offset, limit: LIMIT, search, tags: [...tags], sort: sort.sort, dir: sort.dir })
        if (ask !== asked.current) return
        setRows((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
        setTotal(page.total)
        setTagCounts(page.tags)
        if (!offset) setSelected(new Set())
      } catch {
        if (ask === asked.current) setError(true)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [search, tags, sort.sort, sort.dir],
  )

  React.useEffect(() => {
    void load(0)
  }, [load, version])

  React.useEffect(() => {
    onTotal(total)
  }, [onTotal, total])

  const filtered = search !== '' || tags.size > 0
  const picked = rows.filter((r) => selected.has(r.id))
  const toggle = (id: string) =>
    setSelected((prev) => {
      const nextSet = new Set(prev)
      if (nextSet.has(id)) nextSet.delete(id)
      else nextSet.add(id)
      return nextSet
    })
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))

  const refreshNumbers = async () => {
    if (refreshing || picked.length === 0) return
    setRefreshing(true)
    setProblem(null)
    // One market per lookup: the selection asks once per market it spans.
    const groups = new Map<string, { market: Market; keywords: string[] }>()
    for (const row of picked) {
      const key = `${row.location_code}:${row.language_code}`
      const g = groups.get(key) ?? { market: { location_code: row.location_code, language_code: row.language_code }, keywords: [] }
      g.keywords.push(row.keyword)
      groups.set(key, g)
    }
    let refreshed = 0
    let missing = 0
    try {
      for (const g of groups.values()) {
        const out = await fetchKeywordMetrics({ keywords: g.keywords, ...g.market, refresh: true })
        refreshed += out.rows.length
        missing += out.missing.length
      }
      toast([`Refreshed the numbers for ${count(refreshed, 'keyword')}`, missing > 0 ? `${missing.toLocaleString()} had too few searches to measure` : null].filter(Boolean).join(' · ') + '.')
    } catch (err) {
      setProblem(problemOf(err, 'Could not refresh the numbers just now.'))
    } finally {
      setRefreshing(false)
      onSpent()
      void load(0)
    }
  }

  const retag = async (body: { add_tags?: string[]; remove_tags?: string[] }) => {
    try {
      await retagSaved({ ids: picked.map((r) => r.id), ...body })
      // The rows' tags and the chips' counts come with the list: read it again, keeping the selection.
      const keep = selected
      await load(0)
      setSelected(keep)
    } catch (err) {
      toast.error('Could not change the tags', { description: errorMessage(err, 'Try again in a moment.') })
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      const out = await removeSaved(picked.map((r) => r.id))
      setConfirmRemove(false)
      toast(`Removed ${count(out.removed, 'saved keyword')}.`)
      void load(0)
    } catch (err) {
      toast.error('Could not remove those keywords', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRemoving(false)
    }
  }

  if (total === null) {
    return error && !loading ? <CenteredError text="Could not load your saved keywords." onRetry={() => void load(0)} /> : <CenteredLoader />
  }

  if (total === 0 && !filtered) {
    return (
      <div data-kw-saved-empty="" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Bookmark className="h-7 w-7 text-muted-foreground/60" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">No saved keywords yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Keywords you save from Research show here.</p>
        </div>
        <Button variant="ghost" size="sm" data-kw-go-research="" onClick={onResearch}>
          Find keywords
        </Button>
      </div>
    )
  }

  const pickedTags = Array.from(new Set(picked.flatMap((r) => r.tags))).sort()

  return (
    <div data-kw-saved="" className={cn(selected.size > 0 && 'pb-14')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterField value={typed} onChange={setTyped} placeholder="Search keywords" attr="data-kw-saved-search" />
        {tagCounts.length > 0 && (
          <div role="group" aria-label="Tags" className="flex flex-wrap items-center gap-1">
            {tagCounts.map((t) => {
              const on = tags.has(t.tag)
              return (
                <button
                  key={t.tag}
                  type="button"
                  aria-pressed={on}
                  data-kw-tag-chip={t.tag}
                  onClick={() => {
                    const nextTags = new Set(tags)
                    if (on) nextTags.delete(t.tag)
                    else nextTags.add(t.tag)
                    setTags(nextTags)
                  }}
                  className={cn('h-7 rounded-lg px-2.5 text-xs transition-colors', on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
                >
                  {t.tag}
                  <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{t.keyword_count.toLocaleString()}</span>
                </button>
              )
            })}
          </div>
        )}
        <SmallSelect label="Sort" attr="data-kw-saved-sort" className="ml-auto" value={sortKey} options={SAVED_SORT_OPTIONS} onChange={setSortKey} />
      </div>

      {problem && <ProblemBanner className="mt-3" problem={problem} />}

      {rows.length === 0 && loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 && error ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">Could not load your saved keywords.</p>
          <button type="button" onClick={() => void load(0)} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p data-kw-saved-no-match="" className="py-10 text-center text-sm text-muted-foreground">
          No saved keywords match.
        </p>
      ) : (
        <div className="mt-3">
          <KeywordGridHeader
            full
            allChecked={allChecked}
            someChecked={selected.size > 0}
            onToggleAll={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
          />
          <ul>
            {rows.map((row) => {
              const own = { location_code: row.location_code, language_code: row.language_code }
              const elsewhere = !sameMarket(own, market)
              const sub =
                row.tags.length > 0 || elsewhere ? (
                  <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
                    {elsewhere && <span className="mr-1 text-[11px] text-muted-foreground">{marketLabel(own)}</span>}
                    {row.tags.map((tag) => (
                      <span key={tag} data-kw-row-tag={tag} className="inline-flex items-center rounded-full border border-border px-2 py-px text-[10px] text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : undefined
              return (
                <KeywordGridRow
                  key={row.id}
                  rowId={row.id}
                  row={row}
                  full
                  checked={selected.has(row.id)}
                  selecting={selected.size > 0}
                  onToggle={() => toggle(row.id)}
                  sub={sub}
                  numbersTitle={row.metrics_fetched_at ? `Numbers from ${relativeWhen(row.metrics_fetched_at)}` : undefined}
                  missingTitle={row.metrics_fetched_at ? 'Too few searches to measure' : 'No numbers yet: select it and press Refresh numbers'}
                />
              )
            })}
          </ul>
          {next !== null && <ShowMore loading={loading} onClick={() => void load(next)} attr="data-kw-saved-more" />}
        </div>
      )}

      <SelectionIsland count={selected.size} total={rows.length} onClear={() => setSelected(new Set())} onSelectAll={() => setSelected(new Set(rows.map((r) => r.id)))}>
        <Button
          variant="outline"
          size="sm"
          data-kw-refresh-numbers=""
          className={ISLAND_BUTTON}
          disabled={refreshing || !!blocked}
          title={blocked ?? 'Buys fresh numbers for the selected keywords'}
          onClick={() => void refreshNumbers()}
        >
          {refreshing && <Loader2 className="h-3 w-3 animate-spin" />}
          Refresh numbers · {selected.size.toLocaleString()}
        </Button>
        <TagButton tags={pickedTags} onAdd={(tag) => void retag({ add_tags: [tag] })} onRemove={(tag) => void retag({ remove_tags: [tag] })} />
        <Button variant="outline" size="sm" data-kw-remove="" className={cn(ISLAND_BUTTON, 'text-destructive hover:text-destructive')} onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      </SelectionIsland>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!removing) setConfirmRemove(open)
        }}
        title={`Remove ${count(picked.length, 'saved keyword')}?`}
        description="This cannot be undone."
        confirmLabel="Remove"
        busy={removing}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** "Tag": add one to the selection, or take off one it carries. */
function TagButton({ tags, onAdd, onRemove }: { tags: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const tag = normalizeTag(typed)
  const add = () => {
    if (!tag) return
    onAdd(tag)
    setTyped('')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-kw-tag="" className={ISLAND_BUTTON}>
          Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 space-y-2 p-3" data-kw-tag-panel="">
        <div className="flex items-center gap-2">
          <Input
            data-kw-tag-input=""
            autoFocus
            value={typed}
            placeholder="Add a tag"
            aria-label="Add a tag"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                add()
              }
            }}
            className="h-8 text-sm"
          />
          <Button size="sm" variant="outline" data-kw-tag-add="" className="h-8 shrink-0 px-2" disabled={!tag} onClick={add} aria-label="Add the tag" title="Add the tag">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-0.5 rounded-full border border-border py-px pl-2 pr-0.5 text-[10px] text-muted-foreground">
                {t}
                <button
                  type="button"
                  data-kw-tag-remove={t}
                  aria-label={`Take the tag ${t} off`}
                  title={`Take the tag ${t} off the selected keywords`}
                  onClick={() => onRemove(t)}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-muted hover:text-foreground"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
