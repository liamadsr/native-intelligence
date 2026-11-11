'use client'

// Navigation helper — resolves a notification to what a click opens. Used by
// the desktop native-banner handler (the inbox that also used it went with the
// notifications page: docs/plans/retire-notifications-page.md).
// Async because two targets need a fetch: a share whose context is missing, and
// a legacy `flow_run` row that predates the flow context stamp.

/**
 * What a notification opens. Most targets are a record (`type`/`id`/`title`,
 * opened as its card). The others are pages, which the click surfaces route
 * through `openNotificationTarget` (notification-open.ts) too:
 *   - `type: 'flow'` — open the flow editor for flow `id`; `runId` lands it on
 *     that run's row in Run history (a verdict digest, a failed run).
 *   - `type: 'mail'` — open the Mail view on folder `id` (`'drafts'` for
 *     "N email drafts ready for review").
 *   - `type: 'sequence'` — open the sequence page for sequence `id`.
 *   - `type: 'team_board'` — open team `id`'s board (a sprint that started).
 * `work_item` (a work-ledger item, ACTIVITY-AND-REVIEW-DESIGN §4.5) IS a
 * panel — the one detail panel for any background run.
 */
export interface NotificationTarget {
  type: string
  id: string
  title: string
  section?: 'cloud'
  runId?: string | null
}

export async function resolveNotificationDetailPanel(
  notification: {
    type?: string
    metadata?: Record<string, unknown>
    target_type: string | null
    target_id: string | null
    context_type: string | null
    context_id: string | null
    title: string
    body: string | null
    /** The workspace the notification belongs to, when the caller knows it.
     *  Optional because the two callers disagree on how much they hold: the
     *  in-app inbox row always has it, while a native banner payload from an
     *  older desktop binary may not. Used for the two branches that fetch —
     *  `share` and a legacy `flow_run` — so a foreign row is looked up in ITS
     *  workspace. */
    workspace_id?: string | null
  },
): Promise<NotificationTarget | null> {
  let targetType = notification.target_type
  let targetId = notification.target_id
  const title = notification.body || notification.title || ''

  // A work-run notification (Loops v3: work_run_ready / work_run_input) targets an
  // agent_run but ships context_type='action' + context_id=<actionId> so it opens
  // the ACTION side panel on its Cloud-run view — the canonical run surface — via
  // the same context-swap the comment/share paths use. `section:'cloud'` deep-links
  // straight to the run. Agent_run rows WITHOUT this context (old rows, flow-origin
  // coding runs) are handled by the caller's standalone-page fallback, not here.
  if (targetType === 'agent_run' && notification.context_type === 'action' && notification.context_id) {
    return { type: 'action', id: notification.context_id, title, section: 'cloud' }
  }

  // For comments/decisions, resolve to the parent entity
  if ((targetType === 'comment' || targetType === 'decision') && notification.context_type && notification.context_id) {
    targetType = notification.context_type
    targetId = notification.context_id
  }

  // For shares, the target_id is the share record, not the underlying entity.
  // Resolve via context fields first, otherwise fetch the share record.
  if (targetType === 'share' && targetId) {
    if (notification.context_type && notification.context_id) {
      targetType = notification.context_type
      targetId = notification.context_id
    } else {
      try {
        // A FOREIGN share has to be asked for in its own workspace. The share
        // route scopes its lookup to the ACTIVE workspace — so resolving a
        // cross-workspace notification from the inbox would 404 and the click
        // would land nowhere.
        //
        // The header is the supported override (`WORKSPACE_HEADER`): the fetch
        // interceptor only sets `x-workspace-id` when the caller has NOT, so
        // passing it here wins, and `getCurrentWorkspaceId` verifies the caller
        // is a member of the workspace named before it trusts it. Sending a
        // workspace id the user isn't in therefore grants nothing — the lookup
        // falls back and the share stays unresolved.
        const res = await fetch(`/api/account/shares/${targetId}`, {
          headers: workspaceHeader(notification.workspace_id),
        })
        if (res.ok) {
          const data = await res.json()
          if (data.shareable_type && data.shareable_id) {
            targetType = data.shareable_type
            targetId = data.shareable_id
          }
        }
      } catch {
        // Failed to resolve — fall through
      }
    }
  }

  if (!targetType || !targetId) return null

  switch (targetType) {
    case 'action':
      return { type: 'action', id: targetId, title }
    case 'capture':
      return { type: 'capture', id: targetId, title }
    case 'document':
      return { type: 'document', id: targetId, title }
    case 'project':
      return { type: 'project', id: targetId, title }
    case 'initiative':
      return { type: 'initiative', id: targetId, title }
    case 'contact':
      return { type: 'contact', id: targetId, title }
    case 'company':
      return { type: 'company', id: targetId, title }
    // A failed-run notice ("<flow> couldn't run") targets the flow itself.
    case 'flow':
      return { type: 'flow', id: targetId, title }
    // A verdict digest ("Triage: 2 need you") targets the RUN; the editor is
    // keyed on the flow, so resolve the flow and land on the run. Rows that
    // carry context_type='flow' need no lookup; older rows are asked for.
    case 'flow_run': {
      const flowId =
        notification.context_type === 'flow' && notification.context_id
          ? notification.context_id
          : await fetchFlowIdForRun(targetId, notification.workspace_id)
      return flowId ? { type: 'flow', id: flowId, title, runId: targetId } : null
    }
    // The work ledger (work_needs_you / work_failed, and retargeted loop
    // digests): the item's own detail panel, titled by the notification.
    case 'work_item':
      return { type: 'work_item', id: targetId, title: notification.title || title }
    // A draft in Mail: the Drafts folder (the item panel opens the thread itself).
    case 'email_draft':
      return { type: 'mail', id: 'drafts', title: notification.title || title }
    // A sequence engine alert targets the sequence page.
    case 'sequence':
      return { type: 'sequence', id: targetId, title: notification.title || title }
    // A team chat message (migration 560): team chat on it, in its channel or thread.
    case 'team_chat_message':
      return { type: 'team_chat', id: targetId, title: notification.title || title }
    // A sprint that started: its team's board (the team rides in the row's
    // metadata; an older row without it opens nothing particular).
    case 'cycle': {
      const teamId = notification.metadata?.team_id
      return typeof teamId === 'string' && teamId ? { type: 'team_board', id: teamId, title: notification.title || title } : null
    }
    default:
      return null
  }
}

/** The header the two fetch branches send so a foreign notification is looked
 *  up in its own workspace; `undefined` (no headers at all) when the caller
 *  holds no workspace id, leaving the interceptor's default in charge. */
function workspaceHeader(workspaceId: string | null | undefined): Record<string, string> | undefined {
  return workspaceId ? { 'x-workspace-id': workspaceId } : undefined
}

/** Which flow a run belongs to, via the run's own route (workspace-fenced
 *  through the flow). Null on any failure — the caller then reports the click
 *  as unresolvable rather than opening the wrong thing. Shared with the work
 *  item panel's run deliverables (open-deliverable.ts). */
export async function fetchFlowIdForRun(
  runId: string,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/account/flows/runs/${runId}`, {
      headers: workspaceHeader(workspaceId),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { run?: { flow_id?: unknown } }
    const flowId = data?.run?.flow_id
    return typeof flowId === 'string' && flowId ? flowId : null
  } catch {
    return null
  }
}
