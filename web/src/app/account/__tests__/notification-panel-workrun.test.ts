import { describe, it, expect } from 'vitest'
import { resolveNotificationDetailPanel } from '../notification-panel'

/**
 * Loops v3 interactive-work rework: a work-run notification (work_run_ready /
 * work_run_input) targets an agent_run but ships context_type='action' +
 * context_id so it opens the ACTION detail panel on its Cloud-run view
 * (section:'cloud') — the canonical run surface — rather than the standalone run
 * page. resolveNotificationDetailPanel owns that swap; the standalone-page
 * fallback (in tab-content) is preserved only for context-less agent_run rows.
 */

function notif(over: Partial<Parameters<typeof resolveNotificationDetailPanel>[0]> = {}) {
  return {
    type: 'work_run_ready',
    target_type: 'agent_run',
    target_id: 'run-1',
    context_type: null,
    context_id: null,
    title: 'Draft the follow-up',
    body: 'Ready for review',
    metadata: {},
    ...over,
  }
}

describe('resolveNotificationDetailPanel — work-run agent_run rows', () => {
  it('opens the action panel on its Cloud-run view when the row carries an action context', async () => {
    const dp = await resolveNotificationDetailPanel(
      notif({ context_type: 'action', context_id: 'action-9' }),
    )
    expect(dp).toEqual({ type: 'action', id: 'action-9', title: 'Ready for review', section: 'cloud' })
  })

  it('uses the body as the panel title, falling back to the notification title', async () => {
    const dp = await resolveNotificationDetailPanel(
      notif({ context_type: 'action', context_id: 'action-9', body: null }),
    )
    expect(dp?.title).toBe('Draft the follow-up')
  })

  it('does NOT resolve a context-less agent_run row (the caller falls back to the standalone page)', async () => {
    const dp = await resolveNotificationDetailPanel(notif({ context_type: null, context_id: null }))
    // No action to open — the agent_run target isn't a detail-panel entity, so
    // resolve returns null and tab-content routes to /account/agent-runs/[id].
    expect(dp).toBeNull()
  })

  it('does NOT hijack an agent_run row whose context is some other entity type', async () => {
    const dp = await resolveNotificationDetailPanel(
      notif({ context_type: 'capture', context_id: 'cap-1' }),
    )
    // Only context_type='action' routes to the Cloud-run view. A non-action
    // context on an agent_run target isn't a supported detail panel → null.
    expect(dp).toBeNull()
  })

  it('still resolves ordinary action notifications unchanged (no section)', async () => {
    const dp = await resolveNotificationDetailPanel(
      notif({ type: 'action_assigned', target_type: 'action', target_id: 'action-3', body: 'Assigned' }),
    )
    expect(dp).toEqual({ type: 'action', id: 'action-3', title: 'Assigned' })
    expect(dp).not.toHaveProperty('section')
  })
})
