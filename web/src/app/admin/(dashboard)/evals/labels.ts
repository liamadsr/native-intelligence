import type { EvalCandidateRow, EvalCandidateSource, EvalCandidateStatus } from '@/lib/evals/flywheel/types'

/** A queue row as GET /api/admin/evals/candidates returns it. */
export type AdminEvalCandidate = EvalCandidateRow & { workspace_name?: string; user_email?: string }

export const SOURCE_LABEL: Record<EvalCandidateSource, string> = {
  thumbs_down: 'Thumbs down',
  thumbs_up: 'Thumbs up',
  repeated_failure: 'Repeated failure',
  input_invalid: 'Invalid input',
  draft_rewrite: 'Draft rewrite',
  loop_failed: 'Loop failed',
  draft_dismissed: 'Draft dismissed',
}

export const SOURCE_CLASS: Record<EvalCandidateSource, string> = {
  thumbs_down: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  thumbs_up: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  repeated_failure: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  input_invalid: 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  draft_rewrite: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  loop_failed: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  draft_dismissed: 'border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-400',
}

export const STATUS_LABEL: Record<EvalCandidateStatus, string> = {
  new: 'New',
  promoted: 'Promoted',
  dismissed: 'Dismissed',
  exported: 'Exported',
}

/** The queue row's one line: what the person asked, the job, the rewrite, or the dismissal. */
export function candidateSummary(row: AdminEvalCandidate): string {
  const e = row.evidence as Partial<Record<string, unknown>>
  switch (e.kind) {
    case 'chat_turn':
      return oneLine(typeof e.request === 'string' ? e.request : '') || 'A chat turn'
    case 'loop_run':
      return oneLine([e.title, e.jobKind].find((v) => typeof v === 'string' && v) as string | undefined ?? '') || 'A background job'
    case 'draft_rewrite':
      return typeof e.similarity === 'number'
        ? `Draft rewritten: ${Math.round(e.similarity * 100)}% of its words kept`
        : 'Draft rewritten'
    case 'draft_dismissed':
      return `Draft dismissed: ${typeof e.reason === 'string' ? e.reason.replace(/_/g, ' ') : 'no reason'}${typeof e.recipientDomain === 'string' ? ` (${e.recipientDomain})` : ''}`
    default:
      return row.reason ? oneLine(row.reason) : SOURCE_LABEL[row.source] ?? row.source
  }
}

function oneLine(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
