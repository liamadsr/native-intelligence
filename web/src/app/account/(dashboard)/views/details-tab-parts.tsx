'use client'

import { useState } from 'react'
import { ChevronRight, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyValueButton } from '@/components/views/copy-value-button'
import { relativeTime } from '@/components/views/enrichment'
import {
  chipText,
  displayUrl,
  looksLikeList,
  parseKeyPeople,
  sourceHost,
  splitList,
  type DetailField,
  type DetailSection,
  type DetailSource,
  type DetailsModel,
} from '@/lib/crm/enrichment-details'
import { Linkify } from '@/components/ui/linkify'

/**
 * Building blocks shared by the company and contact Details tabs — the
 * status line, a section (rows or block layout), one field row with its
 * hover copy button and provenance dot, the Unverified quarantine, the
 * sources list, and the empty state. Each tab is just a model plus these.
 *
 * Every row wrapper carries `group/row`, which is what CopyValueButton keys
 * its hover reveal on.
 */

// ============================================================
// Status
// ============================================================

/**
 * "Enriched today · 8 sources" / "Researching acme.com…" / failure. Sits
 * above everything because it's the one fact that qualifies the rest.
 */
export function DetailsStatusLine({
  model,
  enriching,
  subject,
}: {
  model: Pick<DetailsModel, 'status' | 'enrichedAt' | 'sources' | 'error'>
  enriching: boolean
  /** What is being researched, for the pending line ("acme.com", "Jane Doe"). */
  subject: string
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {enriching || model.status === 'pending' ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Researching {subject}…
        </span>
      ) : model.status === 'failed' ? (
        <>Enrichment failed{model.error ? `: ${model.error}` : '.'}</>
      ) : model.enrichedAt ? (
        <>
          Enriched {relativeTime(model.enrichedAt)}
          {model.sources.length > 0
            ? ` · ${model.sources.length} source${model.sources.length === 1 ? '' : 's'}`
            : ''}
        </>
      ) : (
        <>Not yet enriched</>
      )}
    </p>
  )
}

// ============================================================
// Sections and fields
// ============================================================

export function DetailSectionView({ section }: { section: DetailSection }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{section.title}</h3>
      {section.layout === 'rows' ? (
        <div className="space-y-0.5">
          {section.fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {section.fields.map((field) => (
            <BlockField key={field.key} field={field} />
          ))}
        </div>
      )}
    </section>
  )
}

/** Label / value / copy / source — the table-ish layout for short facts. */
export function FieldRow({ field }: { field: DetailField }) {
  return (
    <div className="group/row flex items-start gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
      <span className="w-28 shrink-0 pt-px text-xs text-muted-foreground">{field.label}</span>
      <div className="min-w-0 flex-1 text-sm">
        <Value field={field} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <CopyValueButton value={field.value} label={field.label} />
        <SourceMark field={field} />
      </div>
    </div>
  )
}

/**
 * A single long value under its section heading — leadership, products,
 * a timeline. The copy button and source mark ride on the top line so the
 * content can use the full width.
 */
export function BlockField({ field }: { field: DetailField }) {
  return (
    <div className="group/row rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 text-sm">
          <Value field={field} />
        </div>
        <CopyValueButton value={field.value} label={field.label} />
        <SourceMark field={field} />
      </div>
    </div>
  )
}

function Value({ field }: { field: DetailField }) {
  switch (field.kind) {
    case 'url': {
      const href = /^https?:\/\//i.test(field.value) ? field.value : `https://${field.value}`
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block max-w-full truncate align-bottom hover:underline"
        >
          {displayUrl(field.value)}
        </a>
      )
    }
    case 'list': {
      // A sentence pretending to be a list stays a sentence (see looksLikeList).
      if (!looksLikeList(field.value)) return <p className="leading-relaxed"><Linkify text={field.value} /></p>
      return (
        <div className="flex flex-wrap gap-1">
          {splitList(field.value).map((item, i) => (
            <span
              key={`${item}-${i}`}
              className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
            >
              {chipText(item)}
            </span>
          ))}
        </div>
      )
    }
    case 'people': {
      const people = parseKeyPeople(field.value)
      if (people.length === 0) return <span>{field.value}</span>
      return (
        <ul className="space-y-1">
          {people.map((p, i) => (
            <li key={`${p.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{p.name}</span>
              {p.title && <span className="text-xs text-muted-foreground">{p.title}</span>}
            </li>
          ))}
        </ul>
      )
    }
    case 'timeline': {
      const entries = field.entries ?? []
      if (entries.length === 0) return <p className="leading-relaxed"><Linkify text={field.value} /></p>
      return <Timeline entries={entries} />
    }
    case 'prose':
      return <p className="leading-relaxed"><Linkify text={field.value} /></p>
    default:
      return <span className="break-words"><Linkify text={field.value} /></span>
  }
}

/**
 * Dated entries down a rail: title in the foreground weight, org under it,
 * the period right-aligned in tabular figures so the years line up.
 */
function Timeline({ entries }: { entries: NonNullable<DetailField['entries']> }) {
  return (
    <ol className="relative ml-1 space-y-3 border-l border-border pl-4">
      {entries.map((entry, i) => (
        <li key={`${entry.title}-${i}`} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-[7px] h-2 w-2 rounded-full border-2 border-background bg-muted-foreground/60"
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 font-medium">{entry.title}</span>
            {entry.period && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {entry.period}
              </span>
            )}
          </div>
          {entry.org && <div className="text-xs text-muted-foreground">{entry.org}</div>}
        </li>
      ))}
    </ol>
  )
}

/**
 * Provenance dot for a web-sourced value. Green = the run tied it to the
 * record; amber = low confidence (only ever shown under Unverified). Links to
 * the page it was read from when there is one, so a reader can check any fact
 * in one click.
 */
export function SourceMark({ field }: { field: DetailField }) {
  if (!field.enriched) return null
  const host = sourceHost(field.sourceUrl)
  const low = field.confidence === 'low'
  // Fields carry over between runs (re-enriching only ever adds), so say
  // when this one was actually found rather than when the row was last run.
  const found = field.foundAt ? relativeTime(field.foundAt) : ''
  const title = [
    low ? 'Low confidence' : 'From the web',
    field.confidence && !low ? `${field.confidence} confidence` : null,
    host,
    found ? `found ${found}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const dot = (
    <span className={cn('h-1.5 w-1.5 rounded-full', low ? 'bg-amber-500' : 'bg-emerald-500')} />
  )
  const cls = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md'
  if (!field.sourceUrl) {
    return (
      <span className={cls} title={title} aria-label={title}>
        {dot}
      </span>
    )
  }
  return (
    <a
      href={field.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, 'hover:bg-muted')}
      title={title}
      aria-label={title}
    >
      {dot}
    </a>
  )
}

// ============================================================
// Unverified
// ============================================================

/**
 * Low-confidence findings, collapsed by default. They are real things the
 * search read, but nothing tied them to this record — so they are shown as
 * "found", never as the record, and were never written to a column.
 */
export function UnverifiedGroup({
  fields,
  scope,
}: {
  fields: DetailField[]
  /** What the findings couldn't be tied to ("dial8.ai", "Jane Doe"). */
  scope: string
}) {
  const [open, setOpen] = useState(false)
  if (fields.length === 0) return null
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        Unverified
        <span className="text-xs font-normal opacity-70">{fields.length}</span>
      </button>
      {open && (
        <div className="space-y-1">
          <p className="px-2 text-xs text-muted-foreground">
            Found on pages that couldn&apos;t be tied to {scope}. Not written to the record.
          </p>
          {fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Sources
// ============================================================

export function SourcesList({ sources }: { sources: DetailSource[] }) {
  if (sources.length === 0) return null
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">Sources</h3>
      <div className="space-y-0.5">
        {sources.map((source, i) => {
          const host = sourceHost(source.url)
          return (
            <div
              key={`${source.url}-${i}`}
              className="group/row flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/40"
            >
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate">{source.title || displayUrl(source.url)}</span>
                {host && source.title && (
                  <span className="shrink-0 text-[10px] opacity-60">{host}</span>
                )}
              </a>
              <CopyValueButton value={source.url} label="link" />
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ============================================================
// Empty state
// ============================================================

/**
 * Nothing to show yet. Points at the toolbar's sparkle button instead of
 * adding a second enrich control — one way to run it, in one place.
 */
export function DetailsEmptyState({
  foundNothing,
  sources,
  fills,
  scope,
}: {
  foundNothing: boolean
  sources: DetailSource[]
  /** What enrichment would fill in ("industry, size, funding, …"). */
  fills: string
  /** What the search couldn't tie its findings to ("this company", "this person"). */
  scope: string
}) {
  const hint = (
    <>
      <Sparkles className="inline h-3 w-3 -mt-0.5" aria-hidden="true" />
      <span className="sr-only">Enrich from web</span>
    </>
  )
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        {foundNothing ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">Nothing found on the web</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The search ran but nothing it read could be tied to {scope}. Check the
              record, then run {hint} Enrich again from the toolbar.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm font-medium">No details yet</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Use {hint} Enrich in the toolbar to fill in {fills} — each with the page it
              came from.
            </p>
          </div>
        )}
      </div>
      {foundNothing && <SourcesList sources={sources} />}
    </div>
  )
}
