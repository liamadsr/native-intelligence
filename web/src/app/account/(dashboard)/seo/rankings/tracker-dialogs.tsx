'use client'

/**
 * The Rankings page's dialogs, in ../start-audit.tsx's look (a small
 * rounded-lg dialog, xs labels, Cancel and one primary):
 *
 *   NewTrackerDialog     the site, the market, the device, how often, and the
 *                        keywords one per line, with a live count against the
 *                        cap and the estimate under the fields (POST
 *                        estimate, draft form, debounced). A schedule spends
 *                        on its own, so the cost is shown before saving.
 *   ScheduleDialog       devices and how often for a saved tracker, the
 *                        estimate before → after; a change that raises the
 *                        monthly cost says the new figure on its primary.
 *   AddKeywordsDialog    more keywords, the same count and estimate.
 *   SpendConfirmDialog   "this costs about $X" before a press that spends
 *                        (a check above about $0.25, a schedule resumed).
 *
 * Every figure shown is one the estimate route returned. A correctable
 * refusal is said in the dialog, beside the field where there is one.
 *
 * The server asks for the person's yes itself (409 NEEDS_GO_AHEAD): a
 * request carries `confirmed: true` only from a press of a primary that names
 * the cost on screen. When the server's figure differs from the one shown
 * (the keywords changed meanwhile), its figure replaces it on the primary and
 * nothing is saved until that is pressed.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { RankEstimateView, RankTrackerView, RankTrackingDevices, RankTrackingScheduleInterval } from '@/lib/seo/rank/view'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import {
  DATA_OFF_CODES,
  addKeywords,
  createTracker,
  duplicateTrackerOf,
  estimateChange,
  estimateDraft,
  goAheadOf,
  updateTracker,
  type RankLimits,
  type TrackerChangeEstimate,
} from './api'
import { DEVICE_OPTIONS, INTERVAL_OPTIONS, estimateSentence, keywordsOutcomeWords, monthlyWords, parseKeywordLines } from './rank-helpers'
import { useMarkets } from './use-rank-poll'

const CONTENT = 'w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4'
const TRIGGER = 'h-8 w-auto min-w-0 gap-1.5 rounded-md px-2.5 text-xs shadow-none'
const ESTIMATE_DEBOUNCE_MS = 400

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

function Field({ label, htmlFor, children, error, hint }: { label: string; htmlFor?: string; children: React.ReactNode; error?: string | null; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-xs text-muted-foreground">
          {label}
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">{label}</p>
      )}
      {children}
      {error ? (
        <p data-seo-field-error="" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  )
}

/** The quiet estimate line under a form's fields. */
function EstimateLine({ text, loading, className }: { text: string | null; loading?: boolean; className?: string }) {
  if (!text) return null
  return (
    <p data-seo-estimate="" className={cn('text-[11px] tabular-nums text-muted-foreground transition-opacity', loading && 'opacity-60', className)} title="The most it can cost: every search is priced at its maximum">
      {text}
    </p>
  )
}

/** The keywords box: one per line, a live count against the room left. */
function KeywordsField({ id, value, onChange, room, autoFocus }: { id: string; value: string; onChange: (next: string) => void; room: number; autoFocus?: boolean }) {
  const n = parseKeywordLines(value).length
  const over = n > room
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          Keywords, one per line
        </label>
        <span data-seo-keyword-count="" className={cn('text-[11px] tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
          {n.toLocaleString()} of {room.toLocaleString()}
        </span>
      </div>
      <Textarea
        id={id}
        data-seo-keywords=""
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'handmade oak table\nlinen throw blanket'}
        spellCheck={false}
        rows={5}
        aria-invalid={over ? true : undefined}
        className="min-h-[96px] resize-y text-sm"
      />
      {over && (
        <p data-seo-field-error="" className="text-xs text-destructive">
          {room > 0 ? `Up to ${room.toLocaleString()} at a time here.` : 'This tracker is full.'}
        </p>
      )}
    </div>
  )
}

// ── New tracker ──────────────────────────────────────────────────────────

export function NewTrackerDialog({
  open,
  defaultDomain,
  limits,
  onClose,
  onCreated,
  onOpenExisting,
  onDataOff,
}: {
  open: boolean
  defaultDomain: string | null
  limits: RankLimits
  onClose: () => void
  onCreated: (tracker: RankTrackerView) => void
  /** A tracker of this site in this market exists: open it instead. */
  onOpenExisting: (trackerId: string, domain: string) => void
  /** Lookups turned out to be off (the spend read is refreshed). */
  onDataOff?: () => void
}) {
  const markets = useMarkets()
  const [domain, setDomain] = React.useState(defaultDomain ?? '')
  const [locationCode, setLocationCode] = React.useState<number | null>(null)
  const [languageCode, setLanguageCode] = React.useState<string | null>(null)
  const [devices, setDevices] = React.useState<RankTrackingDevices>(limits.default_devices)
  const [howOften, setHowOften] = React.useState<RankTrackingScheduleInterval>(limits.default_schedule)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [siteError, setSiteError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [estimate, setEstimate] = React.useState<RankEstimateView | null>(null)
  const [estimating, setEstimating] = React.useState(false)
  const asked = React.useRef(0)

  React.useEffect(() => {
    if (!open) return
    setDomain(defaultDomain ?? '')
    setDevices(limits.default_devices)
    setHowOften(limits.default_schedule)
    setText('')
    setSiteError(null)
    setFormError(null)
    setEstimate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open])

  // The market starts on the server's default country in its own language.
  const location = markets ? (markets.locations.find((l) => l.code === (locationCode ?? markets.default_location_code)) ?? null) : null
  const language = languageCode ?? location?.default_language ?? null

  const keywords = React.useMemo(() => parseKeywordLines(text), [text])
  const room = limits.max_keywords_per_add
  const draftKey = JSON.stringify({ keywords, language, devices, howOften })
  const draft = useDebounced(draftKey, ESTIMATE_DEBOUNCE_MS)

  React.useEffect(() => {
    if (!open) return
    const d = JSON.parse(draft) as { keywords: string[]; language: string | null; devices: RankTrackingDevices; howOften: RankTrackingScheduleInterval }
    const ask = ++asked.current
    if (d.keywords.length === 0 || d.keywords.length > room) {
      setEstimate(null)
      setEstimating(false)
      return
    }
    setEstimating(true)
    estimateDraft({ keywords: d.keywords, language_code: d.language ?? undefined, devices: d.devices, schedule_interval: d.howOften })
      .then((e) => {
        if (ask === asked.current) setEstimate(e)
      })
      .catch(() => {
        if (ask === asked.current) setEstimate(null)
      })
      .finally(() => {
        if (ask === asked.current) setEstimating(false)
      })
  }, [draft, open, room])

  const over = keywords.length > room
  const scheduled = howOften !== 'manual'
  // A schedule spends on its own: its figure, for the form as it is now, must
  // be on screen (and on the primary) before saving.
  const waitingForCost = scheduled && keywords.length > 0 && (!estimate || estimating || draft !== draftKey)
  const canSubmit = !busy && !over && !waitingForCost
  /** The monthly cost the primary names, or null when it names none. */
  const costShown = scheduled && keywords.length > 0 && !waitingForCost && estimate && estimate.monthly_usd > 0 ? estimate : null

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setSiteError(null)
    setFormError(null)
    try {
      const out = await createTracker({
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        ...(location ? { location_code: location.code } : {}),
        ...(language ? { language_code: language } : {}),
        devices,
        schedule_interval: howOften,
        ...(keywords.length ? { keywords } : {}),
        // The primary names this monthly cost: the press is the yes.
        ...(costShown ? { confirmed: true } : {}),
      })
      onClose()
      toast(
        keywords.length > 0
          ? `Tracking ${out.tracker.domain}. ${keywordsOutcomeWords(out.keywords, limits.max_keywords_per_tracker)}.`
          : `Tracking ${out.tracker.domain}. Add the searches you care about next.`,
      )
      onCreated(out.tracker)
    } catch (err) {
      const code = errorCode(err)
      const existing = duplicateTrackerOf(err)
      const goAhead = goAheadOf(err)
      if (goAhead) {
        // The server's figure goes on the primary; the next press is the yes.
        setEstimate(goAhead.estimate)
        setFormError(errorMessage(err))
      } else if (existing) {
        onClose()
        toast(errorMessage(err))
        onOpenExisting(existing, domain.trim() || defaultDomain || '')
      } else if (code === 'NO_SITE') setSiteError(errorMessage(err))
      else if (code === 'INVALID_INPUT' && /domain/i.test(errorMessage(err))) setSiteError(errorMessage(err))
      else if (code === 'INVALID_INPUT' || code === 'TOO_MANY_TRACKERS' || code === 'CHECK_FAILED') setFormError(errorMessage(err))
      else if (code && DATA_OFF_CODES.has(code)) {
        setFormError(errorMessage(err))
        onDataOff?.()
      } else toast.error('Could not set up the tracker', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  const languages = location?.languages ?? []
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="New tracker" data-seo-new-tracker-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">New tracker</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            Checks where your site shows up on Google for each search, reading the first {limits.default_depth} results, and keeps the history.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <Field label="Website" htmlFor="seo-rank-domain" error={siteError}>
            <Input
              id="seo-rank-domain"
              data-seo-rank-domain=""
              value={domain}
              placeholder="example.com"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={siteError ? true : undefined}
              onChange={(e) => {
                setDomain(e.target.value)
                if (siteError) setSiteError(null)
              }}
              className="h-8 text-sm"
            />
          </Field>

          {markets && location && (
            <Field label="Where people search">
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={String(location.code)}
                  onValueChange={(v) => {
                    setLocationCode(Number(v))
                    setLanguageCode(null)
                  }}
                >
                  <SelectTrigger data-seo-country="" aria-label="Country" title="The country whose Google results to read" className={TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {markets.locations.map((l) => (
                      <SelectItem key={l.code} value={String(l.code)} className="text-xs">
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {languages.length > 1 && language && (
                  <Select value={language} onValueChange={setLanguageCode}>
                    <SelectTrigger data-seo-language="" aria-label="Language" className={TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {languages.map((l) => (
                        <SelectItem key={l.code} value={l.code} className="text-xs">
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </Field>
          )}

          <Field label="Device">
            <FilterChips label="Device" options={DEVICE_OPTIONS} value={devices} onChange={setDevices} />
          </Field>

          <Field label="How often" hint={howOften === 'manual' ? 'Checked only when you press Check now.' : 'Checks run on their own and are paid for from this workspace’s search data.'}>
            <FilterChips label="How often" options={INTERVAL_OPTIONS} value={howOften} onChange={setHowOften} />
          </Field>

          <KeywordsField id="seo-rank-keywords" value={text} onChange={setText} room={room} />

          <EstimateLine text={estimate ? estimateSentence(estimate) : null} loading={estimating} />
          {formError && (
            <p data-seo-form-error="" className="text-xs text-destructive">
              {formError}
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-create-tracker="" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {costShown ? `Create, ${monthlyWords(costShown)}` : 'Create tracker'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── A saved tracker's change, with its estimate ─────────────────────────

/** before → after for a saved tracker, debounced; null until the first answer. */
function useChangeEstimate(open: boolean, trackerId: string, change: Record<string, unknown> | null) {
  const [answer, setAnswer] = React.useState<TrackerChangeEstimate | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const key = useDebounced(change ? JSON.stringify(change) : '', ESTIMATE_DEBOUNCE_MS)
  const asked = React.useRef(0)
  const [retry, setRetry] = React.useState(0)

  React.useEffect(() => {
    const ask = ++asked.current
    if (!open || !key) {
      setAnswer(null)
      setLoading(false)
      setFailed(false)
      return
    }
    setLoading(true)
    setFailed(false)
    estimateChange(trackerId, JSON.parse(key) as Record<string, never>)
      .then((a) => {
        if (ask === asked.current) setAnswer(a)
      })
      .catch(() => {
        if (ask === asked.current) {
          setAnswer(null)
          setFailed(true)
        }
      })
      .finally(() => {
        if (ask === asked.current) setLoading(false)
      })
  }, [open, trackerId, key, retry])

  // Stale while the debounce hasn't caught up with the latest change.
  const settled = key === (change ? JSON.stringify(change) : '')
  return { answer: settled ? answer : null, loading: loading || !settled, failed, retry: () => setRetry((r) => r + 1) }
}

/**
 * The server's own figure, from a 409 NEEDS_GO_AHEAD, for the change on
 * screen: it replaces the estimate until the change is edited or the dialog
 * closes.
 */
function useServerFigure(open: boolean, change: Record<string, unknown> | null) {
  const key = change ? JSON.stringify(change) : ''
  const [held, setHeld] = React.useState<{ key: string; answer: TrackerChangeEstimate } | null>(null)
  React.useEffect(() => {
    if (!open) setHeld(null)
  }, [open])
  return {
    answer: held && held.key === key ? held.answer : null,
    set: (answer: TrackerChangeEstimate) => setHeld({ key, answer }),
  }
}

function BeforeAfter({ answer }: { answer: TrackerChangeEstimate }) {
  const rows = [
    { key: 'before', label: 'Now', text: estimateSentence(answer.before) ?? 'No keywords yet, so nothing to check.' },
    { key: 'after', label: 'After', text: estimateSentence(answer.after) ?? 'No keywords yet, so nothing to check.' },
  ]
  return (
    <div data-seo-before-after="" className="space-y-1 rounded-md border border-border bg-muted/20 px-3 py-2">
      {rows.map((r) => (
        <p key={r.key} data-seo-estimate={r.key} className="flex gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="w-9 shrink-0 text-foreground">{r.label}</span>
          <span className="min-w-0">{r.text}</span>
        </p>
      ))}
      {answer.raises_cost && (
        <p data-seo-raises-cost="" className="pt-0.5 text-[11px] text-foreground">
          This raises what the tracker spends on its own to {monthlyWords(answer.after)}.
        </p>
      )}
    </div>
  )
}

function EstimateFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
      Could not work out the cost.
      <button type="button" onClick={onRetry} className="rounded px-1 text-foreground underline-offset-2 hover:underline">
        Try again
      </button>
    </p>
  )
}

export function ScheduleDialog({
  open,
  tracker,
  onClose,
  onSaved,
  onDataOff,
}: {
  open: boolean
  tracker: RankTrackerView
  onClose: () => void
  onSaved: (tracker: RankTrackerView) => void
  onDataOff?: () => void
}) {
  const [devices, setDevices] = React.useState<RankTrackingDevices>(tracker.devices)
  const [howOften, setHowOften] = React.useState<RankTrackingScheduleInterval>(tracker.schedule.interval)
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setDevices(tracker.devices)
    setHowOften(tracker.schedule.interval)
    setFormError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open])

  const change: Record<string, unknown> = {}
  if (devices !== tracker.devices) change.devices = devices
  if (howOften !== tracker.schedule.interval) change.schedule_interval = howOften
  const changed = Object.keys(change).length > 0
  const estimate = useChangeEstimate(open, tracker.id, changed ? change : null)
  const server = useServerFigure(open, changed ? change : null)
  const shown = server.answer ?? estimate.answer
  const raises = !!shown?.raises_cost
  const canSave = changed && !busy && !!shown

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setFormError(null)
    try {
      // A rise is named on the primary: the press is the yes.
      const next = await updateTracker(tracker.id, raises ? { ...change, confirmed: true } : change)
      onClose()
      toast('Saved. The next checks use the new settings.')
      onSaved(next)
    } catch (err) {
      const code = errorCode(err)
      const goAhead = goAheadOf(err)
      if (goAhead) {
        server.set({ before: goAhead.previous ?? goAhead.estimate, after: goAhead.estimate, raises_cost: true })
        return
      }
      if (code && DATA_OFF_CODES.has(code)) onDataOff?.()
      if (code === 'INVALID_INPUT' || code === 'CHECK_FAILED' || (code && DATA_OFF_CODES.has(code))) setFormError(errorMessage(err))
      else toast.error('Could not change the tracker', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="Schedule and devices" data-seo-schedule-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Schedule and devices</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            How often {tracker.domain} is checked, and on which devices. Its keywords and history stay as they are.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <Field label="Device">
            <FilterChips label="Device" options={DEVICE_OPTIONS} value={devices} onChange={setDevices} />
          </Field>
          <Field label="How often" hint={tracker.paused && howOften !== 'manual' ? 'Paused: no scheduled checks until you resume it.' : howOften === 'manual' ? 'Checked only when you press Check now.' : undefined}>
            <FilterChips label="How often" options={INTERVAL_OPTIONS} value={howOften} onChange={setHowOften} />
          </Field>
          {changed && shown && <BeforeAfter answer={shown} />}
          {changed && !shown && estimate.failed && <EstimateFailed onRetry={estimate.retry} />}
          {formError && (
            <p data-seo-form-error="" className="text-xs text-destructive">
              {formError}
            </p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-save-schedule="" disabled={!canSave} onClick={() => void save()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {raises && shown ? `Save, ${monthlyWords(shown.after)}` : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AddKeywordsDialog({
  open,
  tracker,
  limits,
  onClose,
  onAdded,
}: {
  open: boolean
  tracker: RankTrackerView
  limits: Pick<RankLimits, 'max_keywords_per_add' | 'max_keywords_per_tracker'>
  onClose: () => void
  onAdded: () => void
}) {
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setText('')
    setFormError(null)
  }, [open])

  const keywords = React.useMemo(() => parseKeywordLines(text), [text])
  const room = Math.max(0, Math.min(limits.max_keywords_per_add, limits.max_keywords_per_tracker - tracker.keyword_count))
  const over = keywords.length > room
  const addChange = keywords.length > 0 && !over ? { add_keywords: keywords } : null
  const estimate = useChangeEstimate(open, tracker.id, addChange)
  const server = useServerFigure(open, addChange)
  const shown = server.answer ?? estimate.answer
  const raises = !!shown?.raises_cost
  const canAdd = keywords.length > 0 && !over && !busy && !!shown

  const add = async () => {
    if (!canAdd) return
    setBusy(true)
    setFormError(null)
    try {
      // A rise is named on the primary: the press is the yes.
      const out = await addKeywords(tracker.id, keywords, { confirmed: raises })
      onClose()
      toast(keywordsOutcomeWords(out, limits.max_keywords_per_tracker))
      onAdded()
    } catch (err) {
      const code = errorCode(err)
      const goAhead = goAheadOf(err)
      if (goAhead) server.set({ before: goAhead.previous ?? goAhead.estimate, after: goAhead.estimate, raises_cost: true })
      else if (code === 'INVALID_INPUT' || code === 'CHECK_FAILED' || (code && DATA_OFF_CODES.has(code))) setFormError(errorMessage(err))
      else toast.error('Could not add the keywords', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  const after = shown?.after ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="Add keywords" data-seo-add-keywords-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Add keywords</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            The searches to follow for {tracker.domain}. Nothing is checked until the next check{tracker.schedule.interval === 'manual' ? ' you start' : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <KeywordsField id="seo-rank-add-keywords" value={text} onChange={setText} room={room} autoFocus />
          {after && !raises && <EstimateLine text={estimateSentence(after)} />}
          {shown && raises && <BeforeAfter answer={shown} />}
          {keywords.length > 0 && !over && !shown && estimate.failed && <EstimateFailed onRetry={estimate.retry} />}
          {formError && (
            <p data-seo-form-error="" className="text-xs text-destructive">
              {formError}
            </p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-add-keywords-submit="" disabled={!canAdd} onClick={() => void add()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {raises && after ? `Add, ${monthlyWords(after)}` : keywords.length > 0 ? `Add ${keywords.length.toLocaleString()}` : 'Add'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** "This costs about $X" before a press that spends, in the start dialog's look (not a destructive confirm). */
export function SpendConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label={title} data-seo-spend-confirm="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-spend-confirm-go="" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
