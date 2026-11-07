'use client'

/**
 * The ICP as editable prose blocks, in the CRM Details tab's typographic
 * register — label above, value below, hover to reveal the affordances.
 *
 * Shared by the New-list sheet and the list detail's ICP panel so an ICP looks
 * and edits identically wherever it is met. Two rules the register carries
 * over from `details-tab-parts.tsx`:
 *
 *  1. Every row wrapper carries `group/row`, which is what `CopyValueButton`
 *     keys its hover reveal on — the same grammar as an enriched field.
 *  2. A seeded field gets a muted PROVENANCE line — "From your company profile
 *     · dial8.ai" — under the value, with the source link when the enrichment
 *     blob carried one. The seed is a proposal, never a commitment (§4), and
 *     the line is what makes that legible instead of the value just appearing.
 *
 * The ICP is prose-shaped, not filter-shaped, on purpose (§4): Exa's deep
 * search consumes a query string and a systemPrompt, so every structured
 * filter would be flattened back to prose before the call. A filter UI would
 * be a lossy intermediate the user tunes and cannot debug.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ExternalLink, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyValueButton } from '@/components/views/copy-value-button'
import { sourceHost } from '@/lib/crm/enrichment-details'
import type { IcpProvenance, IcpProvenanceMap } from '@/lib/prospecting/icp'
import type { Icp } from '@/lib/prospecting/types'

// ============================================================
// Provenance
// ============================================================

/**
 * "From your company profile · dial8.ai" under a seeded value.
 *
 * Rendered ONLY for `from: 'company_profile'`. A template default is not
 * provenance — claiming "from your company profile" for a string we wrote
 * ourselves would be the one lie that makes every other provenance line
 * untrustworthy.
 */
export function ProvenanceLine({ provenance }: { provenance?: IcpProvenance }) {
  if (!provenance || provenance.from !== 'company_profile') return null
  const host = sourceHost(provenance.source_url)
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
      />
      <span>From your company profile</span>
      {provenance.source_url ? (
        <>
          <span aria-hidden="true">·</span>
          <a
            href={provenance.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
          >
            {host ?? 'source'}
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </>
      ) : null}
    </p>
  )
}

// ============================================================
// Prose block
// ============================================================

/**
 * Label above, value below — the Details tab's block layout, made editable.
 *
 * Click (or tab) into the value and it becomes a textarea; blur commits. The
 * two states share the same padding and type scale so committing does not move
 * the text by a pixel — the single detail that makes hover-to-edit feel like
 * editing the document rather than opening a form.
 */
export function IcpProseField({
  label,
  value,
  placeholder,
  provenance,
  rows = 3,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  provenance?: IcpProvenance
  rows?: number
  onChange: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // The parent owns the value (template switches replace the whole ICP). Adopt
  // an external change only while NOT editing, so a switch mid-keystroke can
  // never silently discard what the user is typing.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (editing) areaRef.current?.focus()
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft !== value) onChange(draft)
  }

  return (
    <div className="group/row rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <span className="block text-xs text-muted-foreground">{label}</span>
          {editing ? (
            <textarea
              ref={areaRef}
              rows={rows}
              value={draft}
              aria-label={label}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(value)
                  setEditing(false)
                }
                // Cmd/Ctrl+Enter commits without leaving the keyboard; a bare
                // Enter stays a newline, because these are prose fields.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
              }}
              className="mt-0.5 w-full resize-none rounded-sm border-none bg-transparent p-0 text-sm leading-relaxed outline-none ring-0 placeholder:text-muted-foreground/60 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-0.5 block w-full cursor-text text-left text-sm leading-relaxed"
            >
              {value ? (
                <span className="whitespace-pre-wrap">{value}</span>
              ) : (
                <span className="text-muted-foreground/60">
                  {placeholder ?? `Add ${label.toLowerCase()}`}
                </span>
              )}
            </button>
          )}
          <ProvenanceLine provenance={provenance} />
        </div>
        <CopyValueButton value={value} label={label} />
      </div>
    </div>
  )
}

// ============================================================
// Chip list
// ============================================================

/**
 * A list rendered as removable chips with an inline add — `buyer_titles`,
 * `comparables`, industries, geographies.
 *
 * Comma and Enter both commit, because a user pasting "Partner, Principal"
 * means two chips and typing them one at a time means the same two.
 */
export function IcpChipField({
  label,
  values,
  placeholder,
  provenance,
  onChange,
}: {
  label: string
  values: string[]
  placeholder?: string
  provenance?: IcpProvenance
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const seen = new Set(values.map((v) => v.toLowerCase()))
    const next = [...values]
    for (const part of parts) {
      if (seen.has(part.toLowerCase())) continue
      seen.add(part.toLowerCase())
      next.push(part)
    }
    if (next.length !== values.length) onChange(next)
    setDraft('')
  }

  return (
    <div className="group/row rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {values.map((value, i) => (
          <span
            key={`${value}-${i}`}
            className="group/chip inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`Remove ${value}`}
              className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Plus className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-60" />
          <input
            value={draft}
            aria-label={`Add ${label.toLowerCase()}`}
            placeholder={values.length === 0 ? (placeholder ?? 'Add…') : 'Add…'}
            onChange={(e) => {
              // A pasted comma list commits immediately rather than sitting in
              // the input looking like one long chip-to-be.
              if (e.target.value.includes(',')) add(e.target.value)
              else setDraft(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(draft)
              }
              if (e.key === 'Backspace' && draft === '' && values.length > 0) {
                onChange(values.slice(0, -1))
              }
            }}
            onBlur={() => add(draft)}
            className="min-w-[7rem] flex-1 border-none bg-transparent p-0 text-xs outline-none placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </span>
      </div>
      <ProvenanceLine provenance={provenance} />
    </div>
  )
}

// ============================================================
// Disclosure
// ============================================================

/** The "Advanced" disclosure — same chevron grammar as `UnverifiedGroup`. */
export function IcpDisclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  )
}

// ============================================================
// The whole editor
// ============================================================

/**
 * Every editable ICP field, in reading order: who we are, who we want, then
 * `anti` + `search_hint` behind Advanced (they narrow rather than describe,
 * and an exclusion the user did not ask for is the one seeded value that
 * silently costs them results).
 *
 * `source` is read-only here. It describes the workspace's own company, which
 * is corrected through "Not your company?" — editing it inside a list would
 * make each list's idea of the company diverge from the CRM row.
 */
export function IcpEditor({
  icp,
  provenance,
  onChange,
}: {
  icp: Icp
  provenance: IcpProvenanceMap
  onChange: (next: Icp) => void
}) {
  const patchTarget = <K extends keyof Icp['target']>(key: K, value: Icp['target'][K]) =>
    onChange({ ...icp, target: { ...icp.target, [key]: value } })
  const patchAnti = <K extends keyof Icp['anti']>(key: K, value: Icp['anti'][K]) =>
    onChange({ ...icp, anti: { ...icp.anti, [key]: value } })

  return (
    <div className="space-y-4">
      {/* ── Who we are ── */}
      <section className="space-y-0.5">
        <h3 className="px-2 text-sm font-medium">What we sell</h3>
        <IcpProseField
          label="Our product"
          value={icp.source.what_we_sell}
          placeholder="What your company sells, in a sentence"
          provenance={provenance['source.what_we_sell']}
          onChange={(v) => onChange({ ...icp, source: { ...icp.source, what_we_sell: v } })}
        />
        <IcpChipField
          label="Our customers"
          values={icp.source.our_customers}
          placeholder="Named customers or logos"
          provenance={provenance['source.our_customers']}
          onChange={(v) => onChange({ ...icp, source: { ...icp.source, our_customers: v } })}
        />
      </section>

      {/* ── Who we want ── */}
      <section className="space-y-0.5">
        <h3 className="px-2 text-sm font-medium">Who to find</h3>
        <IcpProseField
          label="Description"
          value={icp.target.description}
          rows={4}
          placeholder="The kind of company or person to look for. Everything below is optional narrowing."
          provenance={provenance['target.description']}
          onChange={(v) => patchTarget('description', v)}
        />
        <IcpChipField
          label="Industries"
          values={icp.target.industries}
          provenance={provenance['target.industries']}
          onChange={(v) => patchTarget('industries', v)}
        />
        <IcpChipField
          label="Size"
          values={icp.target.employee_bands}
          placeholder="11-50, 51-200…"
          provenance={provenance['target.employee_bands']}
          onChange={(v) => patchTarget('employee_bands', v)}
        />
        <IcpChipField
          label="Geographies"
          values={icp.target.geographies}
          provenance={provenance['target.geographies']}
          onChange={(v) => patchTarget('geographies', v)}
        />
        <IcpChipField
          label="Buyer titles"
          values={icp.target.buyer_titles}
          placeholder="Head of Sales, Founder…"
          provenance={provenance['target.buyer_titles']}
          onChange={(v) => patchTarget('buyer_titles', v)}
        />
        <IcpChipField
          label="Use cases"
          values={icp.target.use_cases}
          provenance={provenance['target.use_cases']}
          onChange={(v) => patchTarget('use_cases', v)}
        />
        <IcpChipField
          label="Comparables"
          values={icp.target.comparables}
          placeholder="Companies or portfolios to cite as evidence"
          provenance={provenance['target.comparables']}
          onChange={(v) => patchTarget('comparables', v)}
        />
      </section>

      {/* ── Advanced ── */}
      <IcpDisclosure label="Advanced">
        <IcpChipField
          label="Exclude industries"
          values={icp.anti.exclude_industries}
          onChange={(v) => patchAnti('exclude_industries', v)}
        />
        <IcpChipField
          label="Exclude keywords"
          values={icp.anti.exclude_keywords}
          onChange={(v) => patchAnti('exclude_keywords', v)}
        />
        <IcpProseField
          label="Notes"
          value={icp.anti.notes}
          placeholder="Anything else to steer away from"
          rows={2}
          onChange={(v) => patchAnti('notes', v)}
        />
        <IcpProseField
          label="Search hint"
          value={icp.search_hint}
          placeholder="Free text appended to every search"
          rows={2}
          onChange={(v) => onChange({ ...icp, search_hint: v })}
        />
        <IcpChipField
          label="Competitors"
          values={icp.target.competitors}
          onChange={(v) => patchTarget('competitors', v)}
        />
      </IcpDisclosure>
    </div>
  )
}
