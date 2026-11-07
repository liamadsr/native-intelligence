/**
 * pr_status_changed, wired (F1): the emitter sends one event per linked
 * action (deduped, idempotent on GitHub's delivery id), and the matcher fires
 * only enabled loops that watch the PR's repo and state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({ batches: [] as unknown[][], fail: false }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (events: unknown[]) => {
      if (sent.fail) throw new Error('down')
      sent.batches.push(events)
      return { ids: [] }
    },
  },
}))

import { emitPrStatusChange } from '../emit-pr-status-change'
import { findMatchingFlowsForPrStatusChange } from '../queries'

beforeEach(() => {
  sent.batches.length = 0
  sent.fail = false
})

describe('emitPrStatusChange', () => {
  it('one event per linked action, deduped, keyed on the delivery id', async () => {
    const n = await emitPrStatusChange({
      links: [
        { workspace_id: 'ws-1', action_id: 'a-1' },
        { workspace_id: 'ws-1', action_id: 'a-1' },
        { workspace_id: 'ws-2', action_id: 'a-9' },
      ],
      repoFullName: 'acme/web',
      prNumber: 7,
      prState: 'merged',
      deliveryId: 'd-1',
      firedAt: '2026-10-19T00:00:00Z',
    })
    expect(n).toBe(2)
    expect(sent.batches[0]).toEqual([
      {
        name: 'flow/pr.status_changed',
        id: 'pr-status:d-1:a-1',
        data: { workspace_id: 'ws-1', action_id: 'a-1', repo_full_name: 'acme/web', pr_number: 7, pr_state: 'merged', fired_at: '2026-10-19T00:00:00Z' },
      },
      expect.objectContaining({ id: 'pr-status:d-1:a-9', data: expect.objectContaining({ workspace_id: 'ws-2' }) }),
    ])
  })

  it('no links: sends nothing; a failed send never throws', async () => {
    expect(await emitPrStatusChange({ links: [], repoFullName: 'acme/web', prNumber: 1, prState: 'open' })).toBe(0)
    expect(sent.batches).toEqual([])
    sent.fail = true
    await expect(emitPrStatusChange({ links: [{ workspace_id: 'w', action_id: 'a' }], repoFullName: 'acme/web', prNumber: 1, prState: 'open' })).resolves.toBe(0)
  })
})

describe('findMatchingFlowsForPrStatusChange', () => {
  const rows = [
    { id: 'f-merged', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'Acme/Web', to_state: 'merged' }, actions: [] },
    { id: 'f-any', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'any' }, actions: [] },
    { id: 'f-open', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'open' }, actions: [] },
    { id: 'f-other-repo', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/api', to_state: 'any' }, actions: [] },
    { id: 'f-no-repo', trigger_config: { kind: 'pr_status_changed', to_state: 'any' }, actions: [] },
  ]
  function client() {
    const filters: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push([c, v]), chain),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    }
    return { supabase: { from: () => chain } as never, filters }
  }

  it("matches the repo case-insensitively and the state (or 'any'), enabled loops of this workspace only", async () => {
    const { supabase, filters } = client()
    const flows = await findMatchingFlowsForPrStatusChange(supabase, { workspaceId: 'ws-1', repoFullName: 'acme/WEB', prState: 'merged' })
    expect(flows.map((f) => f.id)).toEqual(['f-merged', 'f-any'])
    expect(filters).toEqual([
      ['workspace_id', 'ws-1'],
      ['enabled', true],
      ['trigger_type', 'pr_status_changed'],
    ])
  })
})
