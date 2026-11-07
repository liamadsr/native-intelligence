import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProposedChange } from '../types'

/**
 * claimAndApplyChange: the one claim-then-apply every accept path shares.
 * The fake models the guard for real: an update lands only when every .eq()
 * filter matches the stored row, and `.select()` reports what it touched.
 */

const hoisted = vi.hoisted(() => ({ applyChange: vi.fn() }))
vi.mock('../apply-engine', () => ({ applyChange: hoisted.applyChange }))

const { claimAndApplyChange } = await import('../claim-apply')

type Row = Record<string, unknown>

function fakeDb(row: Row) {
  const updates: Array<{ payload: Row; matched: boolean }> = []
  const client = {
    from: () => {
      const filters: Row = {}
      let payload: Row = {}
      const chain: Record<string, unknown> = {}
      const run = () => {
        const matched = Object.entries(filters).every(([k, v]) => row[k] === v)
        if (matched) Object.assign(row, payload)
        updates.push({ payload, matched })
        return { data: matched ? [{ id: row.id }] : [], error: null }
      }
      chain.update = (p: Row) => {
        payload = p
        return chain
      }
      chain.eq = (k: string, v: unknown) => {
        filters[k] = v
        return chain
      }
      chain.select = () => chain
      chain.then = (resolve: (v: unknown) => unknown) => resolve(run())
      return chain
    },
  }
  return { client: client as never, updates }
}

const change = {
  id: 'pc-1',
  workspace_id: 'ws-1',
  change_type: 'create',
  entity_type: 'action',
  status: 'pending',
} as unknown as ProposedChange

beforeEach(() => hoisted.applyChange.mockReset())

describe('claimAndApplyChange', () => {
  it('claims, applies, then records the result', async () => {
    const row: Row = { id: 'pc-1', workspace_id: 'ws-1', status: 'pending' }
    const { client, updates } = fakeDb(row)
    hoisted.applyChange.mockResolvedValueOnce({ success: true, entity_id: 'act-1', applied_change_type: 'create' })

    const out = await claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-1', userId: 'u-1' })

    expect(out).toMatchObject({ ok: true, entity_id: 'act-1', change: { status: 'applied', result_entity_id: 'act-1' } })
    expect(updates[0].payload).toMatchObject({ status: 'applied', applied_by: 'mem-1', error_message: null })
    expect(updates[1].payload).toMatchObject({ result_entity_id: 'act-1', change_type: 'create' })
    expect(row.status).toBe('applied')
  })

  it('does not apply a row someone else already claimed', async () => {
    const row: Row = { id: 'pc-1', workspace_id: 'ws-1', status: 'applied' }
    const { client, updates } = fakeDb(row)

    const out = await claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-1' })

    expect(out).toEqual({ ok: false, reason: 'not_pending' })
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
  })

  it('two concurrent accepts apply once', async () => {
    const row: Row = { id: 'pc-1', workspace_id: 'ws-1', status: 'pending' }
    const { client } = fakeDb(row)
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-1' })

    const [a, b] = await Promise.all([
      claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-1' }),
      claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-2' }),
    ])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(hoisted.applyChange).toHaveBeenCalledTimes(1)
  })

  it('hands the claim back with the error when the apply fails', async () => {
    const row: Row = { id: 'pc-1', workspace_id: 'ws-1', status: 'pending' }
    const { client } = fakeDb(row)
    hoisted.applyChange.mockResolvedValueOnce({ success: false, error: 'boom', code: 'MCP_TOKEN_EXPIRED' })

    const out = await claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-1' })

    expect(out).toEqual({ ok: false, reason: 'apply_failed', error: 'boom', code: 'MCP_TOKEN_EXPIRED' })
    expect(row).toMatchObject({ status: 'pending', applied_by: null, error_message: 'boom' })
  })

  it('passes an unattended origin through to the apply engine', async () => {
    const row: Row = { id: 'pc-1', workspace_id: 'ws-1', status: 'pending' }
    const { client } = fakeDb(row)
    hoisted.applyChange.mockResolvedValueOnce({ success: true, entity_id: 'act-1' })
    const origin = { kind: 'skill_run' } as never

    await claimAndApplyChange(client, change, { workspaceId: 'ws-1', memberId: 'mem-1', userId: 'u-1', origin })

    expect(hoisted.applyChange).toHaveBeenCalledWith(client, change, 'ws-1', 'mem-1', 'u-1', { origin })
  })
})
