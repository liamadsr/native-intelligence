'use client'

/**
 * The "getting to know you" presence for the onboarding wizard (Phase 1 of
 * docs/plans/eve-migration-plan.md). Two composable surfaces backed by the same
 * useResearchCompanion hook:
 *
 *   • <ResearchLiveStrip>  — a compact, quietly-animated strip showing the
 *     agent's current friendly activity ("Searching the web for Acme…"). Meant
 *     to sit under a wizard step while research runs in the background. Renders
 *     nothing once research is terminal or was never running.
 *
 *   • <ResearchBriefCard>  — the payoff on the final "ready" step: a warm note
 *     framed as "While you were setting up…", or a single gentle line while the
 *     brief is still landing. Renders nothing for 'skipped'/absent research.
 *
 * Both match the wizard's existing visual language (framer-motion entrances,
 * bg-card/rounded-xl/border, muted foreground, lucide icons) and dark mode.
 */

import { motion, AnimatePresence } from 'framer-motion'
import { ThinkingOrb } from 'thinking-orbs'
import { Globe, Search, Activity, FileText, Building2 } from 'lucide-react'
import { OrbLoader } from '@/components/ui/loader'
import type { ResearchActivity, ResearchCompanion } from './use-research-companion'

// ─── Icon per activity kind ──────────────────────────────────

// Exported so the wizard's WorkingStep can render the same per-tool icon in its
// growing activity checklist — one visual vocabulary for research activity
// across the compact strip, the brief card, and the full timeline.
export function ActivityIcon({ kind }: { kind: string }) {
  const className = 'h-3.5 w-3.5 text-muted-foreground'
  switch (kind) {
    case 'web_search':
      return <Search className={className} />
    case 'web_fetch':
      return <Globe className={className} />
    case 'enrich_company':
    case 'enrich_me':
      return <Building2 className={className} />
    case 'save_research_claims':
      return <FileText className={className} />
    default:
      return <Activity className={className} />
  }
}

// ─── Compact live strip ──────────────────────────────────────

/**
 * A small strip that shows the researcher's latest friendly activity while it
 * works. Designed to sit quietly beneath a wizard step. Shows a subtle spinner
 * while running; disappears entirely once terminal (or if never active), so it
 * never competes with the step's primary CTA.
 */
export function ResearchLiveStrip({
  companion,
  className = '',
}: {
  companion: ResearchCompanion
  className?: string
}) {
  const { status, latest } = companion
  // Only present WHILE running. Terminal states are surfaced by the brief card
  // on the ready step, not here.
  const show = status === 'running'

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25 }}
          className={`mx-auto flex w-full max-w-sm items-center gap-2.5 rounded-lg border bg-card/60 px-3 py-2 text-left ${className}`}
        >
          <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <ThinkingOrb state="working" size={20} theme="auto" />
          </div>
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={latest?.id ?? 'thinking'}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-1.5"
              >
                {latest ? (
                  <>
                    <ActivityIcon kind={latest.kind} />
                    <span className="truncate text-xs text-muted-foreground">
                      {latest.label}
                    </span>
                  </>
                ) : (
                  <span className="truncate text-xs text-muted-foreground">
                    Getting to know you…
                  </span>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Brief card (ready step) ─────────────────────────────────

/**
 * The final "here's what I learned" note. Framed as a short first-person note
 * from the agent. Behavior by state:
 *   • 'done'    → show the brief prominently (titled "While you were setting up…").
 *   • 'running' → show the live indicator; the brief appears when it lands.
 *   • 'skipped' → a single gentle line (personal email → no company research).
 *   • idle/failed/no-brief → render nothing (quiet absence, never an error).
 */
export function ResearchBriefCard({
  companion,
}: {
  companion: ResearchCompanion
}) {
  const { status, brief, latest } = companion

  // Nothing worth showing: never started, or a hard failure with no brief.
  if (status === 'idle' || status === 'failed') return null

  // Personal-email skip: one quiet line, no card chrome.
  if (status === 'skipped' && !brief) {
    return (
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="mt-6 max-w-sm text-center text-xs text-muted-foreground"
      >
        Your workspace is all yours — I&apos;ll learn as we go.
      </motion.p>
    )
  }

  // Still running with no brief yet: gentle live line, brief fills in on finish.
  if (status === 'running' && !brief) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="mt-8 w-full max-w-sm rounded-xl border bg-card p-5 text-left"
      >
        <div className="flex items-center gap-2">
          <ThinkingOrb state="working" size={20} theme="auto" />
          <h3 className="text-sm font-semibold">Getting to know you</h3>
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
          {latest ? (
            <>
              <ActivityIcon kind={latest.kind} />
              <span className="truncate">{latest.label}</span>
            </>
          ) : (
            <span>
              I&apos;m looking into your workspace — this&apos;ll just take a
              moment.
            </span>
          )}
        </p>
      </motion.div>
    )
  }

  // We have a brief (status 'done', or a 'skipped' run that still left a note).
  if (!brief) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
      className="mt-8 w-full max-w-sm rounded-xl border bg-card p-5 text-left"
    >
      <div className="flex items-center gap-2">
        <OrbLoader state="working" size="sm" />
        <h3 className="text-sm font-semibold">While you were setting up…</h3>
      </div>
      <div className="mt-2.5 space-y-2">
        {briefParagraphs(brief).map((para, i) => (
          <p
            key={i}
            className="text-[13px] leading-relaxed text-muted-foreground"
          >
            {para}
          </p>
        ))}
      </div>
    </motion.div>
  )
}

/**
 * Split the first-person brief into paragraphs on blank lines. The brief is
 * "markdown-ish" free text; we render it as plain paragraphs rather than
 * introducing a markdown renderer (no new deps) — the agent is instructed to
 * write short warm prose, not headings/tables.
 *
 * Exported for reuse by any surface that needs to render the wizard's brief
 * prose identically (the conversational-onboarding home chat renders the brief
 * as markdown, so it doesn't need this — but the wizard's own card does).
 */
export function briefParagraphs(brief: string): string[] {
  return brief
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
}

// Re-export the activity type for consumers that render their own lists.
export type { ResearchActivity }
