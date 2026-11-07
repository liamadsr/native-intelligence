'use client'

import { AlertTriangle } from 'lucide-react'
import { LIFECYCLE_BUCKETS, type LifecycleBucket } from '@/lib/tasks/lifecycle'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * The three bucket→destination map cards — THREE separate implementations, on
 * purpose, and the most important comment in this refactor.
 *
 * They look like one component with an `editable` flag and a `guessedMap` slot.
 * They are not. What differs is the MEANING of an unmapped bucket, and it
 * differs three ways:
 *
 *   Asana   — unmapped = "don't move the task". A real, inert choice. Which is
 *             exactly why it is safe to PREFILL a name-heuristic guess: a guess
 *             the user ignores does nothing.
 *   Jira    — unmapped = "Automatic (by category)". Still transitions the issue,
 *             just by statusCategory instead of an id the user picked. So a
 *             guess must NEVER be pre-selected here — it would show a specific
 *             status as chosen when nothing is stored and the real fallback
 *             might land elsewhere. The fallback is NAMED beside the control
 *             instead.
 *   Linear  — there is nothing to map. `WorkflowState.type` is a stable
 *             seven-value enum, so the mapping is a FACT about the team that the
 *             server derives; this card renders it read-only and warns where a
 *             bucket came out empty.
 *
 * A shared `BucketMapTable` with an `editable` boolean would erase that, and the
 * first thing a future provider would inherit is Asana's guess-prefill applied
 * to semantics where it lies. If a fourth provider ever makes generalising these
 * genuinely right, it should have to re-derive "what does unmapped mean here"
 * explicitly rather than inherit a default.
 *
 * They live here for file-size relief only. Each renders byte-identical DOM to
 * the inline version it replaced, including the row shape
 * (`<div><span>label</span>…</div>`) that linear-destination.test.tsx's
 * `stageRows()` parser walks.
 */

/** Human labels for the four canonical lifecycle buckets. */
export const BUCKET_LABELS: Record<LifecycleBucket, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  canceled: 'Canceled',
}

// ---------------------------------------------------------------------------
// Asana — editable, with name-heuristic PREFILL
// ---------------------------------------------------------------------------

export function AsanaSectionMap({
  sections,
  /**
   * The DISPLAY map: the saved map when there is one, otherwise the
   * BUCKET_NAME_HINTS guesses. Never the source of a PATCH — see
   * handleSelectAsanaSection, which builds from the SAVED map.
   */
  effectiveSectionMap,
  noSectionSentinel,
  onSelect,
}: {
  sections: Array<{ gid: string; name: string }>
  effectiveSectionMap: Partial<Record<LifecycleBucket, string | null>>
  noSectionSentinel: string
  onSelect: (bucket: LifecycleBucket, value: string) => void
}) {
  return (
    <div className="mt-3 rounded-lg border border-border px-4 py-3">
      <p className="text-sm font-medium">Section for each status</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Optional. When an action changes status, Dial8 moves its
        Asana task into the matching section.
      </p>
      <div className="mt-3 space-y-2">
        {LIFECYCLE_BUCKETS.map((bucket) => (
          <div key={bucket} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">
              {BUCKET_LABELS[bucket]}
            </span>
            <Select
              value={effectiveSectionMap[bucket] ?? noSectionSentinel}
              onValueChange={(value) => onSelect(bucket, value)}
            >
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={noSectionSentinel}>Don&apos;t move</SelectItem>
                {sections.map((section) => (
                  <SelectItem key={section.gid} value={section.gid}>
                    {section.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Asana has no “canceled” state — a canceled action closes
        its task, so map that bucket to a section if you need to
        tell the two apart.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Jira — editable, and the fallback is NAMED rather than pre-selected
// ---------------------------------------------------------------------------

export function JiraStatusMap({
  statuses,
  /** The SAVED map only. There is no guessed display map here, by design. */
  statusMap,
  autoSentinel,
  /** What "Automatic" resolves to today — a hint, never a pre-selection. */
  automaticStatusName,
  onSelect,
}: {
  statuses: Array<{ id: string; name: string }>
  statusMap: Partial<Record<LifecycleBucket, string | null>> | undefined
  autoSentinel: string
  automaticStatusName: (bucket: LifecycleBucket) => string | null
  onSelect: (bucket: LifecycleBucket, value: string) => void
}) {
  return (
    <div className="mt-3 rounded-lg border border-border px-4 py-3">
      <p className="text-sm font-medium">Status for each stage</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Optional. When an action changes status, Dial8
        transitions its Jira issue to match.
      </p>
      <div className="mt-3 space-y-2">
        {LIFECYCLE_BUCKETS.map((bucket) => {
          const mapped = statusMap?.[bucket] ?? null
          const automatic = automaticStatusName(bucket)
          return (
            <div key={bucket} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {BUCKET_LABELS[bucket]}
              </span>
              <Select
                value={mapped ?? autoSentinel}
                onValueChange={(value) => onSelect(bucket, value)}
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={autoSentinel}>
                    Automatic (by category)
                  </SelectItem>
                  {statuses.map((status) => (
                    <SelectItem key={status.id} value={status.id}>
                      {status.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* What "Automatic" resolves to today — a hint,
                  never a pre-selection (see
                  automaticStatusName). */}
              <span className="w-28 shrink-0 truncate text-xs text-muted-foreground/60">
                {!mapped && automatic ? `→ ${automatic}` : ''}
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Jira has no “canceled” category — canceled and done
        statuses both sit in Done. Dial8 looks for a
        cancel-ish status name and sets a “Won&apos;t Do”
        resolution when the transition offers one; map the
        bucket explicitly if your workflow names it something
        else.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Linear — READ-ONLY, and that is the whole point rather than a missing feature
// ---------------------------------------------------------------------------

export function LinearStateMap({
  /** DERIVED server-side. A bucket the team cannot express is ABSENT. */
  stateMap,
}: {
  stateMap: Partial<Record<LifecycleBucket, { id: string; name: string }>> | undefined
}) {
  return (
    <div className="mt-3 rounded-lg border border-border px-4 py-3">
      <p className="text-sm font-medium">State for each stage</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Set automatically from the team&apos;s workflow. When
        an action changes status, Dial8 moves its Linear
        issue to the matching state.
      </p>
      <div className="mt-3 space-y-2">
        {LIFECYCLE_BUCKETS.map((bucket) => {
          const mapped = stateMap?.[bucket] ?? null
          return (
            <div key={bucket} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {BUCKET_LABELS[bucket]}
              </span>
              {mapped ? (
                <span className="min-w-0 flex-1 truncate text-xs">
                  {mapped.name}
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    This team has no matching state — Dial8
                    won&apos;t move the issue for this stage.
                  </span>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Add a state of the right kind in Linear and re-select
        the team here to pick it up.
      </p>
    </div>
  )
}
