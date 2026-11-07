'use client'

/**
 * RunQuestionSection — the mid-run "needs your input" surface for a parked work
 * run (Loops v3 interactive work runs, INTERACTIVE-WORK-RUNS-DESIGN.md §"UI
 * contracts"). Shown when a run is `status='needs_input'`: it renders the SAME
 * QuestionPicker the chat uses, from `run.pending_input.questions`, and on
 * submit/skip POSTs to the respond route (W2-owned) which CAS's the run
 * needs_input→queued and emits the resume. The optimistic `queued` flip is
 * reported up so the host can stop showing the picker immediately (the drill-in's
 * poll/realtime then shows queued→running).
 *
 * Mounted in BOTH run surfaces (the Activity drill-in and the standalone
 * /account/agent-runs/[id] page) so the two never diverge.
 */

import { useCallback, useState } from 'react'
import { CircleAlert, MessageCircleQuestion, Users } from 'lucide-react'
import { QuestionPicker } from '@/app/account/(dashboard)/chat/question-picker'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'
import { isDelegationPark, type AskUserAnswer, type DelegationPark, type PendingInput } from '@/lib/agent-run/types'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'

export interface RunQuestionSectionProps {
  runId: string
  /** A question park, or a delegation park (the run is waiting on teammates it
   *  handed work to — shown as a line, never a picker: nobody answers it). */
  pendingInput: PendingInput | DelegationPark
  /**
   * Fired once the respond POST succeeds — the host flips its local run status to
   * `queued` (optimistic) so the picker unmounts and the "queued → running"
   * poll/realtime takes over. Not called on failure (the picker stays, error shown).
   */
  onResumed?: () => void
  /** The picker takes focus as it mounts (QuestionPicker `autoFocus`; the default). */
  autoFocus?: boolean
}

/** The QuestionPicker takes AgentQuestion[]; a WorkRunQuestion is structurally
 *  identical (question/header/options/multiSelect), so this is a safe widening. */
function toAgentQuestions(pending: PendingInput): AgentQuestion[] {
  return (pending.questions ?? []).map((q) => ({
    question: q.question,
    header: q.header,
    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    multiSelect: q.multiSelect,
  }))
}

/**
 * Map the QuestionPicker's answers map (question text → chosen label(s), joined
 * by ", ") into the AskUserAnswer[] the respond route (W2) consumes. The picker
 * already renders each question's selection — multi-select labels + any "Other"
 * free text — as a single joined string, which is exactly the `answer` shape the
 * resume driver formats into the follow-up message. One entry PER question in
 * pending order so an unanswered question still carries its (empty) slot.
 */
function buildAnswers(
  pending: PendingInput,
  answers: Record<string, string>,
): AskUserAnswer[] {
  return (pending.questions ?? []).map((q) => ({
    question: q.question,
    answer: answers[q.question] ?? '',
  }))
}

export function RunQuestionSection({ runId, pendingInput, onResumed, autoFocus }: RunQuestionSectionProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const post = useCallback(
    async (body: { answers: AskUserAnswer[] } | { skipped: true }) => {
      setSubmitting(true)
      setError(null)
      try {
        const res = await fetch(`/api/account/agent-runs/${runId}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(detail.error || `Failed (${res.status})`)
        }
        onResumed?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to send your answer')
      } finally {
        setSubmitting(false)
      }
    },
    [runId, onResumed],
  )

  const handleSubmit = useCallback(
    (answers: Record<string, string>) => {
      if (isDelegationPark(pendingInput)) return
      void post({ answers: buildAnswers(pendingInput, answers) })
    },
    [post, pendingInput],
  )

  const handleSkip = useCallback(() => {
    void post({ skipped: true })
  }, [post])

  if (isDelegationPark(pendingInput)) {
    const live = pendingInput.children.filter((c) => c.childRunId)
    if (live.length === 0) return null
    const label =
      live.length > 1
        ? `${live.length} teammates`
        : `the ${isWorkRole(live[0].role) ? WORK_ROLE_LABELS[live[0].role] : 'teammate'}`
    return (
      <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5 shrink-0" />
        Waiting on {label}. The run picks the work back up when they finish.
      </div>
    )
  }

  const questions = toAgentQuestions(pendingInput)
  if (questions.length === 0) return null

  return (
    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
        Needs your input
      </div>
      <QuestionPicker
        questions={questions}
        onSubmit={handleSubmit}
        onSkip={handleSkip}
        disabled={submitting}
        bare
        autoFocus={autoFocus}
      />
      {error && (
        <div role="alert" className="flex items-start gap-1.5 text-[11px] text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}
    </div>
  )
}
