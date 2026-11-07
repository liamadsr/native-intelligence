/**
 * Where a deliverable opens (ACTIVITY-AND-REVIEW-DESIGN §4.3).
 *
 * `deliverableTarget` is pure: a deliverable (plus what the item route resolved
 * for it) → one target, unit-tested per type. `openDeliverable` opens it: a
 * card in the chat for anything that is a page (lib/chat-cards/open-card.ts,
 * in the item's own workspace), the desktop-safe external opener for a link.
 * The real verb (Send, Merge, Accept) lives on the deliverable's own surface
 * (NORTH-STAR invariant 5); this is only the way there.
 */
import { fetchFlowIdForRun } from '@/app/account/notification-panel'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { isOpenableUrl, openExternalUrl } from '@/lib/open-external'
import type { WorkDeliverable } from './types'

export type DeliverableTarget =
  | { kind: 'card'; target: OpenTarget }
  | { kind: 'url'; url: string }
  | { kind: 'flow_run'; runId: string }
  | { kind: 'none'; reason: string }

/** What GET /api/account/activity/[id] resolved for the item's deliverables. */
export interface DeliverableContext {
  /** email_draft id → the thread it belongs to and the folder that lists it. */
  drafts?: Record<string, { provider_thread_id: string | null; provider_draft_id?: string | null; folder: string | null }>
  /** The item the deliverable belongs to. Cards open there: the item panel
   *  shows them inline, with their status and verbs (§4.2). */
  itemId?: string
}

export function deliverableTarget(d: WorkDeliverable, ctx: DeliverableContext = {}): DeliverableTarget {
  switch (d.type) {
    case 'document':
    case 'action':
    case 'capture':
    case 'contact':
    case 'company':
      return { kind: 'card', target: { type: d.type, id: d.id, title: d.label } }
    case 'prospect_list':
      return { kind: 'card', target: { type: 'prospect_list', id: d.id, title: d.label || 'Prospect list' } }
    case 'pr':
    case 'url':
      return isOpenableUrl(d.id) ? { kind: 'url', url: d.id } : { kind: 'none', reason: 'Not a link that can be opened' }
    case 'email_draft': {
      const where = ctx.drafts?.[d.id]
      // Its thread, opened on the draft itself (the thread view's draft message), not the thread's top.
      return {
        kind: 'card',
        target: { type: 'mail', folder: where?.folder || 'drafts', threadId: where?.provider_thread_id ?? null, draftId: where?.provider_draft_id ?? null },
      }
    }
    case 'attention_cards':
      // The cards live on the item, not in the flow's run history: the panel
      // renders each card with what it proposes and where it stands. Without
      // an item to open, fall back to the run that surfaced them.
      if (ctx.itemId) return { kind: 'card', target: { type: 'work_item', id: ctx.itemId, title: d.label } }
      return { kind: 'flow_run', runId: d.id }
    case 'flow_run':
      return { kind: 'flow_run', runId: d.id }
  }
}

/**
 * What opening `d` needs beyond its ref. Only a draft needs the item route's
 * answer (which thread, which folder), so only a draft costs a read; every
 * other type opens from the ref alone, its cards on the item itself. A failed
 * read opens the drafts folder.
 */
export async function deliverableContextFor(
  workId: string,
  d: Pick<WorkDeliverable, 'type'>,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverableContext> {
  if (d.type !== 'email_draft') return { itemId: workId }
  try {
    const res = await fetchImpl(`/api/account/activity/${workId}`, { cache: 'no-store' })
    if (!res.ok) return { itemId: workId }
    const data = (await res.json()) as { drafts?: DeliverableContext['drafts'] }
    return { drafts: data.drafts, itemId: workId }
  } catch {
    return { itemId: workId }
  }
}

export interface DeliverableNav {
  /** The item's workspace: where a run lookup is asked. */
  workspaceId: string
  /** The item's workspace when it is NOT the one on screen; null otherwise. */
  foreignWorkspaceId: string | null
}

/** Open a deliverable. Returns false when nothing could be opened. */
export async function openDeliverable(
  d: WorkDeliverable,
  ctx: DeliverableContext,
  nav: DeliverableNav,
): Promise<boolean> {
  const target = deliverableTarget(d, ctx)
  switch (target.kind) {
    case 'card':
      return openTarget(target.target, { from: 'work-item', workspaceId: nav.foreignWorkspaceId })
    case 'url':
      await openExternalUrl(target.url)
      return true
    case 'flow_run': {
      const flowId = await fetchFlowIdForRun(target.runId, nav.workspaceId)
      if (!flowId) return false
      return openTarget({ type: 'flow', id: flowId, title: d.label, runId: target.runId }, { from: 'work-item', workspaceId: nav.foreignWorkspaceId })
    }
    case 'none':
      return false
  }
}
