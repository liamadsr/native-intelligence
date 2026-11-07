/**
 * The work producer (A6 slice 1): a work item's move into needs_input,
 * needs_review, done or failed becomes one agent_event for its owner, written
 * by the recorder beside its agent-log line (recorder.ts `logMove`), with the
 * log's filter (no quiet row, delegated child or housekeeping kind) and the
 * log's instant. One hook covers work runs, flows, routines and failures: they
 * all go through the recorder.
 *
 * The daily email-drafts pass speaks only through its failure here: its
 * drafts reach the inbox one by one through the mail seam (./email.ts), so its
 * "finished" or "ready for review" would count them twice.
 *
 * A finish (work.done, priority 0) collapses to one row per item per local
 * day (the owner's member.time_zone, else UTC): a routine keyed on its flow,
 * since each fire is its own work item. The others keep one row per move.
 *
 * The recorder already notifies on needs_input, needs_review and failed
 * (work/notify.ts); the event says so (`facts.notified`), and the router
 * records that notice instead of sending another.
 */
import type { WorkLogEvent } from '@/lib/log/agent-log'
import { WORK_KINDS } from '@/lib/work/types'
import type { AgentEventInput } from './record'
import { agentEventKey, type AgentEventKind } from './types'

export interface WorkEventTarget {
  workItemId: string
  workspaceId: string
  userId: string
  title: string | null
  area?: string | null
  /** tracked_job.kind. */
  kind: string | null
  /** The routine a flow run fired from (tracked_job's flow id): its finishes collapse per day. */
  flowId?: string | null
}

/** The local date (YYYY-MM-DD) of an instant in a zone, UTC when the zone is missing or refused. Pure. */
export function localDateOf(atIso: string, timeZone: string | null | undefined): string {
  const ms = Number.isFinite(Date.parse(atIso)) ? Date.parse(atIso) : Date.now()
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
      const date = `${get('year')}-${get('month')}-${get('day')}`
      if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return date
    } catch {
      // A zone Intl refuses: UTC.
    }
  }
  return new Date(ms).toISOString().slice(0, 10)
}

const KIND_FOR: Partial<Record<WorkLogEvent['type'], { kind: AgentEventKind; status: string; priority: number }>> = {
  work_needs_input: { kind: 'work.needs_input', status: 'needs_input', priority: 2 },
  work_needs_review: { kind: 'work.needs_review', status: 'needs_review', priority: 1 },
  work_done: { kind: 'work.done', status: 'done', priority: 0 },
  work_failed: { kind: 'work.failed', status: 'failed', priority: 2 },
}

/**
 * The event a work move is, or null for a move the inbox leaves out (started,
 * canceled, a review settled). `notified`: the recorder sent this move's
 * notice. Pure.
 */
export function workAgentEvent(
  target: WorkEventTarget,
  event: WorkLogEvent,
  opts: { notified: boolean; timeZone?: string | null; toldHome?: boolean },
): AgentEventInput | null {
  const spec = KIND_FOR[event.type]
  if (!spec || !target.workItemId || !target.workspaceId || !target.userId) return null
  if (target.kind === WORK_KINDS.emailDrafts && spec.kind !== 'work.failed') return null
  return {
    workspaceId: target.workspaceId,
    userId: target.userId,
    kind: spec.kind,
    priority: spec.priority,
    occursAt: event.at,
    refType: 'work_item',
    refId: target.workItemId,
    facts: {
      title: target.title ?? 'Untitled work',
      ...(target.kind ? { workKind: target.kind } : {}),
      ...(target.area ? { area: target.area } : {}),
      notified: opts.notified && spec.kind !== 'work.done',
      ...(opts.toldHome && spec.kind === 'work.failed' ? { toldHome: true } : {}),
    },
    dedupeKey:
      spec.kind === 'work.done'
        ? agentEventKey.workDone(target.flowId ? `flow:${target.flowId}` : target.workItemId, localDateOf(event.at, opts.timeZone))
        : agentEventKey.work(target.workItemId, spec.status, event.at),
  }
}
