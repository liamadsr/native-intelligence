/**
 * The P7 verification's remaining fixes, pinned:
 *   B1  a skill run given connections leaves only a length on flow_run, and a
 *       call_tool's schema failure names the field, never the value;
 *   R2  a skill run's outside reads are noted durably and read back, failing closed;
 *       the run token carries runId and readOutsideBefore, shape-checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('use the injected client') } }))

import { skillRunPreview } from '../run-skill'
import { noteRunReadOutside, runHasReadOutside, skillRunOutsideReads } from '../skill-run-reads'
import { mintRunToken, verifyRunToken } from '../skill-run-token'
import { createCallToolExecutor } from '../call-tool'
import type { FlowAction, TriggerContext } from '../types'

let db: FakeSupabase
const RUN = '11111111-2222-4333-8444-555555555555'
beforeEach(() => {
  db = makeFakeSupabase()
  process.env.RUN_SKILL_INTERNAL_SECRET = 'verification-secret'
})

describe('B1 remainder', () => {
  it('a skill run with connections shows only how much it wrote; any other keeps its preview', () => {
    expect(skillRunPreview({ connections: ['c'] }, 'Acme: $48k renewal')).toBe("Wrote 18 chars; it used your connected apps, so its text isn't shown in the run history")
    expect(skillRunPreview({}, 'A summary')).toBe('A summary')
  })

  it('a call_tool\'s schema failure names the field, never the rendered value', async () => {
    db.seed('connected_mcp_server', [{
      id: 'aaaaaaaa-0000-4000-8000-000000000002', user_id: 'owner', display_name: 'Notion', server_url: 'https://mcp.notion.com/mcp', is_enabled: true,
      disabled_tools: [], allowed_tools: null, require_approval_tools: [], approval_free_tools: [],
      tools_cache: [{ name: 'append', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['a', 'b'] } }, required: ['kind'] } }],
    }])
    const trigger: TriggerContext = { type: 'schedule', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-21T00:00:00Z' }
    const action = { id: 'x', type: 'call_tool', config: { connection: 'aaaaaaaa-0000-4000-8000-000000000002', tool: 'append', input: { kind: '{{steps.s.output}}' } }, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null } as FlowAction
    const r = await createCallToolExecutor({ workspaceId: 'ws', runAsUserId: 'owner', flowId: 'f', flowRunId: 'r', supabase: db as never, paused: async () => false })(action, {
      entity: null, trigger, appBaseUrl: 'https://nativeintelligence.dev', steps: { s: { output: 'Acme secret' } },
    })
    expect(r.status).toBe('failed')
    expect(r.error_message).toBe("The input doesn't match append's inputs (at kind)")
  })
})

describe('R2: a skill run\'s outside reads', () => {
  it('reads back what was noted; fails closed with no run id; an earlier step\'s flag counts', async () => {
    expect(await runHasReadOutside(db as never, { runId: RUN })).toBe(false)
    await noteRunReadOutside(db as never, { runId: RUN, workspaceId: 'ws', tool: 'web_search' })
    await noteRunReadOutside(db as never, { runId: RUN, workspaceId: 'ws', tool: 'mcp__x__y' })
    expect(db.rows('skill_run_read')).toHaveLength(1)
    expect(await runHasReadOutside(db as never, { runId: RUN })).toBe(true)
    expect(await runHasReadOutside(db as never, {})).toBe(true)
    expect(await runHasReadOutside(db as never, { runId: '99999999-2222-4333-8444-555555555555', readOutsideBefore: true })).toBe(true)
  })

  it("a canon edit's label reads the record, and once more when a note is still in flight (P12 review nit)", async () => {
    const RUN2 = '99999999-3333-4333-8444-555555555555'
    expect(await skillRunOutsideReads(db as never, { runId: RUN2 }, 1)).toEqual({ read: false, tools: [] })
    // The stream's note lands while the edit waits for its second read.
    const pending = skillRunOutsideReads(db as never, { runId: RUN2 }, 30)
    await noteRunReadOutside(db as never, { runId: RUN2, workspaceId: 'ws', tool: 'web_fetch' })
    expect(await pending).toEqual({ read: true, tools: ['web_fetch'] })
    expect(await skillRunOutsideReads(db as never, {}, 1)).toEqual({ read: true, tools: [] })
    expect(await skillRunOutsideReads(db as never, { runId: '99999999-4444-4333-8444-555555555555', readOutsideBefore: true }, 1)).toEqual({ read: true, tools: [] })
  })

  it('the token carries runId and readOutsideBefore, shape-checked', () => {
    const base = { workspaceId: 'ws', runAsUserId: 'u', skillId: 's', mode: 'act' as const, hasCapture: false, outputContract: 'prose' as const, model: 'm' }
    expect(verifyRunToken(mintRunToken({ ...base, runId: RUN, readOutsideBefore: true }))).toMatchObject({ runId: RUN, readOutsideBefore: true })
    expect(verifyRunToken(mintRunToken({ ...base, runId: 'nope' }))).toBeNull()
    expect(verifyRunToken(mintRunToken({ ...base, readOutsideBefore: 'yes' as never }))).toBeNull()
  })
})
