/**
 * A Dreamer run is never shown to the person (docs/plans/dreamer.md "Nothing
 * the person can see"): its ledger row is born muted and silent, it writes no
 * teammate report in ANY status (done, a question, a failure, a cancel), asks
 * for no home turn, sends no push, never lands in the review pile (it settles
 * `done` with a deliverable), and its row's title names it. Its findings reach
 * the parent through its own report (notify_parent), tested beside its tools.
 * Against the stateful fake, as chat-report.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}), send: vi.fn(async () => ({ ids: [] })) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

import { ensureWorkForAgentRun, mirrorAgentRunStatus, resetAgentRunMirrorCaches, DREAMER_WORK_TITLE } from '../agent-run-mirror'
import { DREAMER_ROLE } from '@/lib/dreamer/prompt'

function seeded(): FakeSupabase {
  const fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  fake.seed('chat_conversations', [{ id: 'home-1', user_id: 'u1', workspace_id: 'w1', is_home: true }])
  fake.seed('agent_run', [{ id: 'run-d', workspace_id: 'w1', server_helper: 'dreamer', triggered_by: 'u1' }])
  return fake
}

const RUN = {
  id: 'run-d',
  workspace_id: 'w1',
  kind: 'workspace',
  status: 'queued',
  triggered_by: 'u1',
  task_prompt: `${DREAMER_ROLE}\n\n---\n\n# This run`,
  origin: 'chat' as const,
  ai_team_member_id: null,
  chat_conversation_id: 'home-1',
  server_helper: 'dreamer',
}

beforeEach(() => {
  hoisted.createNotification.mockClear()
  hoisted.send.mockClear()
  resetAgentRunMirrorCaches()
})

describe('a Dreamer run is silent', () => {
  it('its row is born muted, marked, and named for what it is', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, RUN)
    const row = fake.rows('tracked_job')[0] as { title: string; source: Record<string, unknown> }
    expect(row.title).toBe(DREAMER_WORK_TITLE)
    expect(row.source).toMatchObject({ agent_run_id: 'run-d', quiet: true, server_helper: 'dreamer' })
  })

  it('settles done with a deliverable (never the review pile) and writes no report', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, RUN)
    await mirrorAgentRunStatus(fake as never, { agentRunId: 'run-d', workspaceId: 'w1' }, { status: 'completed', summary: 'Checked mail and calendar', deliverables: [{ type: 'document', id: 'doc-x', label: 'Notes' }] })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'done', needs: null })
    expect(fake.rows('chat_messages')).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('writes no report for a question, a failure or a cancel either', async () => {
    for (const transition of [
      { status: 'needs_input' as const, questions: [{ id: 'q1', question: 'Which inbox?' }] },
      { status: 'failed' as const, error: 'Gateway timed out' },
      { status: 'canceled' as const, reason: 'Stopped' },
    ]) {
      resetAgentRunMirrorCaches()
      const fake = seeded()
      await ensureWorkForAgentRun(fake as never, RUN)
      await mirrorAgentRunStatus(fake as never, { agentRunId: 'run-d', workspaceId: 'w1' }, transition)
      expect(fake.rows('chat_messages'), transition.status).toHaveLength(0)
      expect(hoisted.createNotification, transition.status).not.toHaveBeenCalled()
    }
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('any other server helper still reports as before (a meeting prep finishes done and reports)', async () => {
    const fake = seeded()
    fake.seed('agent_run', [{ id: 'run-p', workspace_id: 'w1', server_helper: 'meeting_prep', triggered_by: 'u1' }])
    fake.seed('ai_team_member', [])
    await ensureWorkForAgentRun(fake as never, { ...RUN, id: 'run-p', server_helper: 'meeting_prep', task_prompt: 'Prepare the person for their meeting.' })
    await mirrorAgentRunStatus(fake as never, { agentRunId: 'run-p', workspaceId: 'w1' }, { status: 'completed', summary: 'Prep ready', deliverables: [{ type: 'document', id: 'doc-p', label: 'Prep' }] })
    expect((fake.rows('tracked_job') as Array<{ title: string }>).map((r) => r.title)).toEqual(['Prepare the person for their meeting.'])
    expect(fake.rows('chat_messages')).toHaveLength(1)
  })
})
