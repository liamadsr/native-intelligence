'use client'

/**
 * A business's Map rankings tab: where it shows on Google Maps across the
 * town, drawn as a square of points with no map (plain CSS cells).
 *
 *   No grid       a first-run block with the grid form inline (free to
 *                 create; a scan spends).
 *   A grid        its searches as a switch, the scan's numbers for the one
 *                 picked (in the top 3, average position, points checked),
 *                 then THE GRID: a square of equal cells, north row first,
 *                 each showing the business's position there, coloured by
 *                 cellBand(), the centre (the business's own spot) ringed.
 *                 Under it the businesses seen most around here.
 *   Never scanned the square's outline, every cell muted: "Not scanned yet".
 *   Scanning      the run rail with Stop; cells fill in as the 3 s poll of
 *                 GET grids/[id] returns.
 *   Failed        the amber banner with the scan's reason and Scan again.
 *
 * "Scan now" always goes through ScanDialog (the estimate first). "Edit
 * grid" waits while a scan runs; "New grid" and "Delete grid" are in the
 * grid's "…" menu.
 */
import * as React from 'react'
import { AlertTriangle, Grid3x3, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MAX_GRIDS_PER_BUSINESS } from '@/lib/seo/local/limits'
import {
  cellBand,
  isLiveScan,
  type LocalCompetitorSeen,
  type LocalGridCell,
  type LocalGridSummary,
  type LocalRankGridDetail,
  type LocalScanEstimate,
  type TrackedBusinessView,
} from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import type { SeoDataState } from '../shared/data-status'
import { RunRail } from '../shared/run-rail'
import { StatTiles, type StatTile } from '../shared/stat-tiles'
import { FilterChips } from '../shared/tab-pills'
import { count, relativeWhen } from '../ui-helpers'
import {
  DATA_OFF_CODES,
  createGrid,
  deleteGrid,
  fetchGrid,
  runningScanOf,
  startScan,
  stopScan,
  updateGrid,
  type GridDetailPayload,
  type GridDraft,
} from './api'
import { GridDialog, GridForm, ScanDialog } from './grid-form'
import { CELL_LEGEND, CELL_TONE, cellText, cellTitle, formatAverage, gridChangedSince, gridSettingsLine, ratingWords, scanRailLine } from './local-helpers'
import { MENU_ITEM, NoticeBanner } from './parts'
import { useLocalPoll } from './use-local-poll'

const stillScanning = (d: GridDetailPayload) => !!d.latest_scan && isLiveScan(d.latest_scan.status)

export function GridTab({
  business,
  grids,
  seo,
  blocked,
  onGridsChanged,
}: {
  business: TrackedBusinessView
  grids: LocalRankGridDetail[]
  seo: SeoDataState
  /** Why lookups are off, or null. */
  blocked: string | null
  /** A grid was made, changed or deleted: the business reads again. */
  onGridsChanged: () => void
}) {
  const [picked, setPicked] = React.useState<string | null>(null)
  const gridId = grids.find((g) => g.grid.id === picked)?.grid.id ?? grids[0]?.grid.id ?? null

  const created = async (draft: GridDraft): Promise<string | null> => {
    try {
      const grid = await createGrid(business.id, draft)
      setPicked(grid.id)
      onGridsChanged()
      return null
    } catch (err) {
      if (['INVALID', 'LIMIT_REACHED'].includes(errorCode(err) ?? '')) return errorMessage(err)
      toast.error('Could not create the grid', { description: errorMessage(err, 'Try again in a moment.') })
      return null
    }
  }

  if (!gridId) {
    return (
      <div data-seo-grid-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-8 text-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Grid3x3 className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Check where you rank around town</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Pick up to {MAX_GRIDS_PER_BUSINESS} searches a customer would type, like “rug cleaning”, and how wide an area to cover. A scan
            searches Google Maps from points spread across that area and shows where {business.title} comes up at each one. Making the
            grid costs nothing; each scan is paid for from this workspace’s search data.
          </p>
        </div>
        <div className="mt-2 w-full">
          <GridForm businessId={business.id} submitLabel="Create grid" onSubmit={created} />
        </div>
      </div>
    )
  }

  return (
    <GridView
      key={gridId}
      gridId={gridId}
      business={business}
      grids={grids}
      seo={seo}
      blocked={blocked}
      onPick={setPicked}
      onCreate={created}
      onGridsChanged={onGridsChanged}
    />
  )
}

function GridView({
  gridId,
  business,
  grids,
  seo,
  blocked,
  onPick,
  onCreate,
  onGridsChanged,
}: {
  gridId: string
  business: TrackedBusinessView
  grids: LocalRankGridDetail[]
  seo: SeoDataState
  blocked: string | null
  onPick: (id: string) => void
  onCreate: (draft: GridDraft) => Promise<string | null>
  onGridsChanged: () => void
}) {
  const [detail, setDetail] = React.useState<GridDetailPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [keyword, setKeyword] = React.useState(0)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [scanOpen, setScanOpen] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const [dialog, setDialog] = React.useState<'edit' | 'new' | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchGrid(gridId)
      if (ask !== asked.current) return
      setDetail(next)
    } catch {
      if (ask === asked.current) setError('Could not load the grid.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [gridId])

  React.useEffect(() => {
    void load()
  }, [load])

  const live = !!detail && stillScanning(detail)
  useLocalPoll(gridId, live, fetchGrid, stillScanning, (next) => {
    asked.current++
    setDetail(next)
    if (!stillScanning(next)) {
      seo.refresh()
      onGridsChanged()
    }
  })

  const start = async (estimate: LocalScanEstimate): Promise<{ changed: string } | null> => {
    setStarting(true)
    setNotice(null)
    try {
      const scan = await startScan(gridId, estimate.estimate_usd)
      setScanOpen(false)
      setDetail((d) => (d ? { ...d, latest_scan: scan } : d))
      seo.refresh()
      void load()
      return null
    } catch (err) {
      const code = errorCode(err)
      if (code === 'ESTIMATE_CHANGED') return { changed: errorMessage(err) }
      setScanOpen(false)
      const running = runningScanOf(err)
      if (running) {
        setDetail((d) => (d ? { ...d, latest_scan: running } : d))
        void load()
      } else if (code === 'SPEND_LIMIT_REACHED') setNotice(errorMessage(err))
      else if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
      } else toast.error('Could not start the scan', { description: errorMessage(err, 'Try again in a moment.') })
      return null
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    const scan = detail?.latest_scan
    if (!scan) return
    setStopping(true)
    try {
      const stopped = await stopScan(scan.id)
      setDetail((d) => (d ? { ...d, latest_scan: stopped } : d))
      toast('Stopped. The points already read are kept.')
      seo.refresh()
      void load()
    } catch (err) {
      toast.error('Could not stop the scan', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  const saveEdit = async (draft: GridDraft): Promise<string | null> => {
    try {
      const grid = await updateGrid(gridId, draft)
      setDialog(null)
      setDetail((d) => (d ? { ...d, grid } : d))
      toast('Saved. The next scan uses the new grid.')
      onGridsChanged()
      return null
    } catch (err) {
      if (['INVALID', 'STILL_RUNNING'].includes(errorCode(err) ?? '')) return errorMessage(err)
      toast.error('Could not save the grid', { description: errorMessage(err, 'Try again in a moment.') })
      return null
    }
  }

  const saveNew = async (draft: GridDraft): Promise<string | null> => {
    const refusal = await onCreate(draft)
    if (!refusal) setDialog(null)
    return refusal
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteGrid(gridId)
      setConfirmDelete(false)
      toast('Deleted the grid and its scans.')
      onGridsChanged()
    } catch (err) {
      setConfirmDelete(false)
      toast.error('Could not delete the grid', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setDeleting(false)
    }
  }

  if (!detail) {
    return error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />
  }

  const { grid, latest_scan: scan, result } = detail
  // The searches as the scan made them (a later edit leaves a scan as it was); the grid's own before any scan.
  const keywords = result ? result.keywords.map((k) => k.keyword) : grid.keywords
  const shown = Math.min(keyword, Math.max(0, keywords.length - 1))
  const square = result?.keywords[shown] ?? null
  const summary = square?.summary ?? null
  const scanned = !!summary && summary.points_collected > 0
  const atCap = grids.length >= MAX_GRIDS_PER_BUSINESS
  const scanTitle = blocked ?? (live ? 'A scan is running' : 'Search Google Maps from every point of the grid now')
  const rail = scan && live ? scanRailLine(scan) : null
  const changed = !live && gridChangedSince(grid, scan)

  return (
    <div data-seo-grid={grid.id} data-seo-scan-status={scan?.status ?? 'none'}>
      {grids.length > 1 && (
        <FilterChips
          className="mb-2"
          label="Grid"
          options={grids.map((g) => ({
            value: g.grid.id,
            label: g.grid.keywords.length > 1 ? `${g.grid.keywords[0]} +${g.grid.keywords.length - 1}` : (g.grid.keywords[0] ?? 'Grid'),
          }))}
          value={grid.id}
          onChange={onPick}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          className="min-w-0 flex-1"
          label="Search"
          options={keywords.map((k, i) => ({ value: String(i), label: k }))}
          value={String(shown)}
          onChange={(v) => setKeyword(Number(v))}
        />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            data-seo-edit-grid=""
            className="h-8 text-xs"
            disabled={live}
            title={live ? 'A scan is running. Change the grid once it ends.' : 'Change the searches, the points or how far out'}
            onClick={() => setDialog('edit')}
          >
            Edit grid
          </Button>
          <Button size="sm" className="h-8" data-seo-scan-now="" disabled={!!blocked || live || starting} title={scanTitle} onClick={() => setScanOpen(true)}>
            Scan now
          </Button>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" data-seo-grid-menu="" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="More" aria-label="Grid options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1.5">
              <button
                type="button"
                data-seo-new-grid=""
                className={MENU_ITEM}
                disabled={atCap}
                title={atCap ? `A business can have ${MAX_GRIDS_PER_BUSINESS} grids. Delete one to add another.` : 'Another set of searches or another area'}
                onClick={() => {
                  setMenuOpen(false)
                  setDialog('new')
                }}
              >
                <Plus className="h-3 w-3 shrink-0" />
                New grid
              </button>
              <button
                type="button"
                data-seo-delete-grid=""
                className={cn(MENU_ITEM, 'text-destructive')}
                disabled={live}
                title={live ? 'Stop the scan before deleting the grid' : undefined}
                onClick={() => {
                  setMenuOpen(false)
                  setConfirmDelete(true)
                }}
              >
                <Trash2 className="h-3 w-3 shrink-0" />
                Delete grid
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="mt-3 space-y-2 empty:hidden">
        {rail && <RunRail className="mx-0 mb-0" verb={rail.verb} clauses={rail.clauses} stopping={stopping} onStop={() => void stop()} />}
        {scan?.status === 'failed' && (
          <div data-seo-failed="" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
            <p className="min-w-0 flex-1">{scan.error ?? 'The scan could not finish.'}</p>
            <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" disabled={!!blocked || starting} title={blocked ?? undefined} onClick={() => setScanOpen(true)}>
              Scan again
            </Button>
          </div>
        )}
        {scan?.status === 'canceled' && <NoticeBanner text="This scan was stopped. The points it read are below." />}
        {changed && <NoticeBanner text="The grid changed since this scan. Scan again to see the new searches and points." />}
        {notice && <NoticeBanner text={notice} />}
      </div>

      {scanned && summary && <StatTiles className="mt-4" tiles={summaryTiles(summary)} />}

      <GridSquare
        size={square ? square.rows.length : grid.size}
        rows={square?.rows ?? null}
        keyword={keywords[shown] ?? ''}
        summary={summary}
      />
      <p data-seo-grid-caption="" className="mt-2 text-center text-[11px] tabular-nums text-muted-foreground">
        {scan
          ? [gridSettingsLine(scan), scan.completed_at ? `scanned ${relativeWhen(scan.completed_at)}` : null].filter(Boolean).join(' · ')
          : `Not scanned yet · ${gridSettingsLine(grid)}`}
      </p>

      {result && result.competitors.length > 0 && <Competitors rows={result.competitors} across={result.keywords.length > 1} />}

      <ScanDialog open={scanOpen} gridId={grid.id} busy={starting} onClose={() => setScanOpen(false)} onStart={start} />
      <GridDialog
        open={dialog !== null}
        title={dialog === 'new' ? 'New grid' : 'Edit grid'}
        description={
          dialog === 'new'
            ? 'Another set of searches, or another area around the business. Making it costs nothing; each scan is paid for.'
            : 'The next scan uses the changed grid. Earlier scans keep the grid they searched.'
        }
        businessId={business.id}
        initial={dialog === 'edit' ? grid : undefined}
        submitLabel={dialog === 'new' ? 'Create grid' : 'Save grid'}
        onClose={() => setDialog(null)}
        onSubmit={dialog === 'new' ? saveNew : saveEdit}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next)
        }}
        title="Delete this grid?"
        description="Its scans are removed. This cannot be undone."
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** The scan's numbers for one search, as tiles. */
function summaryTiles(summary: LocalGridSummary): StatTile[] {
  return [
    {
      key: 'top3',
      label: 'In the top 3',
      value: summary.top3_percent === null ? null : `${summary.top3_percent}%`,
      title: `Of the points checked, where the business was among the first three on the map: ${summary.top3.toLocaleString()} of ${summary.points_collected.toLocaleString()}`,
    },
    {
      key: 'average',
      label: 'Average position',
      value: summary.average_position === null ? null : formatAverage(summary.average_position),
      title: summary.average_position === null ? 'Not found at any point' : 'Its average place on the map where it was found: lower is better',
    },
    {
      key: 'points',
      label: 'Points checked',
      value: summary.points_collected < summary.points_total ? `${summary.points_collected.toLocaleString()} of ${summary.points_total.toLocaleString()}` : summary.points_collected,
      title: 'Points whose search came back',
    },
  ]
}

/** The square: equal cells, north row first, the centre ringed; drawn with no map. */
function GridSquare({ size, rows, keyword, summary }: { size: number; rows: LocalGridCell[][] | null; keyword: string; summary: LocalGridSummary | null }) {
  const centre = Math.floor(size / 2)
  const label = rows
    ? summary && summary.points_collected > 0
      ? `${keyword}: in the top 3 at ${count(summary.top3, 'point')} of ${summary.points_collected.toLocaleString()} checked${summary.average_position !== null ? `, average position ${formatAverage(summary.average_position)}` : ''}`
      : `${keyword}: no points read yet`
    : `${keyword}: not scanned yet`
  const cells: Array<{ key: string; cell: LocalGridCell | null; isCentre: boolean }> = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      cells.push({ key: `${r}:${c}`, cell: rows?.[r]?.[c] ?? null, isCentre: r === centre && c === centre })
    }
  }
  return (
    <div className="mt-5 flex flex-col items-center">
      <span aria-hidden className="mb-1 text-[10px] font-medium text-muted-foreground">
        N
      </span>
      <div
        role="img"
        aria-label={label}
        data-seo-square={size}
        className="grid w-full max-w-[22rem] gap-1"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      >
        {cells.map(({ key, cell, isCentre }) => {
          const band = cell ? cellBand(cell) : null
          return (
            <div
              key={key}
              data-seo-cell={key}
              data-seo-band={band ?? 'unscanned'}
              title={cell ? cellTitle(cell) : 'Not scanned yet'}
              className={cn(
                'flex aspect-square items-center justify-center rounded-md border text-xs font-medium tabular-nums',
                band ? CELL_TONE[band] : 'border-border bg-muted/30 text-muted-foreground',
                isCentre && 'ring-2 ring-foreground/50 ring-offset-1 ring-offset-background',
              )}
            >
              {cell && band === 'not_collected' ? <span aria-hidden className="h-1 w-1 rounded-full bg-muted-foreground/50" /> : cell ? cellText(cell) : null}
            </div>
          )
        })}
      </div>
      {rows && (
        <ul data-seo-legend="" className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {CELL_LEGEND.filter((entry) => entry.band !== 'not_collected' || rows.some((row) => row.some((cell) => cell.status === 'not_collected'))).map((entry) => (
            <li key={entry.band} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('h-2.5 w-2.5 rounded-sm border', CELL_TONE[entry.band])} />
              {entry.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm ring-2 ring-foreground/50 ring-offset-1 ring-offset-background" />
            The business
          </li>
        </ul>
      )}
    </div>
  )
}

/** "Seen most around here": the businesses that beat it most, across the scan. */
function Competitors({ rows, across }: { rows: LocalCompetitorSeen[]; across: boolean }) {
  const grid = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-start gap-2 @md:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem]'
  return (
    <section data-seo-competitors="" className="@container mt-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-foreground">Seen most around here</h2>
        {across && <span className="text-[11px] text-muted-foreground">Across every search in this scan</span>}
      </div>
      <div className={cn(grid, 'mt-2 px-1 text-[11px] text-muted-foreground')}>
        <span>Business</span>
        <span className="hidden text-right @md:block" title="Points where it was first on the map">
          First at
        </span>
        <span className="text-right" title="Points where it was among the first three on the map">
          Top 3 at
        </span>
        <span className="text-right" title="Its average place on the map where it showed: lower is better">
          Average
        </span>
      </div>
      <ul className="mt-1">
        {rows.map((row, index) => {
          const meta = [ratingWords(row.rating), row.review_count ? count(row.review_count, 'review') : null].filter(Boolean).join(' · ')
          return (
            <li key={`${row.cid ?? row.place_id ?? row.title}-${index}`} data-seo-competitor="" className={cn(grid, 'rounded-md px-1 py-1 hover:bg-muted/40')}>
              <span className="min-w-0">
                <span className="block truncate text-sm text-foreground" title={row.title}>
                  {row.title}
                </span>
                {meta && <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{meta}</span>}
              </span>
              <span className="hidden text-right text-sm tabular-nums @md:block">{row.points_first.toLocaleString()}</span>
              <span className="text-right text-sm tabular-nums">{row.points_top3.toLocaleString()}</span>
              <span className="text-right text-sm tabular-nums">{formatAverage(row.average_position)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
