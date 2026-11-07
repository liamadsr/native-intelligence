'use client'

/**
 * The knowledge inspector, generalised over BOTH renderers.
 *
 * The legacy graph resolves a node's detail synchronously from the payload it
 * already holds; the map fetches it per node. So this file splits the panel
 * into a shell (`InspectorShell` — chrome, close button, scroll area) and
 * pure presentational bodies (`ClaimBody`, `EntityBody`) that take already-
 * shaped data. `KnowledgeView` composes the legacy panel from them, and
 * `MapInspector` composes the async one, which is why the two never drift.
 *
 * Positioning is the one deliberate difference. In the map path the panel is
 * an ABSOLUTE overlay at every breakpoint: making it a flex sibling would
 * shrink the canvas on selection, which under the new architecture is a
 * viewport change — i.e. a camera adjustment and a round of tile refetches on
 * every single click (product critique B3). Below `sm` it becomes a bottom
 * sheet so the map stays visible behind it.
 */

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  ArrowUpRight,
  CheckCircle2,
  FileQuestion,
  FileText,
  HelpCircle,
  Lightbulb,
  Link2,
  Mail,
  Mic,
  Paperclip,
  Sparkles,
  X,
} from 'lucide-react'
import type { ClaimType } from '@/lib/knowledge/graph-map/types'

// ─── Shared presentation vocabulary ───────────────────────────────────────────

export const TYPE_BADGE_CLASSES: Record<ClaimType, string> = {
  fact: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  decision_summary:
    'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  open_question:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  inference: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

export const TYPE_LABEL: Record<ClaimType, string> = {
  fact: 'Fact',
  decision_summary: 'Decision',
  open_question: 'Question',
  inference: 'Inference',
}

export function typeIcon(type: ClaimType) {
  switch (type) {
    case 'fact':
      return <CheckCircle2 className="h-3 w-3" />
    case 'open_question':
      return <HelpCircle className="h-3 w-3" />
    case 'inference':
      return <Lightbulb className="h-3 w-3" />
    case 'decision_summary':
      return <CheckCircle2 className="h-3 w-3" />
  }
}

export function sourceIcon(type: string) {
  switch (type) {
    case 'capture':
      return <Mic className="h-3.5 w-3.5 shrink-0" />
    case 'document':
      return <FileText className="h-3.5 w-3.5 shrink-0" />
    case 'attachment':
      return <Paperclip className="h-3.5 w-3.5 shrink-0" />
    case 'email':
      return <Mail className="h-3.5 w-3.5 shrink-0" />
    case 'external_url':
      return <Link2 className="h-3.5 w-3.5 shrink-0" />
    default:
      return <FileQuestion className="h-3.5 w-3.5 shrink-0" />
  }
}

/**
 * Opens the entity behind a claim's source / link in a detail panel. Returns
 * true when the type is navigable, so the inspector can render the rest as
 * plain, non-interactive text instead of a dead "open" affordance.
 */
export type OpenEntity = (
  entityType: string,
  id: string,
  title: string,
  event?: React.MouseEvent,
) => boolean

/**
 * Entity types with a detail panel, so they render as a clickable affordance.
 * `company` is here because `handleKnowledgeEntityOpen` routes it to the
 * companies view; `conversation` / `campaign` are deliberately absent — they
 * are citable (so they appear as hubs) but have no detail panel to open.
 */
export const NAVIGABLE_ENTITY_TYPES = new Set([
  'capture',
  'contact',
  'document',
  'project',
  'action',
  'company',
])

export function canOpenEntity(type: string | undefined, onOpenEntity?: OpenEntity): boolean {
  return !!onOpenEntity && !!type && NAVIGABLE_ENTITY_TYPES.has(type)
}

// ─── Shell ────────────────────────────────────────────────────────────────────

export interface InspectorShellProps {
  title: string
  onClose: () => void
  /** True in the map path: never take width from the canvas (see file header). */
  overlay?: boolean
  children: React.ReactNode
}

export function InspectorShell({ title, onClose, overlay, children }: InspectorShellProps) {
  return (
    <div
      className={cn(
        'border-border bg-card z-20 flex flex-col shadow-xl',
        overlay
          ? // Bottom sheet on phones, right-hand overlay from `sm` up. Absolute
            // at every breakpoint so a click never resizes the canvas.
            'absolute inset-x-0 bottom-0 h-[50vh] rounded-t-xl border-t sm:inset-y-0 sm:right-0 sm:left-auto sm:h-auto sm:w-80 sm:rounded-none sm:border-t-0 sm:border-l'
          : 'absolute inset-y-0 right-0 w-80 shrink-0 border-l sm:relative sm:shadow-none',
      )}
      role="complementary"
      aria-label={title}
    >
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {title}
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1 transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">{children}</div>
      </ScrollArea>
    </div>
  )
}

// ─── Bodies ───────────────────────────────────────────────────────────────────

export interface ClaimBodyClaim {
  text: string
  type: ClaimType
  confidence: number | null
  confirmation: 'suggested' | 'confirmed' | 'dismissed'
  auto_accepted?: boolean | null
}

export interface ClaimBodySource {
  source_type: string
  source_id: string | null
  source_uri?: string | null
  excerpt: string | null
  label: string | null
}

export interface ClaimBodyLink {
  relation: string
  label: string
  type: string
  id: string
}

export function ClaimBody({
  claim,
  sources,
  links,
  onOpenEntity,
}: {
  claim: ClaimBodyClaim
  sources: ClaimBodySource[]
  links: ClaimBodyLink[]
  onOpenEntity?: OpenEntity
}) {
  const canOpen = (type: string) => canOpenEntity(type, onOpenEntity)

  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
            TYPE_BADGE_CLASSES[claim.type],
          )}
        >
          {typeIcon(claim.type)}
          {TYPE_LABEL[claim.type]}
        </span>
        {claim.confirmation === 'suggested' && (
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[9px]">
            suggested
          </span>
        )}
        {claim.confirmation === 'confirmed' && claim.auto_accepted && (
          <span
            title="Auto-accepted by the live agent because the AI was confident. You can dismiss or supersede it."
            className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400"
          >
            <Sparkles className="h-2.5 w-2.5" />
            Auto-accepted
          </span>
        )}
        {claim.confidence != null && (
          <span className="text-muted-foreground ml-auto text-[10px]">
            {Math.round(claim.confidence * 100)}% confident
          </span>
        )}
      </div>

      <p className="text-foreground text-sm leading-relaxed">{claim.text}</p>

      {sources.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
            Evidence
          </p>
          <div className="space-y-2">
            {sources.map((s, i) => {
              const openable = canOpen(s.source_type) && !!s.source_id
              return (
                <div
                  key={`${s.source_type}-${s.source_id ?? s.source_uri ?? i}`}
                  role={openable ? 'button' : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onClick={
                    openable
                      ? (e) => onOpenEntity?.(s.source_type, s.source_id!, s.label ?? '', e)
                      : undefined
                  }
                  onKeyDown={
                    openable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpenEntity?.(s.source_type, s.source_id!, s.label ?? '')
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'border-border bg-background/50 rounded-md border p-2 transition-colors',
                    openable && 'hover:border-foreground/30 hover:bg-accent/50 cursor-pointer',
                  )}
                >
                  <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[11px]">
                    {sourceIcon(s.source_type)}
                    <span className="capitalize">{s.source_type.replace('_', ' ')}</span>
                    {s.label && (
                      <span className="text-foreground min-w-0 flex-1 truncate font-medium">
                        {s.label}
                      </span>
                    )}
                    {openable && (
                      <ArrowUpRight className="text-muted-foreground ml-auto h-3 w-3 shrink-0" />
                    )}
                  </div>
                  {s.excerpt && (
                    <p className="text-muted-foreground text-xs leading-snug italic">
                      &ldquo;{s.excerpt}&rdquo;
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {links.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
            Linked to
          </p>
          <div className="flex flex-wrap gap-1.5">
            {links.map((l, i) => {
              const openable = canOpen(l.type)
              const className = cn(
                'border-border bg-background/50 text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                openable && 'hover:border-foreground/30 hover:bg-accent/50 cursor-pointer transition-colors',
              )
              const inner = (
                <>
                  <span className="text-muted-foreground">{l.relation}</span>
                  {l.label}
                  {openable && <ArrowUpRight className="text-muted-foreground h-3 w-3" />}
                </>
              )
              return openable ? (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => onOpenEntity?.(l.type, l.id, l.label, e)}
                  className={className}
                >
                  {inner}
                </button>
              ) : (
                <span key={i} className={className}>
                  {inner}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

export interface EntityBodyClaim {
  id: string
  text: string
  type: ClaimType
}

export function EntityBody({
  label,
  entityType,
  entityId,
  claims,
  /** Total matching claims on the server; omitted in the legacy path, where
   *  `claims` IS everything. */
  total,
  onLoadMore,
  loadingMore,
  onOpenEntity,
}: {
  label: string
  entityType?: string
  entityId: string
  claims: EntityBodyClaim[]
  total?: number
  onLoadMore?: () => void
  loadingMore?: boolean
  onOpenEntity?: OpenEntity
}) {
  const openable = canOpenEntity(entityType, onOpenEntity)
  const showing = claims.length
  const heading =
    total != null && total > showing
      ? `Showing ${showing} of ${total} claims`
      : `${showing} claim${showing !== 1 ? 's' : ''} from this source`

  return (
    <>
      <div>
        <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          {entityType ?? 'Source'}
        </p>
        {openable ? (
          <button
            type="button"
            onClick={(e) => onOpenEntity?.(entityType!, entityId, label, e)}
            className="text-foreground hover:text-foreground/80 group mt-0.5 inline-flex items-start gap-1 text-left text-sm font-medium"
          >
            {label}
            <ArrowUpRight className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
          </button>
        ) : (
          <p className="text-foreground mt-0.5 text-sm font-medium">{label}</p>
        )}
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
          {heading}
        </p>
        <div className="space-y-1.5">
          {claims.map((c) => (
            <div key={c.id} className="border-border bg-background/50 rounded-md border p-2">
              <span
                className={cn(
                  'mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium',
                  TYPE_BADGE_CLASSES[c.type],
                )}
              >
                {TYPE_LABEL[c.type]}
              </span>
              <p className="text-foreground line-clamp-3 text-xs leading-snug">{c.text}</p>
            </div>
          ))}
        </div>
        {onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="text-muted-foreground hover:text-foreground mt-2 text-xs underline-offset-2 hover:underline disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </>
  )
}

/** The missing-row copy, kept identical to what the legacy inspector shows. */
export function NotFoundBody() {
  return <p className="text-muted-foreground text-sm">This claim is no longer available.</p>
}

/** Placeholder rows that occupy the panel while the fetch is in flight. */
export function InspectorSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden>
      <div className="bg-muted h-4 w-20 rounded" />
      <div className="space-y-1.5">
        <div className="bg-muted h-3 w-full rounded" />
        <div className="bg-muted h-3 w-11/12 rounded" />
        <div className="bg-muted h-3 w-2/3 rounded" />
      </div>
      <div className="bg-muted h-16 w-full rounded-md" />
      <div className="bg-muted h-16 w-full rounded-md" />
    </div>
  )
}

export function InspectorError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">Couldn&rsquo;t load this node.</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-foreground text-xs underline underline-offset-2"
      >
        Retry
      </button>
    </div>
  )
}
