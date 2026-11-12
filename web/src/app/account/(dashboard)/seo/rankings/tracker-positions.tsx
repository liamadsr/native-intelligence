'use client'

/**
 * A tracker's Positions tab: every keyword, pinned first, a page at a time
 * from GET …/trackers/[id]/keywords, on the device chosen above.
 *
 * A row: a box to select it, the keyword with a pin (shown on hover, and
 * always when pinned), where the site ranks (the number, "Not in top 20"
 * when checked and not found, a dash before any check), the move since the
 * last check (↑ in emerald is up the page, a LOWER number; ↓ in red is
 * down), and the page that ranks, as a link out (dropped on a narrow card,
 * a container query as ../audit-pages.tsx does). A press on the row opens
 * the keyword's history. Selected rows get the selection island: Remove,
 * through ConfirmDialog (their history stays).
 */
import * as React from 'react'
import { Loader2, Pin, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { RankDevice, RankKeywordRow, RankTrackerView } from '@/lib/seo/rank/view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { count, pathOf } from '../ui-helpers'
import { fetchKeywords, pinKeywords, removeKeywords } from './api'
import { changeNote, positionCell } from './rank-helpers'

const GRID = 'grid grid-cols-[1rem_minmax(0,1fr)_6rem_3.5rem] items-center gap-2 @2xl:grid-cols-[1rem_minmax(0,1fr)_6rem_3.5rem_minmax(0,14rem)]'
/** The selection island's slab (views/bulk-actions/bulk-action-bar.tsx's SELECTION_ISLAND_CLASS). */
const ISLAND =
  'flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-border bg-background/95 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl dark:shadow-black/50'

export function TrackerPositions({
  tracker,
  device,
  version,
  onOpenHistory,
  onAdd,
  onChanged,
}: {
  tracker: RankTrackerView
  device: RankDevice
  version: number
  onOpenHistory: (row: RankKeywordRow) => void
  onAdd: () => void
  /** Keywords were removed: the tracker's counts read again. */
  onChanged: () => void
}) {
  const [rows, setRows] = React.useState<RankKeywordRow[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [pinning, setPinning] = React.useState<string | null>(null)
  const asked = React.useRef(0)

  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setError(false)
      try {
        const page = await fetchKeywords(tracker.id, offset)
        if (ask !== asked.current) return
        setRows((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
      } catch {
        if (ask === asked.current) setError(true)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [tracker.id],
  )

  React.useEffect(() => {
    void load(0)
  }, [load, version])

  // A selection only holds rows still listed.
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((r) => r.id))
      const kept = [...prev].filter((id) => ids.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [rows])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const nextSet = new Set(prev)
      if (nextSet.has(id)) nextSet.delete(id)
      else nextSet.add(id)
      return nextSet
    })

  const pin = async (row: RankKeywordRow) => {
    setPinning(row.id)
    try {
      await pinKeywords(tracker.id, [row.id], !row.pinned)
      await load(0)
    } catch (err) {
      toast.error(row.pinned ? 'Could not unpin it' : 'Could not pin it', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setPinning(null)
    }
  }

  const remove = async () => {
    const ids = [...selected]
    setRemoving(true)
    try {
      const out = await removeKeywords(tracker.id, ids)
      setConfirmRemove(false)
      setSelected(new Set())
      toast(`Stopped tracking ${count(out.removed, 'keyword')}. Their history is kept.`)
      onChanged()
    } catch (err) {
      toast.error('Could not remove the keywords', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRemoving(false)
    }
  }

  if (rows.length === 0 && loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (rows.length === 0 && error) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">Could not load the keywords.</p>
        <button type="button" onClick={() => void load(0)} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          Try again
        </button>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div data-seo-positions-empty="" className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">No keywords yet</p>
          <p className="text-xs leading-relaxed text-muted-foreground">Add the searches you want to see {tracker.domain} rank for.</p>
        </div>
        <Button size="sm" className="h-8" data-seo-positions-add="" onClick={onAdd}>
          Add keywords
        </Button>
      </div>
    )
  }

  const selecting = selected.size > 0
  return (
    <div data-seo-positions="" className="@container">
      <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
        <span />
        <span>Keyword</span>
        <span className="text-right" title="Where the site shows up on Google: 1 is the top">
          Position
        </span>
        <span className="text-right" title="Places moved since the last check">
          Change
        </span>
        <span className="hidden @2xl:block">Page</span>
      </div>
      <ul>
        {rows.map((row) => (
          <PositionRow
            key={row.id}
            row={row}
            device={device}
            depth={tracker.serp_depth}
            selected={selected.has(row.id)}
            selecting={selecting}
            pinning={pinning === row.id}
            onSelect={() => toggle(row.id)}
            onPin={() => void pin(row)}
            onOpen={() => onOpenHistory(row)}
          />
        ))}
      </ul>
      {next !== null && (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            data-seo-positions-more=""
            disabled={loading}
            onClick={() => void load(next)}
            className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
      {selecting && (
        <div className="pointer-events-none sticky bottom-3 z-10 mt-3 flex justify-center">
          <div data-seo-selection="" className={cn(ISLAND, 'pointer-events-auto')}>
            <button
              type="button"
              data-seo-remove-selected=""
              onClick={() => setConfirmRemove(true)}
              className="inline-flex h-7 items-center rounded-full bg-foreground px-3 text-xs font-medium tabular-nums text-background"
            >
              Remove · {selected.size.toLocaleString()}
            </button>
            <button
              type="button"
              data-seo-clear-selection=""
              aria-label="Clear the selection"
              title="Clear the selection"
              onClick={() => setSelected(new Set())}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!removing) setConfirmRemove(open)
        }}
        title={`Stop tracking ${count(selected.size, 'keyword')}?`}
        description="They leave the list and are no longer checked. The history of their past checks is kept."
        confirmLabel="Remove"
        busy={removing}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function PositionRow({
  row,
  device,
  depth,
  selected,
  selecting,
  pinning,
  onSelect,
  onPin,
  onOpen,
}: {
  row: RankKeywordRow
  device: RankDevice
  depth: number
  selected: boolean
  selecting: boolean
  pinning: boolean
  onSelect: () => void
  onPin: () => void
  onOpen: () => void
}) {
  const view = row[device]
  const position = positionCell(view, depth)
  const change = changeNote(view)
  const url = view?.ranking_url ?? null
  return (
    <li
      data-seo-keyword-row={row.id}
      data-seo-pinned={row.pinned ? '' : undefined}
      onClick={onOpen}
      className={cn(GRID, 'group cursor-pointer rounded-md px-1 py-1 transition-colors hover:bg-muted/40', selected && 'bg-muted/40')}
    >
      <span onClick={(e) => e.stopPropagation()} className="flex items-center">
        <Checkbox
          data-seo-select-keyword={row.id}
          checked={selected}
          onCheckedChange={onSelect}
          aria-label={`Select ${row.keyword}`}
          className={cn('h-3.5 w-3.5 transition-opacity', selecting || selected ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
        />
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          title={`Show how “${row.keyword}” moved`}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className="min-w-0 truncate text-left text-xs text-foreground underline-offset-2 hover:underline"
        >
          {row.keyword}
        </button>
        <button
          type="button"
          data-seo-pin={row.id}
          aria-pressed={row.pinned}
          aria-label={row.pinned ? `Unpin ${row.keyword}` : `Pin ${row.keyword} to the top`}
          title={row.pinned ? 'Unpin' : 'Pin to the top'}
          disabled={pinning}
          onClick={(e) => {
            e.stopPropagation()
            onPin()
          }}
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground',
            row.pinned ? 'opacity-100 text-foreground' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          <Pin className={cn('h-3 w-3', row.pinned && 'fill-current')} />
        </button>
      </span>
      <span data-seo-position="" title={position.title} className={cn('text-right text-xs tabular-nums', position.muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>
        {position.text}
      </span>
      <span data-seo-change="" className="text-right text-[11px] tabular-nums">
        {change && (
          <span title={change.title} className={change.tone === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
            {change.text}
          </span>
        )}
      </span>
      <span className="hidden min-w-0 @2xl:block">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title={url}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {pathOf(url)}
          </a>
        ) : null}
      </span>
    </li>
  )
}
