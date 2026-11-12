'use client'

/**
 * The AI visibility page's dialogs, in ../start-audit.tsx's look (a small
 * rounded-lg dialog, xs labels, Cancel and one primary):
 *
 *   TrackerFormDialog    New tracker and Edit tracker: the brand, its other
 *                        names, the website, competitors (name + site, a
 *                        small repeatable row), country and language, the
 *                        assistants (one the country can't serve is off, the
 *                        reason in its title), how often, and (new only) the
 *                        questions, one per line. Under the fields, the
 *                        estimate from POST estimate (debounced). A schedule
 *                        spends on its own, so the route answers 409
 *                        CONFIRMATION_REQUIRED until the person says yes
 *                        (turning a schedule on even with no questions yet,
 *                        or any rise in what a running one spends): the
 *                        estimates it carries (now and after) are shown in
 *                        the dialog and the primary names the cost ("Create,
 *                        about $X a month", "Save, nothing until questions
 *                        are added"); only that press sends `confirmed`.
 *   AddQuestionsDialog   more questions; on a running schedule the same
 *                        confirmation whenever they raise the monthly cost.
 *   SpendConfirmDialog   "this costs about $X" before a press that spends,
 *                        with a route's estimates (now and after) when it
 *                        asked for the yes.
 *
 * Every figure shown is one the routes returned. A correctable refusal is
 * said in the dialog, beside the field it is about where there is one;
 * lookups off (a guest, the free plan) and a check that could not run just
 * now (CHECK_FAILED: press again) are said under the fields.
 */
import * as React from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  ALL_AI_ENGINES,
  DEFAULT_ENGINES,
  MAX_ALIASES,
  MAX_COMPETITORS,
  MAX_PROMPT_LENGTH,
  MAX_PROMPTS_PER_ADD,
  MAX_PROMPTS_PER_TRACKER,
  type AiScheduleSetting,
} from '@/lib/seo/ai-visibility/limits'
import type { AiCostEstimate, AiEngine, AiTrackerView } from '@/lib/seo/ai-visibility/view'
import { AI_ENGINE_LABELS, aiEngineUsesModelApi } from '@/lib/seo/shared/ai-visibility'
import { DEFAULT_LOCATION_CODE, LOCATION_OPTIONS, getLanguageCode, getLanguageOptions } from '@/lib/seo/shared/keyword-locations'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import { count } from '../ui-helpers'
import { SCHEDULE_OPTIONS, addedWords, engineUnavailable, estimateSentence, monthlyWords, parseNames, parseQuestionLines, spendSentence } from './ai-helpers'
import {
  DATA_OFF_CODES,
  addPrompts,
  confirmationOf,
  createTracker,
  fetchEstimate,
  updateTracker,
  type AiConfirmation,
  type AiTrackerFields,
} from './api'

const CONTENT = 'w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4'
const TRIGGER = 'h-8 w-auto min-w-0 gap-1.5 rounded-md px-2.5 text-xs shadow-none'
const ESTIMATE_DEBOUNCE_MS = 400

/** The one-line hint under every questions box. */
export const QUESTION_HINT = 'Write them the way a customer would ask, without your name in them. For example: Who are the best rug cleaners in Portland?'

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

function Field({
  label,
  htmlFor,
  children,
  error,
  hint,
  field,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
  error?: string | null
  hint?: React.ReactNode
  field?: string
}) {
  return (
    <div className="space-y-1.5" data-seo-field={field}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-xs text-muted-foreground">
          {label}
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">{label}</p>
      )}
      {children}
      {error ? (
        <p data-seo-field-error={field ?? ''} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <div className="text-[11px] leading-relaxed text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  )
}

/** The quiet estimate line under a form's fields. */
function EstimateLine({ text, loading }: { text: string | null; loading?: boolean }) {
  if (!text) return null
  return (
    <p data-seo-estimate="" className={cn('text-[11px] tabular-nums text-muted-foreground transition-opacity', loading && 'opacity-60')} title="An estimate from the providers’ current prices">
      {text}
    </p>
  )
}

/** A failure the person can simply retry (the plan or membership couldn't be read) gets a Try again button on its toast. */
export function retryAction(code: string | null, again: () => void) {
  return code === 'CHECK_FAILED' ? { action: { label: 'Try again', onClick: again } } : {}
}

/** What the route asked the person to agree to (the cost now and after), in the dialog's body. */
function ConfirmBox({ confirmation, children }: { confirmation: AiConfirmation; children?: React.ReactNode }) {
  const after = confirmation.estimate ? spendSentence(confirmation.estimate) : null
  const before = confirmation.previous_estimate ? spendSentence(confirmation.previous_estimate) : null
  return (
    <div data-seo-confirm-box="" className="space-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] leading-relaxed tabular-nums text-muted-foreground">
      {children ? <p className="text-foreground">{children}</p> : null}
      {before && (
        <p className="flex gap-2">
          <span className="w-9 shrink-0 text-foreground">Now</span>
          <span className="min-w-0">{before}</span>
        </p>
      )}
      {after ? (
        <p className={before ? 'flex gap-2' : undefined}>
          {before && <span className="w-9 shrink-0 text-foreground">After</span>}
          <span className="min-w-0">{after}</span>
        </p>
      ) : (
        <p>{confirmation.message}</p>
      )}
    </div>
  )
}

/** The questions box: one per line, a live count against the room left. */
function QuestionsField({
  id,
  value,
  onChange,
  room,
  autoFocus,
  error,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  room: number
  autoFocus?: boolean
  error?: string | null
}) {
  const questions = parseQuestionLines(value)
  const n = questions.length
  const over = n > room
  const tooLong = questions.some((q) => q.length > MAX_PROMPT_LENGTH)
  const own = over ? (room > 0 ? `Up to ${room.toLocaleString()} here.` : 'This tracker is full.') : tooLong ? `Keep each question under ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` : null
  return (
    <div className="space-y-1.5" data-seo-field="questions">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          Questions to ask, one per line
        </label>
        <span data-seo-question-count="" className={cn('text-[11px] tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
          {n.toLocaleString()} of {room.toLocaleString()}
        </span>
      </div>
      <Textarea
        id={id}
        data-seo-questions=""
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'Who are the best rug cleaners in Portland?\nHow much does professional rug cleaning cost?'}
        rows={5}
        aria-invalid={own || error ? true : undefined}
        className="min-h-[96px] resize-y text-sm"
      />
      {own || error ? (
        <p data-seo-field-error="questions" className="text-xs text-destructive">
          {own ?? error}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{QUESTION_HINT}</p>
      )}
    </div>
  )
}

/** Valid as typed: within the room and the length cap. */
function questionsOk(text: string, room: number): boolean {
  const q = parseQuestionLines(text)
  return q.length <= room && q.every((x) => x.length <= MAX_PROMPT_LENGTH)
}

type FieldKey = 'brand' | 'aliases' | 'domain' | 'competitors' | 'market' | 'engines' | 'questions' | 'form'

/** Which field a refusal's sentence is about (the core's words name it). */
export function fieldOfRefusal(code: string | null, message: string): FieldKey {
  if (code === 'NO_SITE') return 'domain'
  if (code === 'NO_PROMPTS') return 'questions'
  if (code !== 'VALIDATION_ERROR') return 'form'
  const m = message.toLowerCase()
  if (/competitor/.test(m)) return 'competitors'
  if (/other name|alias/.test(m)) return 'aliases'
  if (/website|domain|site|address/.test(m)) return 'domain'
  if (/engine|assistant|can’t be checked|can't be checked/.test(m)) return 'engines'
  if (/country|language|market/.test(m)) return 'market'
  if (/prompt|question/.test(m)) return 'questions'
  if (/name/.test(m)) return 'brand'
  return 'form'
}

interface CompetitorDraft {
  key: number
  name: string
  domain: string
}

// ── New tracker and Edit tracker ─────────────────────────────────────────

export function TrackerFormDialog({
  open,
  tracker,
  defaultDomain,
  scheduleBlocked,
  onClose,
  onSaved,
  onDataOff,
}: {
  open: boolean
  /** The tracker to change, or null to make a new one. */
  tracker: AiTrackerView | null
  defaultDomain?: string | null
  /** Why the schedule can't be changed now (lookups are off), or null. */
  scheduleBlocked?: string | null
  onClose: () => void
  onSaved: (tracker: AiTrackerView, created: boolean) => void
  /** Lookups turned out to be off (the spend read is refreshed). */
  onDataOff?: () => void
}) {
  const editing = !!tracker
  const [brand, setBrand] = React.useState('')
  const [aliases, setAliases] = React.useState('')
  const [domain, setDomain] = React.useState('')
  const [competitors, setCompetitors] = React.useState<CompetitorDraft[]>([])
  const [locationCode, setLocationCode] = React.useState(DEFAULT_LOCATION_CODE)
  const [languageCode, setLanguageCode] = React.useState(getLanguageCode(DEFAULT_LOCATION_CODE))
  const [engines, setEngines] = React.useState<AiEngine[]>([...DEFAULT_ENGINES])
  const [howOften, setHowOften] = React.useState<AiScheduleSetting>('off')
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({})
  const [confirmation, setConfirmation] = React.useState<AiConfirmation | null>(null)
  const [estimate, setEstimate] = React.useState<AiCostEstimate | null>(null)
  const [estimating, setEstimating] = React.useState(false)
  const nextKey = React.useRef(0)
  const asked = React.useRef(0)

  // Each opening starts from the tracker (or the defaults).
  React.useEffect(() => {
    if (!open) return
    const t = tracker
    setBrand(t?.brand_name ?? '')
    setAliases(t?.brand_aliases.join(', ') ?? '')
    setDomain(t?.domain ?? defaultDomain ?? '')
    setCompetitors((t?.competitors ?? []).map((c) => ({ key: nextKey.current++, name: c.name, domain: c.domain })))
    setLocationCode(t?.location_code ?? DEFAULT_LOCATION_CODE)
    setLanguageCode(t?.language_code ?? getLanguageCode(DEFAULT_LOCATION_CODE))
    setEngines(t ? [...t.engines] : [...DEFAULT_ENGINES])
    setHowOften(t?.schedule_interval ?? 'off')
    setText('')
    setErrors({})
    setConfirmation(null)
    setEstimate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open])

  const questions = React.useMemo(() => parseQuestionLines(text), [text])
  const chosen = React.useMemo(() => engines.filter((e) => !engineUnavailable(e, locationCode)), [engines, locationCode])

  // A change after the route asked for a yes asks again.
  const touch = React.useCallback((key?: FieldKey) => {
    setConfirmation(null)
    setErrors((prev) => {
      if (!(key && key in prev) && !('form' in prev)) return prev
      const next = { ...prev }
      if (key) delete next[key]
      delete next.form
      return next
    })
  }, [])

  // The estimate: a new tracker's settings, or the saved tracker with the change laid over it.
  const draft = useDebounced(
    JSON.stringify({ n: questions.length, engines: chosen, howOften, locationCode, languageCode }),
    ESTIMATE_DEBOUNCE_MS,
  )
  React.useEffect(() => {
    if (!open) return
    const d = JSON.parse(draft) as { n: number; engines: AiEngine[]; howOften: AiScheduleSetting; locationCode: number; languageCode: string }
    const ask = ++asked.current
    if (d.engines.length === 0 || (!editing && (d.n === 0 || d.n > MAX_PROMPTS_PER_TRACKER))) {
      setEstimate(null)
      setEstimating(false)
      return
    }
    setEstimating(true)
    fetchEstimate(
      editing
        ? { tracker_id: tracker!.id, engines: d.engines, schedule_interval: d.howOften, location_code: d.locationCode, language_code: d.languageCode }
        : { prompt_count: d.n, engines: d.engines, schedule_interval: d.howOften, location_code: d.locationCode, language_code: d.languageCode },
    )
      .then((e) => {
        if (ask === asked.current) setEstimate(e)
      })
      .catch(() => {
        if (ask === asked.current) setEstimate(null)
      })
      .finally(() => {
        if (ask === asked.current) setEstimating(false)
      })
  }, [draft, open, editing, tracker])

  const competitorRows = competitors.filter((c) => c.name.trim() || c.domain.trim())
  const competitorMissingSite = competitorRows.some((c) => !c.domain.trim())
  const tooManyAliases = parseNames(aliases).length > MAX_ALIASES
  const scheduled = howOften !== 'off'
  const settled = draft === JSON.stringify({ n: questions.length, engines: chosen, howOften, locationCode, languageCode })
  // A schedule spends on its own: its figure must be on screen before saving.
  const waitingForCost = scheduled && (editing || questions.length > 0) && chosen.length > 0 && (!estimate || estimating || !settled)
  const canSubmit =
    !busy &&
    brand.trim().length > 0 &&
    chosen.length > 0 &&
    !competitorMissingSite &&
    !tooManyAliases &&
    (editing || questionsOk(text, MAX_PROMPTS_PER_TRACKER)) &&
    !waitingForCost

  const fields = (): AiTrackerFields => ({
    brand_name: brand.trim(),
    brand_aliases: parseNames(aliases),
    domain: domain.trim() || null,
    competitors: competitorRows.map((c) => ({ name: c.name.trim() || null, domain: c.domain.trim() })),
    location_code: locationCode,
    language_code: languageCode,
    engines: chosen,
    schedule_interval: howOften,
  })

  /** Only what changed, for an edit. */
  const changes = (): AiTrackerFields => {
    if (!tracker) return fields()
    const all = fields()
    const out: AiTrackerFields = {}
    if (all.brand_name !== tracker.brand_name) out.brand_name = all.brand_name
    if (JSON.stringify(all.brand_aliases) !== JSON.stringify(tracker.brand_aliases)) out.brand_aliases = all.brand_aliases
    if ((all.domain ?? '') !== tracker.domain) out.domain = all.domain
    if (JSON.stringify(all.competitors) !== JSON.stringify(tracker.competitors.map((c) => ({ name: c.name || null, domain: c.domain })))) out.competitors = all.competitors
    if (all.location_code !== tracker.location_code) out.location_code = all.location_code
    if (all.language_code !== tracker.language_code) out.language_code = all.language_code
    if (JSON.stringify(all.engines) !== JSON.stringify(tracker.engines)) out.engines = all.engines
    if (all.schedule_interval !== tracker.schedule_interval) out.schedule_interval = all.schedule_interval
    return out
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setErrors({})
    const confirmed = confirmation !== null
    try {
      if (tracker) {
        const change = changes()
        if (Object.keys(change).length === 0) {
          onClose()
          return
        }
        const out = await updateTracker(tracker.id, { ...change, ...(confirmed ? { confirmed: true } : {}) })
        onClose()
        toast('Saved. The next check uses the new settings.')
        onSaved(out.tracker, false)
      } else {
        const out = await createTracker({ ...fields(), ...(questions.length ? { prompts: questions } : {}), ...(confirmed ? { confirmed: true } : {}) })
        onClose()
        toast(
          questions.length > 0
            ? `Tracking ${out.tracker.brand_name} with ${count(out.prompts.length, 'question')}.`
            : `Tracking ${out.tracker.brand_name}. Add the questions your customers ask next.`,
        )
        onSaved(out.tracker, true)
      }
    } catch (err) {
      const asking = confirmationOf(err)
      const code = errorCode(err)
      if (asking) setConfirmation(asking)
      else if (code && DATA_OFF_CODES.has(code)) {
        // Lookups are off for this person: nothing to say yes to any more.
        setConfirmation(null)
        setErrors({ form: errorMessage(err) })
        onDataOff?.()
      } else if (code === 'CHECK_FAILED') {
        // A passing failure: said here, and the same press tries again.
        setErrors({ form: errorMessage(err) })
      } else if (code === 'VALIDATION_ERROR' || code === 'NO_SITE' || code === 'NO_PROMPTS' || code === 'TRACKER_LIMIT' || code === 'DUPLICATE_TRACKER') {
        setErrors({ [fieldOfRefusal(code, errorMessage(err))]: errorMessage(err) })
      } else toast.error(editing ? 'Could not save the tracker' : 'Could not set up the tracker', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  const languages = getLanguageOptions(locationCode)
  // After the route asked for a yes, the primary names the cost it carries.
  const primary = confirmation
    ? editing
      ? confirmation.estimate
        ? `Save, ${monthlyWords(confirmation.estimate)}`
        : 'Save and confirm'
      : confirmation.estimate
        ? `Create, ${monthlyWords(confirmation.estimate)}`
        : 'Create and start schedule'
    : editing
      ? 'Save'
      : 'Create tracker'
  const how = howOften === 'weekly' ? 'Weekly' : 'Monthly'
  // Turning a schedule on (the tracker was checked by hand), or raising what a running one spends.
  const confirmLead = !editing
    ? `${how} checks start as soon as it is created, paid for from this workspace’s search data.`
    : tracker?.schedule_interval === 'off'
      ? `${how} checks start on their own, paid for from this workspace’s search data.`
      : 'This raises what the tracker spends on its own.'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent
        aria-label={editing ? 'Edit tracker' : 'New tracker'}
        data-seo-tracker-form={editing ? 'edit' : 'new'}
        className={cn(CONTENT, 'max-h-[calc(100vh-2rem)] overflow-y-auto')}
      >
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">{editing ? 'Edit tracker' : 'New tracker'}</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            {editing
              ? 'What the assistants are asked about, and how often. Past checks and their answers stay as they are.'
              : 'Asks AI assistants the questions your customers would ask, and checks whether the answers name you, who they name instead, and which websites they lean on.'}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <Field label="Business or brand name" htmlFor="seo-ai-brand" field="brand" error={errors.brand}>
            <Input
              id="seo-ai-brand"
              data-seo-ai-brand=""
              autoFocus
              value={brand}
              placeholder="Fernhill Studio"
              aria-invalid={errors.brand ? true : undefined}
              onChange={(e) => {
                setBrand(e.target.value)
                touch('brand')
              }}
              className="h-8 text-sm"
            />
          </Field>

          <Field
            label="Other names it goes by (optional)"
            htmlFor="seo-ai-aliases"
            field="aliases"
            error={errors.aliases ?? (tooManyAliases ? `Up to ${MAX_ALIASES} other names.` : null)}
            hint="Separated by commas, so an answer that says “Fernhill” still counts."
          >
            <Input
              id="seo-ai-aliases"
              data-seo-ai-aliases=""
              value={aliases}
              placeholder="Fernhill, Fernhill Studios"
              onChange={(e) => {
                setAliases(e.target.value)
                touch('aliases')
              }}
              className="h-8 text-sm"
            />
          </Field>

          <Field label="Website" htmlFor="seo-ai-domain" field="domain" error={errors.domain}>
            <Input
              id="seo-ai-domain"
              data-seo-ai-domain=""
              value={domain}
              placeholder="example.com"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={errors.domain ? true : undefined}
              onChange={(e) => {
                setDomain(e.target.value)
                touch('domain')
              }}
              className="h-8 text-sm"
            />
          </Field>

          <Field
            label="Competitors (optional)"
            field="competitors"
            error={errors.competitors ?? (competitorMissingSite ? 'Give each competitor’s website.' : null)}
          >
            {competitors.length > 0 && (
              <div className="space-y-1.5">
                {competitors.map((c, i) => (
                  <div key={c.key} data-seo-competitor-row={i} className="flex items-center gap-1.5">
                    <Input
                      aria-label={`Competitor ${i + 1} name`}
                      data-seo-competitor-name=""
                      value={c.name}
                      placeholder="Name"
                      onChange={(e) => {
                        const v = e.target.value
                        setCompetitors((prev) => prev.map((x) => (x.key === c.key ? { ...x, name: v } : x)))
                        touch('competitors')
                      }}
                      className="h-8 min-w-0 flex-1 text-sm"
                    />
                    <Input
                      aria-label={`Competitor ${i + 1} website`}
                      data-seo-competitor-domain=""
                      value={c.domain}
                      placeholder="their-site.com"
                      inputMode="url"
                      spellCheck={false}
                      onChange={(e) => {
                        const v = e.target.value
                        setCompetitors((prev) => prev.map((x) => (x.key === c.key ? { ...x, domain: v } : x)))
                        touch('competitors')
                      }}
                      className="h-8 min-w-0 flex-1 text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-seo-competitor-remove=""
                      aria-label={`Remove competitor ${i + 1}`}
                      title="Remove"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setCompetitors((prev) => prev.filter((x) => x.key !== c.key))
                        touch('competitors')
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              data-seo-competitor-add=""
              disabled={competitors.length >= MAX_COMPETITORS}
              title={competitors.length >= MAX_COMPETITORS ? `A tracker compares with up to ${MAX_COMPETITORS} competitors` : 'Compare with another business'}
              onClick={() => {
                setCompetitors((prev) => [...prev, { key: nextKey.current++, name: '', domain: '' }])
                touch('competitors')
              }}
              className="-ml-2 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Plus className="h-3 w-3" />
              Add a competitor
            </button>
          </Field>

          <Field label="Where your customers are" field="market" error={errors.market}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                value={String(locationCode)}
                onValueChange={(v) => {
                  const code = Number(v)
                  setLocationCode(code)
                  setLanguageCode(getLanguageCode(code))
                  touch('market')
                }}
              >
                <SelectTrigger data-seo-country="" aria-label="Country" title="The country the assistants are asked from" className={TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {LOCATION_OPTIONS.map((l) => (
                    <SelectItem key={l.code} value={String(l.code)} className="text-xs">
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {languages.length > 1 && (
                <Select
                  value={languageCode}
                  onValueChange={(v) => {
                    setLanguageCode(v)
                    touch('market')
                  }}
                >
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

          <Field label="Assistants to ask" field="engines" error={errors.engines ?? (chosen.length === 0 ? 'Choose at least one.' : null)}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {ALL_AI_ENGINES.map((engine) => {
                const off = engineUnavailable(engine, locationCode)
                const checked = !off && engines.includes(engine)
                const id = `seo-ai-engine-${engine}`
                return (
                  <label
                    key={engine}
                    htmlFor={id}
                    data-seo-engine-option={engine}
                    title={off ?? (aiEngineUsesModelApi(engine) ? `${AI_ENGINE_LABELS[engine]} is asked through its own service, which costs more per answer` : undefined)}
                    className={cn('flex items-center gap-2 text-xs', off ? 'cursor-not-allowed text-muted-foreground/60' : 'cursor-pointer text-foreground')}
                  >
                    <Checkbox
                      id={id}
                      data-seo-engine={engine}
                      checked={checked}
                      disabled={!!off}
                      onCheckedChange={(next) => {
                        setEngines((prev) => (next ? [...prev.filter((e) => e !== engine), engine] : prev.filter((e) => e !== engine)))
                        touch('engines')
                      }}
                      className="h-3.5 w-3.5"
                    />
                    {AI_ENGINE_LABELS[engine]}
                  </label>
                )
              })}
            </div>
          </Field>

          <Field
            label="How often"
            field="schedule"
            hint={
              scheduleBlocked
                ? scheduleBlocked
                : howOften === 'off'
                  ? 'Checked only when you press Check now.'
                  : 'Checks run on their own and are paid for from this workspace’s search data.'
            }
          >
            <fieldset disabled={!!scheduleBlocked} title={scheduleBlocked ?? undefined} className="min-w-0 disabled:opacity-60">
              <FilterChips
                label="How often"
                options={SCHEDULE_OPTIONS}
                value={howOften}
                onChange={(v) => {
                  setHowOften(v)
                  touch()
                }}
              />
            </fieldset>
          </Field>

          {!editing && (
            <QuestionsField
              id="seo-ai-questions"
              value={text}
              onChange={(v) => {
                setText(v)
                touch('questions')
              }}
              room={MAX_PROMPTS_PER_TRACKER}
              error={errors.questions}
            />
          )}

          {confirmation ? (
            <ConfirmBox confirmation={confirmation}>{confirmLead}</ConfirmBox>
          ) : (
            <EstimateLine text={estimate ? estimateSentence(estimate) : null} loading={estimating || !settled} />
          )}
          {errors.form && (
            <p data-seo-form-error="" className="text-xs text-destructive">
              {errors.form}
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-save-tracker="" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {primary}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Add questions ────────────────────────────────────────────────────────

export function AddQuestionsDialog({
  open,
  tracker,
  promptCount,
  activeCount,
  onClose,
  onAdded,
  onDataOff,
}: {
  open: boolean
  tracker: AiTrackerView
  /** Questions the tracker holds now (the cap counts them all). */
  promptCount: number
  /** Questions it asks now (what a check costs counts these). */
  activeCount: number
  onClose: () => void
  onAdded: () => void
  /** Lookups turned out to be off (the spend read is refreshed). */
  onDataOff?: () => void
}) {
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  /** A refusal about the whole add (lookups off, a check that failed), not the questions typed. */
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [confirmation, setConfirmation] = React.useState<AiConfirmation | null>(null)
  const [estimate, setEstimate] = React.useState<AiCostEstimate | null>(null)
  const asked = React.useRef(0)

  React.useEffect(() => {
    if (!open) return
    setText('')
    setFormError(null)
    setRefusal(null)
    setConfirmation(null)
    setEstimate(null)
  }, [open])

  const questions = React.useMemo(() => parseQuestionLines(text), [text])
  const room = Math.max(0, Math.min(MAX_PROMPTS_PER_ADD, MAX_PROMPTS_PER_TRACKER - promptCount))
  const ok = questions.length > 0 && questionsOk(text, room)
  const key = useDebounced(ok ? questions.length : 0, ESTIMATE_DEBOUNCE_MS)

  React.useEffect(() => {
    const ask = ++asked.current
    if (!open || key === 0) {
      setEstimate(null)
      return
    }
    fetchEstimate({ tracker_id: tracker.id, prompt_count: activeCount + key })
      .then((e) => {
        if (ask === asked.current) setEstimate(e)
      })
      .catch(() => {
        if (ask === asked.current) setEstimate(null)
      })
  }, [open, key, tracker.id, activeCount])

  const add = async () => {
    if (!ok || busy) return
    setBusy(true)
    setFormError(null)
    setRefusal(null)
    try {
      // `confirmed` only once the route's cost is on screen and the press is the button that names it.
      const out = await addPrompts(tracker.id, questions, confirmation !== null)
      onClose()
      toast(addedWords(out))
      onAdded()
    } catch (err) {
      const asking = confirmationOf(err)
      const code = errorCode(err)
      if (asking) setConfirmation(asking)
      else if (code && DATA_OFF_CODES.has(code)) {
        // Lookups are off for this person: nothing to say yes to any more.
        setConfirmation(null)
        setRefusal(errorMessage(err))
        onDataOff?.()
      } else if (code === 'CHECK_FAILED') setRefusal(errorMessage(err))
      else if (code === 'VALIDATION_ERROR' || code === 'NO_PROMPTS') setFormError(errorMessage(err))
      else toast.error('Could not add the questions', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  const scheduled = tracker.schedule_interval !== 'off' && !tracker.paused
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="Add questions" data-seo-add-questions-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Add questions</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            More questions to put to the assistants about {tracker.brand_name}. Nothing is asked until the next check{scheduled ? '' : ' you start'}.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <QuestionsField
            id="seo-ai-add-questions"
            value={text}
            onChange={(v) => {
              setText(v)
              setConfirmation(null)
              setFormError(null)
              setRefusal(null)
            }}
            room={room}
            autoFocus
            error={formError}
          />
          {confirmation ? (
            <ConfirmBox confirmation={confirmation}>This raises what the tracker spends on its own.</ConfirmBox>
          ) : (
            <EstimateLine text={estimate ? estimateSentence(estimate) : null} />
          )}
          {refusal && (
            <p data-seo-form-error="" className="text-xs text-destructive">
              {refusal}
            </p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-add-questions-submit="" disabled={!ok || busy} onClick={() => void add()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {confirmation
              ? confirmation.estimate
                ? `Add, ${monthlyWords(confirmation.estimate)}`
                : 'Add and confirm'
              : questions.length > 0
                ? `Add ${questions.length.toLocaleString()}`
                : 'Add'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Spend confirmation ───────────────────────────────────────────────────

/**
 * "This costs about $X" before a press that spends, in the start dialog's
 * look (not a destructive confirm). With `confirmation` (a route's 409
 * CONFIRMATION_REQUIRED), the cost it carries is shown under the
 * description, now and after, as the form dialogs show it.
 */
export function SpendConfirmDialog({
  open,
  title,
  description,
  confirmation,
  confirmationLead,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmation?: AiConfirmation | null
  /** The first line of the cost box. */
  confirmationLead?: string
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
        {confirmation && (
          <div className="mt-3">
            <ConfirmBox confirmation={confirmation}>{confirmationLead}</ConfirmBox>
          </div>
        )}
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
