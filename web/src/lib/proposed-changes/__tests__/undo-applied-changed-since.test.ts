import { describe, it, expect } from 'vitest'
import { entityChangedSince } from '../undo-applied'

/** milestone has no workspace_id column: the changed-since read fences through the project. */
function stub(milestone: Record<string, unknown> | null) {
  const eqs: Array<[string, string, unknown]> = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (col: string, v: unknown) => {
      eqs.push([table, col, v])
      return chain
    }
    chain.limit = () => chain
    chain.maybeSingle = async () => ({ data: milestone, error: null })
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    return chain
  }
  return { client: { from } as never, eqs }
}

const APPLIED = '2026-10-01T10:00:00.000Z'

describe('entityChangedSince — milestone', () => {
  it('an untouched milestone in this workspace is unchanged (no workspace_id filter on milestone)', async () => {
    const { client, eqs } = stub({ updated_at: APPLIED, project: { workspace_id: 'ws-1' } })
    expect(await entityChangedSince(client, 'ws-1', 'milestone', 'ms-1', APPLIED)).toBe(false)
    expect(eqs.some(([t, c]) => t === 'milestone' && c === 'workspace_id')).toBe(false)
  })

  it("a milestone whose project is in another workspace is left alone", async () => {
    const { client } = stub({ updated_at: APPLIED, project: { workspace_id: 'ws-OTHER' } })
    expect(await entityChangedSince(client, 'ws-1', 'milestone', 'ms-1', APPLIED)).toBe(true)
  })
})
