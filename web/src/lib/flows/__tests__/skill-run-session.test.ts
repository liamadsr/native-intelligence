import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsage }))

import {
  advanceSkillRunCursor,
  parseSkillRunFacts,
  parseSkillRunSessionState,
  shouldParkSkillRun,
  swapSkillRunSession,
} from '../skill-run-session'
import { logSkillRunChatUsage, skillRunChatUsageKey } from '../skill-run-chat-usage'

describe('the parked session handle', () => {
  it('parks only a real ledger row its bot fronts', () => {
    const base = { id: 'job-1', inert: false, aiTeamMemberId: 'tm-1' }
    expect(shouldParkSkillRun(base as never)).toBe(true)
    expect(shouldParkSkillRun({ ...base, aiTeamMemberId: null } as never)).toBe(false)
    expect(shouldParkSkillRun({ ...base, inert: true } as never)).toBe(false)
    expect(shouldParkSkillRun({ ...base, id: null } as never)).toBe(false)
    expect(shouldParkSkillRun(undefined)).toBe(false)
  })

  it('reads a cursor, keeps the settle boundary at or before it, and refuses a legacy or broken one', () => {
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: 9, settleStreamIndex: 7 })).toEqual({
      sessionId: 's',
      streamIndex: 9,
      settleStreamIndex: 7,
    })
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: 9 })?.settleStreamIndex).toBe(9)
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: 3, settleStreamIndex: 8 })?.settleStreamIndex).toBe(3)
    expect(parseSkillRunSessionState({ continuationToken: 'old', sessionId: 's', streamIndex: 1 })).toBeNull()
    expect(parseSkillRunSessionState({ streamIndex: 1 })).toBeNull()
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: -1 })).toBeNull()
    expect(parseSkillRunSessionState(null)).toBeNull()
  })

  it('reads the run facts, and refuses any missing one', () => {
    const facts = { skillId: 'k', mode: 'act', hasCapture: true, outputContract: 'verdict', model: 'm', runAsUserId: 'u' }
    expect(parseSkillRunFacts(facts)).toEqual(facts)
    for (const key of ['skillId', 'mode', 'outputContract', 'model', 'runAsUserId']) {
      expect(parseSkillRunFacts({ ...facts, [key]: undefined }), key).toBeNull()
    }
    expect(parseSkillRunFacts({ ...facts, mode: 'drafting' })).toBeNull()
  })

  it('moves the cursor only forward, keeping the settle boundary, and only while the row names its session', async () => {
    const updates: unknown[] = []
    const filters: Array<[string, unknown]> = []
    const chain = { eq: (col: string, v: unknown) => (filters.push([col, v]), chain) }
    const supabase = { from: () => ({ update: (patch: unknown) => (updates.push(patch), chain) }) }
    const record = { workItemId: 'job-1', workspaceId: 'ws-1', state: { sessionId: 's', streamIndex: 9, settleStreamIndex: 7 } }
    await advanceSkillRunCursor(supabase as never, record, 9)
    await advanceSkillRunCursor(supabase as never, record, undefined)
    expect(updates).toHaveLength(0)
    await advanceSkillRunCursor(supabase as never, record, 14)
    expect(updates).toEqual([expect.objectContaining({ session_state: { sessionId: 's', streamIndex: 14, settleStreamIndex: 7 } })])
    expect(filters).toEqual([
      ['tracked_job_id', 'job-1'],
      ['workspace_id', 'ws-1'],
      ['session_state->>sessionId', 's'],
    ])
  })

  it('a reopened chat’s earlier sessions: read when well-formed, kept by an advance', async () => {
    const previous = [{ sessionId: 'old-1', startIndex: 7 }]
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: 3, settleStreamIndex: 0, previous })).toEqual({
      sessionId: 's',
      streamIndex: 3,
      settleStreamIndex: 0,
      previous,
    })
    expect(parseSkillRunSessionState({ sessionId: 's', streamIndex: 3, previous: [{ sessionId: '' }, { startIndex: 1 }] })).not.toHaveProperty('previous')
    expect(
      parseSkillRunSessionState({ sessionId: 's', streamIndex: 3, previous: Array.from({ length: 6 }, (_, i) => ({ sessionId: `p${i}`, startIndex: i })) })
        ?.previous?.map((p) => p.sessionId),
    ).toEqual(['p2', 'p3', 'p4', 'p5'])

    const updates: unknown[] = []
    const chain = { eq: () => chain }
    const supabase = { from: () => ({ update: (patch: unknown) => (updates.push(patch), chain) }) }
    await advanceSkillRunCursor(supabase as never, { workItemId: 'job-1', workspaceId: 'ws-1', state: { sessionId: 's', streamIndex: 3, settleStreamIndex: 0, previous } }, 8)
    expect(updates).toEqual([expect.objectContaining({ session_state: { sessionId: 's', streamIndex: 8, settleStreamIndex: 0, previous } })])
  })

  it('swaps the row’s session only while it names the one it swaps from', async () => {
    const calls: Array<{ patch: unknown; filters: Array<[string, unknown]> }> = []
    let rows: unknown[] = [{ tracked_job_id: 'job-1' }]
    let error: { message: string } | null = null
    const supabase = {
      from: (table: string) => {
        expect(table).toBe('tracked_job_session')
        return {
          update: (patch: unknown) => {
            const call = { patch, filters: [] as Array<[string, unknown]> }
            calls.push(call)
            const chain = {
              eq: (col: string, v: unknown) => (call.filters.push([col, v]), chain),
              select: async () => ({ data: rows, error }),
            }
            return chain
          },
        }
      },
    }
    const to = { sessionId: 'new', streamIndex: 0, settleStreamIndex: 0, previous: [{ sessionId: 'old', startIndex: 7 }] }
    const ref = { workItemId: 'job-1', workspaceId: 'ws-1' }
    expect(await swapSkillRunSession(supabase as never, ref, { from: 'old', to })).toBe(true)
    expect(calls[0].patch).toMatchObject({ session_state: to })
    expect(calls[0].filters).toEqual([
      ['tracked_job_id', 'job-1'],
      ['workspace_id', 'ws-1'],
      ['session_state->>sessionId', 'old'],
    ])
    // A put-back also pins the cursor (jsonb `->>` reads it as text).
    await swapSkillRunSession(supabase as never, ref, { from: 'new', fromStreamIndex: 0, to })
    expect(calls[1].filters).toContainEqual(['session_state->>streamIndex', '0'])
    rows = []
    expect(await swapSkillRunSession(supabase as never, ref, { from: 'old', to })).toBe(false)
    error = { message: 'down' }
    await expect(swapSkillRunSession(supabase as never, ref, { from: 'old', to })).rejects.toThrow('down')
  })
})

describe('billing a follow-up chat turn', () => {
  it('a reopened chat’s session keys its steps by that session (eve’s turn ids restart); the parked session keeps its key', () => {
    expect(skillRunChatUsageKey('job-1', 't0', 0)).toBe('skill-run-chat:job-1:t0:0')
    expect(skillRunChatUsageKey('job-1', 't0', 0, 'sess-new')).toBe('skill-run-chat:job-1:sess-new:t0:0')
  })

  it('one row per step, keyed once, feature flow_run_skill, source chat, to the run-as user', async () => {
    const events = [
      { type: 'step.started', data: { modelId: 'anthropic/claude-haiku-4-5', stepIndex: 0, turnId: 't9', sequence: 0 } },
      {
        type: 'step.completed',
        data: { finishReason: 'stop', stepIndex: 0, turnId: 't9', sequence: 1, usage: { inputTokens: 120, outputTokens: 30 } },
      },
    ]
    const n = await logSkillRunChatUsage({
      userId: 'u',
      workspaceId: 'ws-1',
      workItemId: 'job-1',
      skillId: 'k',
      teammateId: 'tm-1',
      model: 'claude-haiku-4-5',
      events: events as never,
    })
    expect(n).toBe(1)
    expect(h.logUsage).toHaveBeenCalledWith(
      'u',
      expect.objectContaining({
        feature: 'flow_run_skill',
        inputTokens: 120,
        outputTokens: 30,
        idempotencyKey: skillRunChatUsageKey('job-1', 't9', 0),
        metadata: expect.objectContaining({ source: 'chat', work_item_id: 'job-1', ai_team_member_id: 'tm-1' }),
      }),
    )
  })
})
