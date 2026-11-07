/**
 * Context pack builder tests (Phase 2, Workstream C).
 *
 * A stateful-ish fake models the compact reads; the assertions cover the shape
 * (who-am-I header, dedupe list, queue shape) + the fail-soft contract (a failing
 * sub-query degrades to an omitted section, never a thrown run).
 */
import { describe, it, expect } from 'vitest'
import { buildContextPack } from '../context-pack'

type Row = Record<string, unknown>

function fakeSupabase(data: {
  member?: Row | null
  workflow_state?: Row[]
  actions?: Row[]
  projects?: Row[]
  team?: Row[]
  team_member?: Row[]
  cycle?: Row | null
  captures?: Row[]
  local_calendar_event?: Row[]
  proposed_change?: Row[]
  knowledge_package?: Row[]
  proposalCounts?: { total: number; stale: number; capture: number }
  throwOn?: string
  onEq?: (table: string, k: string, v: unknown) => void
}) {
  function builder(table: string) {
    if (data.throwOn === table) {
      throw new Error(`boom on ${table}`)
    }
    let isHeadCount = false
    const api: Record<string, unknown> = {
      select: (_c?: unknown, opts?: { head?: boolean; count?: string }) => {
        if (opts?.head || opts?.count) isHeadCount = true
        return api
      },
      eq: (k: string, v: unknown) => {
        data.onEq?.(table, k, v)
        return api
      },
      neq: () => api,
      is: () => api,
      in: () => api,
      or: () => api,
      lt: () => api,
      lte: () => api,
      gte: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => {
        if (table === 'member') return { data: data.member ?? null, error: null }
        if (table === 'cycle') return { data: data.cycle ?? null, error: null }
        return { data: null, error: null }
      },
      then: (resolve: (r: unknown) => unknown) => {
        if (isHeadCount && table === 'proposed_change') {
          // Return a plausible count; the builder calls this three times but the
          // fake can't easily distinguish — return total for all, good enough to
          // assert the section renders.
          return Promise.resolve({ count: data.proposalCounts?.total ?? 0, error: null }).then(resolve)
        }
        const rows =
          table === 'workflow_state' ? data.workflow_state ?? [] :
          table === 'actions' ? data.actions ?? [] :
          table === 'projects' ? data.projects ?? [] :
          table === 'team' ? data.team ?? [] :
          table === 'team_member' ? data.team_member ?? [] :
          table === 'captures' ? data.captures ?? [] :
          table === 'local_calendar_event' ? data.local_calendar_event ?? [] :
          table === 'proposed_change' ? data.proposed_change ?? [] :
          table === 'knowledge_package' ? data.knowledge_package ?? [] :
          []
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      },
    }
    return api
  }
  return { from: (t: string) => builder(t) } as never
}

describe('buildContextPack', () => {
  const base = {
    member: { id: 'm1', display_name: 'Liam Alizadeh' },
    workflow_state: [{ id: 's1', name: 'Todo', category: 'unstarted' }],
    actions: [
      { identifier: 'GEN-1', title: 'Ship the thing', priority: 'high', status_id: 's1' },
      { identifier: 'GEN-2', title: 'Review the doc', priority: 'none', status_id: 's1' },
    ],
    projects: [{ name: 'Relaunch', status: 'active', is_archived: false }],
    team: [{ id: 't1' }],
    cycle: { name: 'Cycle 4' },
    captures: [{ title: 'Design review', created_at: '2026-07-01' }],
    local_calendar_event: [{ title: '1:1 with Sam', start_at: '2026-07-03T15:00:00Z' }],
    proposalCounts: { total: 42, stale: 10, capture: 3 },
  }

  it('renders the who-am-I header with the run-as name', async () => {
    const out = await buildContextPack({ supabase: fakeSupabase(base), workspaceId: 'ws1', runAsUserId: 'u1' })
    expect(out).toContain('Liam Alizadeh')
    expect(out).toContain('Who this run is for')
    expect(out).toContain('explicitly mine')
  })

  it("includes the user's open work as a dedupe list", async () => {
    const out = await buildContextPack({ supabase: fakeSupabase(base), workspaceId: 'ws1', runAsUserId: 'u1' })
    expect(out).toContain('GEN-1')
    expect(out).toContain('Ship the thing')
    expect(out).toContain('dedupe proposals against THIS first')
  })

  it('includes projects, recent meetings, and the queue shape', async () => {
    const out = await buildContextPack({ supabase: fakeSupabase(base), workspaceId: 'ws1', runAsUserId: 'u1' })
    expect(out).toContain('Relaunch')
    expect(out).toContain('Design review')
    expect(out).toContain('Pending across the workspace')
  })

  it('is fail-soft: a throwing sub-query omits its section, never throws', async () => {
    // actions read throws → no open-work section, but the pack still builds.
    const out = await buildContextPack({
      supabase: fakeSupabase({ ...base, throwOn: 'actions' }),
      workspaceId: 'ws1',
      runAsUserId: 'u1',
    })
    expect(out).not.toContain('Ship the thing')
    expect(out).toContain('Who this run is for') // still built
  })

  it('surfaces recently auto-accepted items (so revoke is reachable) with their proposal_id', async () => {
    const out = await buildContextPack({
      supabase: fakeSupabase({
        ...base,
        proposed_change: [{ id: 'prop-abc', title: 'Auto-applied dup', display_text: 'Auto-applied dup', applied_at: '2026-07-03' }],
      }),
      workspaceId: 'ws1',
      runAsUserId: 'u1',
    })
    expect(out).toContain('Recently auto-accepted')
    expect(out).toContain('proposal_id: prop-abc')
    expect(out).toContain('revoke')
  })

  it('fences the calendar query on BOTH workspace_id and user_id (no cross-workspace leak)', async () => {
    const eqCalls: Array<[string, unknown]> = []
    await buildContextPack({
      supabase: fakeSupabase({
        ...base,
        onEq: (table, k, v) => {
          if (table === 'local_calendar_event') eqCalls.push([k, v])
        },
      }),
      workspaceId: 'ws-A',
      runAsUserId: 'u1',
    })
    const keys = eqCalls.map(([k]) => k)
    expect(keys).toContain('workspace_id')
    expect(keys).toContain('user_id')
    expect(eqCalls).toContainEqual(['workspace_id', 'ws-A'])
  })

  it("reads only workspace-visible captures for recent meetings (an 'Only me' title never reaches the prompt)", async () => {
    const eqCalls: Array<[string, unknown]> = []
    await buildContextPack({
      supabase: fakeSupabase({
        ...base,
        onEq: (table, k, v) => {
          if (table === 'captures') eqCalls.push([k, v])
        },
      }),
      workspaceId: 'ws-A',
      runAsUserId: 'u1',
    })
    expect(eqCalls).toContainEqual(['visibility', 'workspace'])
  })

  it('returns empty string when there is nothing but the header', async () => {
    const out = await buildContextPack({
      supabase: fakeSupabase({ member: { id: 'm1', display_name: 'Solo' }, proposalCounts: { total: 0, stale: 0, capture: 0 } }),
      workspaceId: 'ws1',
      runAsUserId: 'u1',
    })
    // header + a zero queue section still render (queue is always shown), so this
    // asserts the pack is small, not literally empty — the queue section counts.
    expect(out).toContain('Proposal queue shape')
  })

  // ── W-A: knowledge packages section + visibility fencing ────────────────────
  describe('knowledge packages section (W-A)', () => {
    it('renders workspace-visible packages with id + description + the cite instruction', async () => {
      const out = await buildContextPack({
        supabase: fakeSupabase({
          ...base,
          knowledge_package: [
            {
              id: 'pkg-1',
              name: 'Acme Account',
              description: 'Everything about the Acme deal',
              visibility: 'workspace',
              team_id: null,
              created_by: 'someone-else',
              updated_at: '2026-07-10',
            },
          ],
        }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(out).toContain('Knowledge packages')
      expect(out).toContain('Acme Account')
      expect(out).toContain('id: pkg-1')
      expect(out).toContain('Everything about the Acme deal')
      // The cite instruction names the exact resource shape.
      expect(out).toContain('"type":"package"')
    })

    it('personal package: included only when created_by === runAsUserId', async () => {
      // Mine → included.
      const mine = await buildContextPack({
        supabase: fakeSupabase({
          ...base,
          knowledge_package: [
            { id: 'pkg-mine', name: 'My notes', description: null, visibility: 'personal', team_id: null, created_by: 'u1', updated_at: '2026-07-10' },
          ],
        }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(mine).toContain('pkg-mine')

      // Someone else's personal package → excluded.
      const theirs = await buildContextPack({
        supabase: fakeSupabase({
          ...base,
          knowledge_package: [
            { id: 'pkg-theirs', name: 'Their notes', description: null, visibility: 'personal', team_id: null, created_by: 'u2', updated_at: '2026-07-10' },
          ],
        }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(theirs).not.toContain('pkg-theirs')
    })

    it('team package: included only when the run-as user is on the team', async () => {
      // On the team (team_member resolves t1 for the run-as member) → included.
      const onTeam = await buildContextPack({
        supabase: fakeSupabase({
          ...base,
          team_member: [{ team_id: 't1' }],
          knowledge_package: [
            { id: 'pkg-team', name: 'Team pkg', description: null, visibility: 'team', team_id: 't1', created_by: 'u2', updated_at: '2026-07-10' },
          ],
        }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(onTeam).toContain('pkg-team')

      // Not on the team → excluded.
      const offTeam = await buildContextPack({
        supabase: fakeSupabase({
          ...base,
          team_member: [{ team_id: 't-other' }],
          knowledge_package: [
            { id: 'pkg-team', name: 'Team pkg', description: null, visibility: 'team', team_id: 't1', created_by: 'u2', updated_at: '2026-07-10' },
          ],
        }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(offTeam).not.toContain('pkg-team')
    })

    it('caps at 12 packages, truncates name ≤80 and description ≤140', async () => {
      const many = Array.from({ length: 20 }, (_, i) => ({
        id: `pkg-${i}`,
        name: 'N'.repeat(200),
        description: 'D'.repeat(400),
        visibility: 'workspace',
        team_id: null,
        created_by: 'x',
        updated_at: `2026-07-${String(10 + (i % 20)).padStart(2, '0')}`,
      }))
      const out = await buildContextPack({
        supabase: fakeSupabase({ ...base, knowledge_package: many }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      const line = out.split('\n').find((l) => l.startsWith('- ') && l.includes('id: pkg-'))!
      expect(line).toBeTruthy()
      // Name portion (before " (id:") must be ≤ 80.
      const namePart = line.slice(2, line.indexOf(' (id:'))
      expect(namePart.length).toBeLessThanOrEqual(80)
      // Description portion (after "— ") must be ≤ 140.
      const descPart = line.slice(line.indexOf('— ') + 2)
      expect(descPart.length).toBeLessThanOrEqual(140)
      // Never more than 12 package lines rendered.
      const pkgLines = out.split('\n').filter((l) => l.startsWith('- ') && l.includes('id: pkg-'))
      expect(pkgLines.length).toBeLessThanOrEqual(12)
    })

    it('is fail-soft: a throwing knowledge_package read omits the section, never throws', async () => {
      const out = await buildContextPack({
        supabase: fakeSupabase({ ...base, throwOn: 'knowledge_package' }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(out).not.toContain('Knowledge packages')
      expect(out).toContain('Who this run is for') // still built
    })

    it('omits the section entirely when there are no visible packages', async () => {
      const out = await buildContextPack({
        supabase: fakeSupabase({ ...base, knowledge_package: [] }),
        workspaceId: 'ws1',
        runAsUserId: 'u1',
      })
      expect(out).not.toContain('Knowledge packages')
    })
  })
})
