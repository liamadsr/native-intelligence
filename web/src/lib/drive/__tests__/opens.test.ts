import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openKeyOf, recentFiles, recordOpen } from '../opens'

const ID = '11111111-1111-4111-8111-111111111111'
const CH = '22222222-2222-4222-8222-222222222222'

function client(result: { data?: unknown; error?: { code?: string; message: string } | null }, log: Array<[string, ...unknown[]]> = []) {
  const q: Record<string, (...a: unknown[]) => unknown> = {}
  for (const m of ['select', 'eq', 'order']) q[m] = (...a: unknown[]) => (log.push([m, ...a]), q)
  q.limit = async () => ({ data: result.data ?? [], error: result.error ?? null })
  q.upsert = async (...a: unknown[]) => (log.push(['upsert', ...a]), { error: result.error ?? null })
  return { from: () => q } as unknown as SupabaseClient
}

describe('openKeyOf', () => {
  it('takes an upload by its id and a team chat file by its object path, never mail', () => {
    expect(openKeyOf(`upload:${ID}`)).toBe(`upload:${ID}`)
    expect(openKeyOf(`team_chat:${CH}/${ID}/${ID}.pdf`)).toBe(`team_chat:${CH}/${ID}/${ID}.pdf`)
    expect(openKeyOf('email:acct:msg:plan.pdf')).toBeNull()
    expect(openKeyOf(`team_chat:${CH}/../x`)).toBeNull()
    expect(openKeyOf('upload:nope')).toBeNull()
    expect(openKeyOf(42)).toBeNull()
  })
})

describe('recording and reading opens', () => {
  it('records the person’s own open, the latest time winning', async () => {
    const log: Array<[string, ...unknown[]]> = []
    await recordOpen(client({}, log), { workspaceId: 'ws', userId: 'u1' }, `upload:${ID}`)
    const up = log.find((l) => l[0] === 'upsert')!
    expect(up[1]).toMatchObject({ user_id: 'u1', workspace_id: 'ws', file_key: `upload:${ID}` })
    expect(up[2]).toEqual({ onConflict: 'user_id,workspace_id,file_key' })
  })

  it('before 696 keeps nothing and lists nothing, quietly; any other failure says so', async () => {
    const missing = { code: '42P01', message: 'relation "drive_file_open" does not exist' }
    await expect(recordOpen(client({ error: missing }), { workspaceId: 'ws', userId: 'u1' }, `upload:${ID}`)).resolves.toBeUndefined()
    await expect(recentFiles(client({ error: missing }), { workspaceId: 'ws', userId: 'u1' })).resolves.toEqual([])
    await expect(recentFiles(client({ error: { code: '500', message: 'down' } }), { workspaceId: 'ws', userId: 'u1' })).rejects.toThrow('down')
  })
})
