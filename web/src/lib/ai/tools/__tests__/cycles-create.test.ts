/**
 * Regression: create_cycle must verify the target team belongs to the ACTIVE
 * workspace before inserting. A `cycle` row has no workspace_id of its own — it
 * inherits scope from its team — and the tool wrote a model-supplied team_id
 * straight into the insert. Under the MCP server's service-role client (RLS
 * bypassed) that let a caller plant a sprint in any workspace whose team id it
 * could name. start_cycle / complete_cycle already check this; create didn't.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCycleTools } from '../cycles'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const OTHER_WORKSPACE_ID = 'ws-2'
const TEAM_ID = 'team-1'

const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const DATES = { start_date: '2026-01-01', end_date: '2026-01-15' }

/**
 * Supabase double.
 *   from('team').select('workspace_id').eq('id', …).single() → the team's real
 *     workspace, or null when `teamWorkspaceId` is null (no such team).
 *   from('cycle').insert(…) → recorded, never performed.
 */
function makeSupabase(teamWorkspaceId: string | null) {
  const cycleInsert = vi.fn()
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {
      single: async () => {
        if (table === 'team') {
          return { data: teamWorkspaceId ? { workspace_id: teamWorkspaceId } : null, error: null }
        }
        return { data: { id: 'cycle-1', name: 'Cycle 1' }, error: null }
      },
      // The membership probe the tool makes for a team OUTSIDE the active
      // workspace (see resolveTeamWorkspace in ../cycles). This double's user
      // belongs to no other workspace, so a foreign team stays 'Team not found'.
      // Cross-workspace routing has its own suite: routing.cycles.test.ts.
      maybeSingle: async () => ({ data: null, error: null }),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
        if (prop === 'insert')
          return (row: unknown) => {
            if (table === 'cycle') cycleInsert(row)
            return proxy
          }
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, cycleInsert }
}

describe('create_cycle — team workspace scoping', () => {
  it('creates the cycle when the team is in the active workspace', async () => {
    const { supabase, cycleInsert } = makeSupabase(WORKSPACE_ID)

    const result = (await createCycleTools(USER_ID, supabase, WORKSPACE_ID).create_cycle.execute!(
      { team_id: TEAM_ID, ...DATES } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; message?: string }

    expect(result.success).toBe(true)
    expect(cycleInsert).toHaveBeenCalledTimes(1)
    expect(cycleInsert).toHaveBeenCalledWith(expect.objectContaining({ team_id: TEAM_ID }))
  })

  it("rejects a team in another workspace and doesn't insert", async () => {
    const { supabase, cycleInsert } = makeSupabase(OTHER_WORKSPACE_ID)

    const result = (await createCycleTools(USER_ID, supabase, WORKSPACE_ID).create_cycle.execute!(
      { team_id: TEAM_ID, ...DATES } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    // Same reply as a team that doesn't exist — it must not confirm that this
    // id is a real team somewhere else.
    expect(result.error).not.toMatch(new RegExp(OTHER_WORKSPACE_ID))
    expect(cycleInsert).not.toHaveBeenCalled()
  })

  it("rejects a team id that doesn't exist and doesn't insert", async () => {
    const { supabase, cycleInsert } = makeSupabase(null)

    const result = (await createCycleTools(USER_ID, supabase, WORKSPACE_ID).create_cycle.execute!(
      { team_id: 'no-such-team', ...DATES } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(cycleInsert).not.toHaveBeenCalled()
  })

  it('still validates the date range for an in-workspace team', async () => {
    const { supabase, cycleInsert } = makeSupabase(WORKSPACE_ID)

    const result = (await createCycleTools(USER_ID, supabase, WORKSPACE_ID).create_cycle.execute!(
      { team_id: TEAM_ID, start_date: '2026-01-15', end_date: '2026-01-01' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/end_date must be after start_date/)
    expect(cycleInsert).not.toHaveBeenCalled()
  })
})
