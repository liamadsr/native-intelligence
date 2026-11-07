'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * Web enrichment — shared UI for the contact and company detail panels.
 *
 * The backend job is fire-and-forget: POST .../enrich returns 202 immediately
 * and an Inngest worker fills the row in later. There is no push event for
 * completion, so the panels poll their own detail GET until `enrichment_status`
 * leaves 'pending' (see useEnrichment).
 *
 * Everything the enricher found that has no column of its own lives in
 * `metadata.enrichment` (twitter/github handles, funding, the source list, the
 * model's summary). EnrichmentSection renders that blob read-only — it's
 * provenance, not a form.
 *
 * The blob also records which real columns the run wrote (`applied_fields`),
 * which is what EnrichedBadge (header) and EnrichedFieldMark (per property row)
 * surface: values in this panel that came off the web rather than from a human.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, CircleCheck, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { PropertyGroup } from '@/components/views/property-group'
import { CopyValueButton } from '@/components/views/copy-value-button'

// ============================================================
// Types — mirror of the server's metadata.enrichment contract
// ============================================================

export type EnrichmentStatus = 'pending' | 'enriched' | 'failed' | 'skipped'

export interface EnrichmentField {
  value: string | number | null
  source_url?: string | null
  source_title?: string | null
  confidence?: 'high' | 'medium' | 'low'
  /** When the run that found this value finished — carried across re-runs. */
  found_at?: string | null
}

export interface EnrichmentSource {
  url: string
  title?: string | null
  published_date?: string | null
}

export interface EnrichmentMetadata {
  version: number
  status: EnrichmentStatus
  enriched_at?: string | null
  model?: string | null
  /** Untyped on the server (jsonb bag) — read entries through `fieldValue`. */
  fields?: Record<string, EnrichmentField | unknown>
  applied_fields?: string[]
  sources?: EnrichmentSource[]
  summary?: string | null
  /** CONTACTS ONLY — the text the run appended to `contact.notes`, if any. */
  notes_summary?: string | null
  search_cost_dollars?: number | null
  error?: string | null
  permanent?: boolean
}

/** The slice of a contact/company row this feature reads. */
export interface EnrichableRow {
  enrichment_status?: EnrichmentStatus | null
  enriched_at?: string | null
  metadata?: { enrichment?: EnrichmentMetadata } & Record<string, unknown> | null
}

// ============================================================
// Polling hook
// ============================================================

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 120000

interface UseEnrichmentOptions<T extends EnrichableRow> {
  /** 'contacts' | 'companies' — the /api/account/<entity>/<id> segment. */
  endpoint: 'contacts' | 'companies'
  id: string
  /** Current row, or null while the panel is still loading. */
  row: T | null
  /**
   * Merge a freshly-fetched row into panel state. Called once the poll sees a
   * terminal status (or the enrich POST itself returns a row).
   */
  onRefreshed: (row: T) => void
  /** Key the detail GET response is nested under ('contact' | 'company'). */
  responseKey: 'contact' | 'company'
}

export function useEnrichment<T extends EnrichableRow>({
  endpoint,
  id,
  row,
  onRefreshed,
  responseKey,
}: UseEnrichmentOptions<T>) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  // Latest callback without re-arming the poll loop on every panel render.
  const onRefreshedRef = useRef(onRefreshed)
  onRefreshedRef.current = onRefreshed

  const status = row?.enrichment_status ?? null
  const isPending = status === 'pending'

  // Reset transient state when the panel switches records.
  useEffect(() => {
    setError(null)
    setStarting(false)
  }, [id])

  // Poll while pending — covers both "we just kicked it off" and "the panel
  // opened on a row a previous session left pending". Gives up after
  // POLL_TIMEOUT_MS so a stuck job doesn't poll forever.
  useEffect(() => {
    if (!isPending) {
      setPolling(false)
      return
    }
    setPolling(true)
    let cancelled = false
    let stopped = false
    const startedAt = Date.now()

    const tick = async () => {
      // Stopped by the timeout or a terminal status: the reveal must not
      // restart what the timer already ended.
      if (stopped) return
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        stopped = true
        clearInterval(timer)
        if (!cancelled) setPolling(false)
        return
      }
      try {
        const res = await fetch(`/api/account/${endpoint}/${id}`)
        if (!res.ok) return
        const data = await res.json()
        const fresh = data?.[responseKey] as T | undefined
        if (!fresh || cancelled) return
        if (fresh.enrichment_status !== 'pending') {
          stopped = true
          clearInterval(timer)
          setPolling(false)
          onRefreshedRef.current(fresh)
        }
      } catch {
        // Transient network failure — the next tick retries.
      }
    }
    const timer = setInterval(tick, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isPending, endpoint, id, responseKey])

  const enrich = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/${endpoint}/${id}/enrich`, { method: 'POST' })
      if (res.ok || res.status === 202) {
        // Flip to pending locally — that's what arms the poll effect above.
        onRefreshedRef.current({ enrichment_status: 'pending' } as unknown as T)
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Enrichment failed.')
      }
    } catch {
      setError('Enrichment failed.')
    }
    setStarting(false)
  }, [endpoint, id])

  return {
    enrich,
    /** True while the POST is in flight or the job is running. */
    busy: starting || isPending || polling,
    error,
    clearError: () => setError(null),
  }
}

// ============================================================
// Toolbar button
// ============================================================

/**
 * Toolbar icon button. Matches the neighbouring Share/Delete buttons exactly
 * (ghost, h-7 w-7, h-3.5 icon); busy swaps the icon for the same inline
 * `Loader2` spinner the other in-flight small buttons use — the thinking orb's
 * floor is 20px and would blow out this row.
 */
export function EnrichButton({
  onClick,
  busy,
}: {
  onClick: () => void
  busy: boolean
}) {
  return (
    <PreferenceActionButton label="Enrich from web"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 text-muted-foreground"
      onClick={onClick}
      disabled={busy}
      title="Enrich from web"
      aria-label="Enrich from web"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
    </PreferenceActionButton>
  )
}

/** Inline failure note for the toolbar row. */
export function EnrichError({ message }: { message: string }) {
  return <span className="max-w-[220px] truncate text-xs text-destructive">{message}</span>
}

// ============================================================
// Provenance markers — "this came from the web, not a human"
// ============================================================

/**
 * True for a run that completed but contributed NOTHING to the row.
 *
 * The extractor is deliberately anti-hallucinatory: when the search turns up
 * only company-level pages for what is actually a group alias (or any address
 * with no person behind it), it returns no fields at all and the run still ends
 * `status: 'enriched'` — a successful search with an empty result. The blob then
 * looks like `{ status: 'enriched', fields: {}, applied_fields: [], summary: null,
 * sources: [...] }`. Showing the green "Enriched" pill and a source list for that
 * reads as "we added value" when nothing was written, so both surfaces branch on
 * this instead.
 *
 * Only 'enriched' can be empty in this sense — 'failed'/'skipped'/'pending' have
 * their own handling and are never reported here.
 *
 * Tolerant by design: the blob is untyped jsonb, so every key may be missing or
 * the wrong type (fields as an array/string, applied_fields as a scalar). Anything
 * unreadable counts as "no contribution" rather than throwing.
 */
export function isEmptyEnrichment(
  enrichment: EnrichmentMetadata | null | undefined,
): boolean {
  if (!enrichment || typeof enrichment !== 'object') return false
  if (enrichment.status !== 'enriched') return false

  const applied = enrichment.applied_fields
  if (Array.isArray(applied) && applied.length > 0) return false

  // Plain object only: an array or scalar in `fields` carries no readable
  // field/value pairs, so it does not count as a contribution.
  const fields = enrichment.fields
  if (
    fields != null &&
    typeof fields === 'object' &&
    !Array.isArray(fields) &&
    Object.keys(fields).length > 0
  ) {
    return false
  }

  if (hasText(enrichment.summary)) return false
  if (hasText(enrichment.notes_summary)) return false

  return true
}

/**
 * Header pill next to the entity name. Renders only for a row that finished an
 * enrichment run, so the reader knows some of what they're looking at was
 * filled in by the enricher rather than typed by someone.
 *
 * Green because "enriched" is a settled-good state, drawn in the codebase's
 * standard success chip (border-emerald-500/30 + bg-emerald-500/10 + emerald
 * text, light and dark) — same tokens as the environments badge and the
 * proposal card's applied state. Deliberately NOT the toolbar button's
 * Sparkles: that icon marks the ACTION, this marks the resulting state.
 *
 * A run that finished having written nothing (see isEmptyEnrichment) gets no
 * pill: the badge claims the panel holds web-sourced values, and for that row it
 * doesn't. EnrichmentSection says what happened instead.
 */
export function EnrichedBadge({ row }: { row: EnrichableRow }) {
  if (row.enrichment_status !== 'enriched') return null

  const enrichment = row.metadata?.enrichment
  if (isEmptyEnrichment(enrichment)) return null
  const when = enrichment?.enriched_at ?? row.enriched_at ?? null
  const sourceCount = enrichment?.sources?.length ?? 0

  const rel = when ? relativeTime(when) : ''
  const title = [
    rel ? `Enriched from the web ${rel}` : 'Enriched from the web',
    sourceCount > 0 ? `${sourceCount} source${sourceCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
      title={title}
    >
      <CircleCheck className="h-3 w-3" />
      Enriched
    </span>
  )
}

/**
 * Tiny marker for one property row whose value the enricher filled in
 * (`applied_fields` is the server's record of exactly which columns it wrote).
 *
 * Renders nothing for a field the enricher didn't touch, which is what lets the
 * panels drop it beside every property unconditionally.
 *
 * Provenance is per-RUN, not per-value: a human who later edits an enriched
 * field keeps the marker, because nothing tracks that edit. Accepted — the
 * marker means "this column was filled from the web", not "this exact string is
 * still the web's".
 */
export function EnrichedFieldMark({
  enrichment,
  field,
}: {
  enrichment: EnrichmentMetadata | null | undefined
  field: string
}) {
  if (!enrichment?.applied_fields?.includes(field)) return null

  const domain = sourceDomain(enrichment.fields?.[field])
  const title = domain
    ? `Filled by web enrichment · ${domain}`
    : 'Filled by web enrichment'

  // A green dot in the badge's emerald, not an icon: at the end of a dense 8px
  // property row the dot reads as a quiet provenance flag rather than another
  // control. Wrapped in a span so `title` is a real tooltip (the panels' own
  // idiom for icon-only affordances) and the 3px dot keeps a 12px hit area.
  return (
    <span
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
      title={title}
      aria-label={title}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
    </span>
  )
}

// ============================================================
// Properties section
// ============================================================

/** One extra field to surface — reads out of `metadata.enrichment.fields`. */
export interface ExtraFieldSpec {
  /** Key in `fields`. */
  name: string
  label: string
  /** Render the value as an external link. */
  link?: boolean
}

/**
 * Read-only "Enrichment" group for the properties sidebar. Renders nothing
 * unless the row carries a `metadata.enrichment` blob.
 *
 * Two modes. The default lists every extra field and source right here — the
 * contact panel's whole enrichment surface. With `onViewDetails` the group
 * collapses to summary + status + a "View details" link: the company panel
 * has a full Details tab for the structured fields, so repeating them in a
 * 289px sidebar would only make the same data harder to read twice.
 */
export function EnrichmentSection({
  enrichment,
  extraFields = [],
  showSummary = true,
  onViewDetails,
}: {
  enrichment: EnrichmentMetadata | null | undefined
  extraFields?: ExtraFieldSpec[]
  /**
   * Render the model's bio paragraph here. Contacts pass false: their summary
   * is written into `contact.notes` by the enricher and shown in the main-body
   * Notes editor, so repeating it in the sidebar would duplicate it. Companies
   * have no notes column and keep it.
   */
  showSummary?: boolean
  /** Compact mode: replace the field + source lists with a link to the Details tab. */
  onViewDetails?: () => void
}) {
  if (!enrichment) return null

  const sources = enrichment.sources ?? []
  const fields = enrichment.fields ?? {}
  // The server stores `fields` as an untyped jsonb bag — read each entry
  // defensively rather than trusting the declared shape.
  const extras = extraFields
    .map((spec) => ({ spec, value: fieldValue(fields[spec.name]) }))
    .filter((e): e is { spec: ExtraFieldSpec; value: string } => e.value !== null)
  // Compact mode has no field list of its own to count; any readable blob
  // field is a reason to point at the Details tab.
  const hasFields =
    fields != null && typeof fields === 'object' && !Array.isArray(fields) &&
    Object.keys(fields).length > 0

  const when = enrichment.enriched_at
  const failed = enrichment.status === 'failed'

  // A 'skipped' run (nothing found, nothing to say) can leave a blob with no
  // summary, extras or sources — don't render an empty titled group for it.
  // A summary we're not rendering (showSummary=false) doesn't count as content.
  const summary = showSummary ? enrichment.summary : null
  const hasDetails = onViewDetails ? hasFields : extras.length > 0
  if (!failed && !summary && !hasDetails && sources.length === 0) {
    return null
  }

  // Successful run that wrote nothing (the group-alias case). Everything below
  // would be provenance for values that don't exist: the sources are real pages
  // the search read, but as a list under a contact they read as findings. Say
  // plainly that the search came up empty and stop — one muted line, no links.
  // Note this is reachable only when sources exist; a no-source empty run has
  // already returned null above.
  if (isEmptyEnrichment(enrichment)) {
    return (
      <PropertyGroup title="Enrichment">
        <div className="space-y-2.5 px-2 pt-0.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Searched the web — no additional information found
            {sources.length > 0 || when
              ? ` (${[
                  sources.length > 0
                    ? `${sources.length} source${sources.length === 1 ? '' : 's'} checked`
                    : null,
                  when ? relativeTime(when) : null,
                ]
                  .filter(Boolean)
                  .join(', ')})`
              : ''}
            .
          </p>
        </div>
      </PropertyGroup>
    )
  }

  return (
    <PropertyGroup title="Enrichment">
      <div className="space-y-2.5 px-2 pt-0.5">
        {failed ? (
          <p className="text-xs text-muted-foreground">
            Enrichment failed{enrichment.error ? `: ${enrichment.error}` : '.'}
          </p>
        ) : (
          <>
            {summary && (
              <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
            )}

            {(when || sources.length > 0) && (
              <p className="text-[11px] text-muted-foreground/70">
                {when ? `Enriched ${relativeTime(when)}` : 'Enriched'}
                {sources.length > 0
                  ? ` · ${sources.length} source${sources.length === 1 ? '' : 's'}`
                  : ''}
              </p>
            )}

            {onViewDetails && (hasFields || sources.length > 0) && (
              <button
                type="button"
                onClick={onViewDetails}
                className="inline-flex items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline"
              >
                View details
                <ArrowRight className="h-3 w-3" />
              </button>
            )}

            {!onViewDetails && extras.length > 0 && (
              <div className="space-y-0.5">
                {extras.map(({ spec, value }) => {
                  return (
                    <div
                      key={spec.name}
                      className="group/row -mx-1 flex items-baseline gap-2 rounded px-1 py-0.5 text-xs"
                    >
                      <span className="w-20 shrink-0 text-muted-foreground">{spec.label}</span>
                      {spec.link ? (
                        <a
                          href={value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 flex-1 truncate text-foreground hover:underline"
                        >
                          {displayUrl(value)}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 text-foreground">{value}</span>
                      )}
                      <CopyValueButton value={value} label={spec.label} className="-my-1 h-5 w-5" />
                    </div>
                  )
                })}
              </div>
            )}

            {!onViewDetails && sources.length > 0 && (
              <div className="space-y-1">
                {sources.map((source, i) => (
                  <a
                    key={`${source.url}-${i}`}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {source.title || displayUrl(source.url)}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </PropertyGroup>
  )
}

// ============================================================
// Helpers
// ============================================================

/**
 * True when an untyped jsonb slot holds real prose. A non-string (null, a
 * number, an object left there by an older writer) is not a summary, and
 * whitespace is not content.
 */
function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** Same shape as the panels' own relativeTime — kept here so this file drops in anywhere. */
export function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}

/**
 * Pull the display string out of one `fields` entry. Entries are `{ value,
 * source_url, confidence }`, but the column is untyped jsonb — tolerate a bare
 * scalar and treat anything empty as absent.
 */
function fieldValue(entry: unknown): string | null {
  if (entry == null) return null
  const raw =
    typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)
      ? (entry as Record<string, unknown>).value
      : entry
  if (raw == null || typeof raw === 'object') return null
  const str = String(raw).trim()
  return str === '' ? null : str
}

/** Strip scheme/www so a bare URL reads as a label in a 289px sidebar. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

/**
 * Bare host of one `fields` entry's `source_url` ("linkedin.com"), for the
 * per-field marker's tooltip. Same defensive read as fieldValue — the column is
 * untyped jsonb, and a non-URL string there should just mean "no domain".
 */
function sourceDomain(entry: unknown): string | null {
  if (entry == null || typeof entry !== 'object') return null
  const raw = (entry as Record<string, unknown>).source_url
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
