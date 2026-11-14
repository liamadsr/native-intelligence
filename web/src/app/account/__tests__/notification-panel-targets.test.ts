/**
 * Notification targets that used to be dead ends.
 *
 * `resolveNotificationDetailPanel` had no case for the two loop-engine targets
 * (`flow_run` for a verdict digest, `flow` for a failed-run notice), so those
 * clicks resolved to null and did nothing. This pins the mapping each of them
 * resolves to now:
 *
 *   - `flow`      → open the flow editor
 *   - `flow_run`  → open the flow editor ON that run (flow id from the row's
 *                   context, else looked up through the run's own route — in
 *                   the notification's workspace, like the share branch)
 *   - `cycle`     → open the team's board (a sprint that started; the team id
 *                   rides in the row's metadata)
 *
 * `email_drafts_ready` and `feedback_requested` are dead types (nothing writes
 * them since the notifications page went: docs/plans/retire-notifications-page.md),
 * so neither resolves to anything any more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveNotificationDetailPanel } from '../notification-panel'

const calls: { url: string; init?: RequestInit }[] = []

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init })
  return {
    ok: true,
    json: async () => ({ run: { id: 'run-9', flow_id: 'flow-1', flow_name: 'Triage' } }),
  } as unknown as Response
})

/** A verdict digest as the inbox holds it: targets the RUN, no context. */
function digest(over: Record<string, unknown> = {}) {
  return {
    type: 'flow_run_output',
    target_type: 'flow_run',
    target_id: 'run-9',
    context_type: null,
    context_id: null,
    title: 'Triage: 2 need you',
    body: '2 to review',
    metadata: {},
    workspace_id: 'ws-1',
    ...over,
  }
}

function sentWorkspaceHeader(): string | null {
  const headers = calls[0]?.init?.headers as Record<string, string> | undefined
  return headers?.['x-workspace-id'] ?? null
}

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('resolveNotificationDetailPanel — flow targets', () => {
  it('a failed-run notice (target flow) opens the flow editor, no lookup', async () => {
    const dp = await resolveNotificationDetailPanel(
      digest({ target_type: 'flow', target_id: 'flow-1', title: "Triage couldn't run", body: 'timed out' }),
    )
    expect(dp).toEqual({ type: 'flow', id: 'flow-1', title: 'timed out' })
    expect(calls).toHaveLength(0)
  })

  it('a verdict digest carrying flow context lands on the run without a lookup', async () => {
    const dp = await resolveNotificationDetailPanel(digest({ context_type: 'flow', context_id: 'flow-1' }))
    expect(dp).toEqual({ type: 'flow', id: 'flow-1', title: '2 to review', runId: 'run-9' })
    expect(calls).toHaveLength(0)
  })

  it('a legacy digest (no context) asks the run route, in the notification workspace', async () => {
    const dp = await resolveNotificationDetailPanel(digest({ workspace_id: 'ws-b' }))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/account/flows/runs/run-9')
    expect(sentWorkspaceHeader()).toBe('ws-b')
    expect(dp).toEqual({ type: 'flow', id: 'flow-1', title: '2 to review', runId: 'run-9' })
  })

  it('sends NO header when the caller holds no workspace id — the interceptor decides', async () => {
    for (const row of [digest({ workspace_id: undefined }), digest({ workspace_id: null })]) {
      calls.length = 0
      await resolveNotificationDetailPanel(row)
      expect(calls).toHaveLength(1)
      expect(calls[0].init?.headers).toBeUndefined()
    }
  })

  it('is unresolvable (null) when the run lookup 404s, errors, or returns no flow', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response)
    await expect(resolveNotificationDetailPanel(digest())).resolves.toBeNull()

    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network')
    })
    await expect(resolveNotificationDetailPanel(digest())).resolves.toBeNull()

    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ run: {} }) }) as unknown as Response)
    await expect(resolveNotificationDetailPanel(digest())).resolves.toBeNull()
  })
})

describe('resolveNotificationDetailPanel — a sprint that started', () => {
  it('a cycle target opens its team’s board (team id from the metadata)', async () => {
    const dp = await resolveNotificationDetailPanel(
      digest({ type: 'cycle_started', target_type: 'cycle', target_id: 'cyc-1', title: 'Sprint 4 started', metadata: { team_id: 'team-eng' } }),
    )
    expect(dp).toEqual({ type: 'team_board', id: 'team-eng', title: 'Sprint 4 started' })
    expect(calls).toHaveLength(0)
  })

  it('an older cycle row without a team id opens nothing particular (null)', async () => {
    const dp = await resolveNotificationDetailPanel(
      digest({ type: 'cycle_started', target_type: 'cycle', target_id: 'cyc-1' }),
    )
    expect(dp).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('resolveNotificationDetailPanel — dead types', () => {
  it('"N drafts ready" (no target) and a feedback request no longer resolve', async () => {
    expect(
      await resolveNotificationDetailPanel(
        digest({ type: 'email_drafts_ready', target_type: null, target_id: null, title: '3 email drafts ready for review', body: null, metadata: { draft_count: 3 } }),
      ),
    ).toBeNull()
    expect(
      await resolveNotificationDetailPanel(
        digest({ type: 'feedback_requested', target_type: null, target_id: null, metadata: { message_id: 'msg-1' } }),
      ),
    ).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('resolveNotificationDetailPanel — the work ledger (migration 273 targets)', () => {
  it('a work_needs_you / work_failed push opens the work item panel, titled by the notification', async () => {
    const dp = await resolveNotificationDetailPanel(
      digest({ type: 'work_needs_you', target_type: 'work_item', target_id: 'job-1', title: 'Reply drafts — ready to review', body: 'Review 2 drafts' }),
    )
    expect(dp).toEqual({ type: 'work_item', id: 'job-1', title: 'Reply drafts — ready to review' })
    expect(calls).toHaveLength(0)
  })

  it('a retargeted verdict digest (flow_run_output → work_item) opens the item too', async () => {
    const dp = await resolveNotificationDetailPanel(digest({ target_type: 'work_item', target_id: 'job-2' }))
    expect(dp).toEqual({ type: 'work_item', id: 'job-2', title: 'Triage: 2 need you' })
  })

  it('an email_draft target opens Mail on Drafts; a sequence target opens the sequence', async () => {
    expect(await resolveNotificationDetailPanel(digest({ target_type: 'email_draft', target_id: 'd1', title: 'Draft ready' }))).toEqual({
      type: 'mail',
      id: 'drafts',
      title: 'Draft ready',
    })
    expect(
      await resolveNotificationDetailPanel(digest({ target_type: 'sequence', target_id: 'seq-1', title: 'Outreach paused', body: 'mailbox gone' })),
    ).toEqual({ type: 'sequence', id: 'seq-1', title: 'Outreach paused' })
  })

  it('a scheduled email that wasn’t sent opens Mail on Scheduled, where its reason shows', async () => {
    expect(
      await resolveNotificationDetailPanel(digest({ type: 'email_send_failed', target_type: 'email_draft', target_id: 'sched-1', title: 'A scheduled email wasn’t sent' })),
    ).toEqual({ type: 'mail', id: 'scheduled', title: 'A scheduled email wasn’t sent' })
  })
})
