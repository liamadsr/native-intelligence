/**
 * A demo workspace's calls take notes but keep no audio (migration 669): the
 * producer's upload grant answers "not wanted" before the database is asked
 * for one, and nothing is signed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { grantAudio } from '../audio'
import { setDemoWorkspaceLookupForTests } from '@/lib/demo/demo-mode'

const SESSION = '99999999-9999-4999-8999-999999999999'
const producer = { id: 'p1' } as never
const take = { take: 't1', offsetMs: 0, durationMs: 1000, bytes: 10, contentType: 'audio/mp4' } as never

function service(session: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => ({ data: [{ outcome: 'granted', path: 'ch/call/audio/a.m4a', expires_at: null }], error: null }))
  const sign = vi.fn(async () => ({ data: { signedUrl: 'https://sb.example.test/upload' }, error: null }))
  const q = { select: () => q, eq: () => q, maybeSingle: async () => session }
  const svc = { from: () => q, rpc, storage: { from: () => ({ createSignedUploadUrl: sign }) } } as unknown as SupabaseClient
  return { svc, rpc, sign }
}

beforeEach(() => setDemoWorkspaceLookupForTests((id) => id === 'ws-demo'))

describe('grantAudio', () => {
  it('a demo workspace’s session: not wanted, no grant made, nothing signed', async () => {
    const { svc, rpc, sign } = service({ data: { workspace_id: 'ws-demo' }, error: null })
    expect(await grantAudio(svc, SESSION, producer, take)).toEqual({ outcome: 'not_wanted', upload: null, expiresAt: null })
    expect(rpc).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
  })

  it('any other workspace: granted as before', async () => {
    const { svc, rpc } = service({ data: { workspace_id: 'ws-real' }, error: null })
    expect((await grantAudio(svc, SESSION, producer, take)).outcome).toBe('granted')
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('a session that cannot be read, or a flag that cannot: no audio kept', async () => {
    const unread = service({ data: null, error: { message: 'timeout' } })
    expect((await grantAudio(unread.svc, SESSION, producer, take)).outcome).toBe('not_wanted')
    expect(unread.rpc).not.toHaveBeenCalled()
    setDemoWorkspaceLookupForTests(() => { throw new Error('down') })
    const unflagged = service({ data: { workspace_id: 'ws-real' }, error: null })
    expect((await grantAudio(unflagged.svc, SESSION, producer, take)).outcome).toBe('not_wanted')
  })

  it('no such session: the grant’s own check answers', async () => {
    const { svc, rpc } = service({ data: null, error: null })
    await grantAudio(svc, SESSION, producer, take)
    expect(rpc).toHaveBeenCalledOnce()
  })
})
