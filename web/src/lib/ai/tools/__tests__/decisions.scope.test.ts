/**
 * Regression: create_decision must verify the capture (and any project) belongs
 * to the active workspace BEFORE inserting (mirrors list_decisions /
 * confirm_decision). These tools run under service-role clients that bypass RLS,
 * so this app-layer check is the only real gate.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createDecisionTools } from '../decisions'

vi.mock('@/lib/ai/emit-decision-claim', () => ({
  emitDecisionClaim: vi.fn(async () => {}),
}))

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * Supabase double.
 *   from('captures') → visibility lookup: maybeSingle() returns the capture's
 *     visibility row only when (id, workspace_id) match a known capture. Every
 *     known capture here is the caller's own private one.
 *   from('projects') → workspace lookup: single() returns a row only when
 *     (id, workspace_id) is owned.
 *   from('member')  → resolveMember: single() returns m-1.
 *   from('decision') → insert().select().single() returns a stub decision.
 */
function makeSupabase(opts: { captures: Set<string>; projects?: Set<string> }) {
  const decisionInsert = vi.fn()
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {
      maybeSingle: async () => {
        if (table === 'captures') {
          const ok = filters['workspace_id'] === WORKSPACE_ID && opts.captures.has(filters['id'] as string)
          return {
            data: ok ? { workspace_id: WORKSPACE_ID, visibility: 'private', user_id: USER_ID, is_eval: false } : null,
            error: null,
          }
        }
        return { data: null, error: null }
      },
      single: async () => {
        if (table === 'member') return { data: { id: 'm-1' }, error: null }
        if (table === 'decision') {
          return {
            data: { id: 'dec-1', capture_id: filters['capture_id'] ?? null, content: 'x', confirmation: 'suggested', created_at: 't' },
            error: null,
          }
        }
        if (table === 'projects') {
          const ok = filters['workspace_id'] === WORKSPACE_ID && opts.projects?.has(filters['id'] as string)
          return { data: ok ? { id: filters['id'] } : null, error: null }
        }
        return { data: null, error: null }
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'then' || p === 'catch' || p === 'finally') return undefined
        if (p === 'eq') return (col: string, val: unknown) => ((filters[col] = val), proxy)
        if (p === 'insert')
          return (row: Record<string, unknown>) => {
            if (table === 'decision') {
              decisionInsert(row)
              filters['capture_id'] = row['capture_id']
            }
            return proxy
          }
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, decisionInsert }
}

describe('create_decision — workspace scoping', () => {
  it('rejects a capture_id not visible to the user and does not insert', async () => {
    const { supabase, decisionInsert } = makeSupabase({ captures: new Set() })
    const tool = createDecisionTools(USER_ID, supabase, WORKSPACE_ID).create_decision
    const res = (await tool.execute!(
      { capture_id: 'foreign-cap', content: 'we ship friday' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/capture not found/i)
    expect(decisionInsert).not.toHaveBeenCalled()
  })

  it('rejects a project_id not in the workspace even when the capture is owned', async () => {
    const { supabase, decisionInsert } = makeSupabase({ captures: new Set(['cap-1']), projects: new Set() })
    const tool = createDecisionTools(USER_ID, supabase, WORKSPACE_ID).create_decision
    const res = (await tool.execute!(
      { capture_id: 'cap-1', content: 'x', project_id: 'foreign-proj' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/project not found/i)
    expect(decisionInsert).not.toHaveBeenCalled()
  })

  it('inserts when the capture (and project) belong to the workspace', async () => {
    const { supabase, decisionInsert } = makeSupabase({
      captures: new Set(['cap-1']),
      projects: new Set(['proj-1']),
    })
    const tool = createDecisionTools(USER_ID, supabase, WORKSPACE_ID).create_decision
    const res = (await tool.execute!(
      { capture_id: 'cap-1', content: 'x', project_id: 'proj-1' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean }
    expect(res.success).toBe(true)
    expect(decisionInsert).toHaveBeenCalledTimes(1)
  })
})
