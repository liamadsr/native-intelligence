/**
 * Whose standing the SEO area's money and standing choices rest on
 * (../membership.ts): the member row, fenced on the workspace and the person,
 * and a throw when it can't be read.
 */
import { describe, expect, it } from 'vitest'
import { isFullMemberRole, memberRole, memberStanding } from '../membership'

const WS = '0b7e2f9c-41d6-4c58-9f0a-6e3d8a1c5b47'
const USER = '4d2c7b1a-9a53-4e0f-8f3e-2a6f1c9b7d02'

function svc(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, unknown[]]> = []
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) builder[m] = (...args: unknown[]) => (calls.push([m, args]), builder)
  builder.limit = async (...args: unknown[]) => (calls.push(['limit', args]), answer)
  return { client: { from: (t: string) => (calls.push(['from', [t]]), builder) } as never, calls }
}

describe('isFullMemberRole', () => {
  it('owner, admin and member are full members; a guest, an unknown role and nobody are not', () => {
    for (const role of ['owner', 'admin', 'member']) expect(isFullMemberRole(role), role).toBe(true)
    for (const role of ['guest', 'viewer', '', null, undefined]) expect(isFullMemberRole(role), String(role)).toBe(false)
  })
})

describe('memberStanding', () => {
  it('reads the role and name of that person in THAT workspace', async () => {
    const { client, calls } = svc({ data: [{ role: 'admin', display_name: '  Mara Lindqvist ' }], error: null })
    expect(await memberStanding(client, WS, USER)).toEqual({ role: 'admin', name: 'Mara Lindqvist' })
    expect(calls).toEqual([
      ['from', ['member']],
      ['select', ['role, display_name']],
      ['eq', ['workspace_id', WS]],
      ['eq', ['user_id', USER]],
      ['limit', [1]],
    ])
  })

  it('someone who is not in the workspace has no role', async () => {
    const { client } = svc({ data: [], error: null })
    expect(await memberStanding(client, WS, USER)).toEqual({ role: null, name: null })
    expect(await memberRole(client, WS, USER)).toBeNull()
  })

  it('a row that can’t be read throws: the callers refuse rather than guess', async () => {
    const { client } = svc({ data: null, error: { message: 'connection reset' } })
    await expect(memberStanding(client, WS, USER)).rejects.toThrow(/member read failed/)
  })
})
