'use client'

/**
 * The Map rankings tab's forms, in ../start-audit.tsx's look:
 *
 *   GridForm     the searches (one per line, a live count against the cap),
 *                how many points across (3×3, 5×5, 7×7) and how far out, in
 *                km, with the route's estimate of one scan under them (POST
 *                estimate, debounced). Creating or changing a grid is free;
 *                the line says what a scan of it will cost.
 *   GridDialog   the same form in a dialog: "Edit grid" and "New grid".
 *   ScanDialog   "Scan now" always comes here first, since a grid is many
 *                searches: the estimate for the stored grid (POST estimate
 *                { grid_id }), then the start with that figure as its
 *                ceiling. A grid that changed meanwhile shows its new figure.
 *
 * Every figure shown is one the estimate route returned.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_RADIUS_KM,
  GRID_SIZES,
  MAX_KEYWORDS_PER_GRID,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  type LocalGridSize,
} from '@/lib/seo/local/limits'
import type { LocalRankGridView, LocalScanEstimate } from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import { estimateScan, type GridDraft } from './api'
import { estimateLine, parseKeywords, scanDialogSentence } from './local-helpers'

const CONTENT = 'w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4'
const ESTIMATE_DEBOUNCE_MS = 400

const SIZE_OPTIONS = GRID_SIZES.map((n) => ({ value: String(n) as `${LocalGridSize}`, label: `${n}×${n}` }))

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/** The radius as typed, or null when it is not a number in bounds. */
function parseRadius(text: string): number | null {
  const n = Number(text.replace(',', '.'))
  if (!Number.isFinite(n) || n < MIN_RADIUS_KM || n > MAX_RADIUS_KM) return null
  return Math.round(n * 10) / 10
}

/**
 * The grid's fields, the live estimate and the submit button. `onSubmit`
 * returns a sentence to say beside the form when the server refused it, or
 * null when it went through.
 */
export function GridForm({
  businessId,
  initial,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  businessId: string
  initial?: Pick<LocalRankGridView, 'keywords' | 'size' | 'radius_km'>
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (draft: GridDraft) => Promise<string | null>
  onCancel?: () => void
}) {
  const [text, setText] = React.useState(initial ? initial.keywords.join('\n') : '')
  const [size, setSize] = React.useState<LocalGridSize>(((GRID_SIZES as readonly number[]).includes(initial?.size ?? 0) ? initial?.size : DEFAULT_GRID_SIZE) as LocalGridSize)
  const [radiusText, setRadiusText] = React.useState(String(initial?.radius_km ?? DEFAULT_RADIUS_KM))
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [estimate, setEstimate] = React.useState<LocalScanEstimate | null>(null)
  const [estimating, setEstimating] = React.useState(false)
  const asked = React.useRef(0)

  const keywords = React.useMemo(() => parseKeywords(text), [text])
  const radius = parseRadius(radiusText)
  const over = keywords.length > MAX_KEYWORDS_PER_GRID
  const valid = keywords.length > 0 && !over && radius !== null
  const draft = useDebounced(JSON.stringify({ keywords, size, radius }), ESTIMATE_DEBOUNCE_MS)

  React.useEffect(() => {
    const d = JSON.parse(draft) as { keywords: string[]; size: LocalGridSize; radius: number | null }
    const ask = ++asked.current
    if (d.keywords.length === 0 || d.keywords.length > MAX_KEYWORDS_PER_GRID || d.radius === null) {
      setEstimate(null)
      setEstimating(false)
      return
    }
    setEstimating(true)
    estimateScan({ business_id: businessId, keywords: d.keywords, size: d.size, radius_km: d.radius })
      .then((e) => {
        if (ask === asked.current) setEstimate(e)
      })
      .catch(() => {
        if (ask === asked.current) setEstimate(null)
      })
      .finally(() => {
        if (ask === asked.current) setEstimating(false)
      })
  }, [draft, businessId])

  const submit = async () => {
    if (busy || !valid || radius === null) return
    setBusy(true)
    setFormError(null)
    try {
      const refusal = await onSubmit({ keywords, size, radius_km: radius })
      if (refusal) setFormError(refusal)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-seo-grid-form="" className="w-full space-y-4 text-left">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="seo-grid-keywords" className="text-xs text-muted-foreground">
            Searches, one per line
          </label>
          <span data-seo-keyword-count="" className={cn('text-[11px] tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
            {keywords.length.toLocaleString()} of {MAX_KEYWORDS_PER_GRID}
          </span>
        </div>
        <Textarea
          id="seo-grid-keywords"
          data-seo-grid-keywords=""
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (formError) setFormError(null)
          }}
          placeholder={'rug cleaning\ncarpet cleaner near me'}
          spellCheck={false}
          rows={4}
          aria-invalid={over ? true : undefined}
          className="min-h-[84px] resize-y text-sm"
        />
        {over && (
          <p data-seo-field-error="keywords" className="text-xs text-destructive">
            Up to {MAX_KEYWORDS_PER_GRID} searches a grid.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="space-y-1.5">
          <p id="seo-grid-size" className="text-xs text-muted-foreground">
            Points across
          </p>
          <FilterChips
            label="Points across"
            options={SIZE_OPTIONS}
            value={String(size) as `${LocalGridSize}`}
            onChange={(v) => setSize(Number(v) as LocalGridSize)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="seo-grid-radius" className="block text-xs text-muted-foreground" title="From the business out to the grid’s edge">
            How far out, in km
          </label>
          <Input
            id="seo-grid-radius"
            data-seo-grid-radius=""
            type="number"
            inputMode="decimal"
            min={MIN_RADIUS_KM}
            max={MAX_RADIUS_KM}
            step={0.5}
            value={radiusText}
            aria-invalid={radius === null ? true : undefined}
            onChange={(e) => setRadiusText(e.target.value)}
            className="h-8 w-24 text-sm tabular-nums"
          />
          {radius === null && (
            <p data-seo-field-error="radius" className="text-xs text-destructive">
              Between {MIN_RADIUS_KM} and {MAX_RADIUS_KM} km.
            </p>
          )}
        </div>
      </div>

      <div className="min-h-4">
        {estimate && (
          <p
            data-seo-estimate=""
            className={cn('text-[11px] tabular-nums text-muted-foreground transition-opacity', estimating && 'opacity-60')}
            title="An estimate by the price list: the most one scan of this grid can cost"
          >
            {estimateLine(estimate)}
          </p>
        )}
      </div>

      {formError && (
        <p data-seo-field-error="form" className="text-xs text-destructive">
          {formError}
        </p>
      )}

      <div className={cn('flex items-center gap-2', onCancel ? 'justify-end' : 'justify-center')}>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button size="sm" className="h-8" data-seo-grid-submit="" disabled={busy || !valid} onClick={() => void submit()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** "Edit grid" and "New grid": the form in a dialog. */
export function GridDialog({
  open,
  title,
  description,
  businessId,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  description: string
  businessId: string
  initial?: Pick<LocalRankGridView, 'keywords' | 'size' | 'radius_km'>
  submitLabel: string
  onClose: () => void
  onSubmit: (draft: GridDraft) => Promise<string | null>
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent aria-label={title} data-seo-grid-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-4">{open && <GridForm businessId={businessId} initial={initial} submitLabel={submitLabel} autoFocus onSubmit={onSubmit} onCancel={onClose} />}</div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Scan now": the stored grid's estimate first, then the start. `onStart`
 * gets the figure shown, sent as the ceiling; it returns true when the
 * server said the grid changed, so the dialog reads the estimate again.
 */
export function ScanDialog({
  open,
  gridId,
  busy,
  onClose,
  onStart,
}: {
  open: boolean
  gridId: string
  busy: boolean
  onClose: () => void
  onStart: (estimate: LocalScanEstimate) => Promise<{ changed: string } | null>
}) {
  const [estimate, setEstimate] = React.useState<LocalScanEstimate | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [changed, setChanged] = React.useState<string | null>(null)
  const asked = React.useRef(0)

  const read = React.useCallback(async () => {
    const ask = ++asked.current
    setEstimate(null)
    setError(null)
    try {
      const next = await estimateScan({ grid_id: gridId })
      if (ask === asked.current) setEstimate(next)
    } catch (err) {
      if (ask === asked.current) setError(errorMessage(err, 'Try again in a moment.'))
    }
  }, [gridId])

  React.useEffect(() => {
    if (!open) return
    setChanged(null)
    void read()
  }, [open, read])

  const go = async () => {
    if (!estimate || busy) return
    const out = await onStart(estimate)
    if (out) {
      setChanged(out.changed)
      void read()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="Scan the map now?" data-seo-scan-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Scan the map now?</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed" data-seo-scan-estimate="">
            {estimate ? scanDialogSentence(estimate) : error ? null : 'Working out what the scan costs…'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p data-seo-field-error="estimate" className="mt-3 text-xs text-destructive">
            Could not work out what the scan costs. {error}
          </p>
        )}
        {changed && (
          <p data-seo-banner="changed" className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {changed}
          </p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-seo-scan-go=""
            disabled={busy || !estimate}
            onClick={() => void go()}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Scan now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
