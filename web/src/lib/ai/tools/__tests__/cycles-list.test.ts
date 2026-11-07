/**
 * Regression: list_cycles read cycles by a model-supplied team_id with no
 * workspace check. `cycle` carries no workspace_id and these tools can run on a
 * service-role client, so a foreign team id read another tenant's sprints.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCycleTools } from '../cycles'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function makeSupabase(teamWorkspaceId: string | null) {
  const from = vi.fn((table: string) => {
    const result =
      table === 'cycle'
        ? { data: [{ id: 'cycle-1', name: 'Cycle 1', number: 1 }], error: null }
        : { data: [], error: null }
    const chain: Record<string, unknown> = {
      single: async () =>
        table === 'team'
          ? { data: teamWorkspaceId ? { workspace_id: teamWorkspaceId } : null, error: null }
          : { data: null, error: null },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        return () => proxy
      },
    })
    return proxy
  })
  return { from } as never as { from: ReturnType<typeof vi.fn> }
}

describe('list_cycles — team workspace scoping', () => {
  it('lists cycles for a team in the active workspace', async () => {
    const supabase = makeSupabase(WORKSPACE_ID)
    const result = (await createCycleTools(USER_ID, supabase as never, WORKSPACE_ID).list_cycles.execute!(
      { team_id: 'team-1' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; count: number }

    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
  })

  it("answers not-found for a team in a workspace the caller isn't in, without reading its cycles", async () => {
    const supabase = makeSupabase('ws-other')
    const result = (await createCycleTools(USER_ID, supabase as never, WORKSPACE_ID).list_cycles.execute!(
      { team_id: 'team-foreign' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(supabase.from.mock.calls.some((c: unknown[]) => c[0] === 'cycle')).toBe(false)
  })
})
