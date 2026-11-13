/**
 * GET /api/account/captures/[id]/audio: a signed-in person's look at a
 * capture's call audio. 401 signed out; 404 for a capture they may not read
 * (its RLS, read as them) and for a link to a file that is not kept; the
 * files' views for one they may; a link signed as them, with an hour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const h = vi.hoisted(() => ({ user: null as unknown, svc: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireUser: async () => h.user }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))

import { GET } from '../route'

let signed: string[]
beforeEach(() => {
  signed = []
  const person = Object.assign(memoryDb({ captures: [{ id: CAPTURE }] }), {
    storage: { from: () => ({ createSignedUrl: async (path: string) => (signed.push(path), { data: { signedUrl: `https://sb.example.test/s/${path}?token=t` }, error: null }) }) },
  })
  h.user = { supabase: person as unknown as SupabaseClient, user: { id: 'u' } }
  h.svc = memoryDb({
    capture_audio: [
      { id: FILE, capture_id: CAPTURE, part: 0, path: 'ch/call/audio/f.m4a', content_type: 'audio/mp4', state: 'stored', duration_ms: 60_000, expires_at: '2026-12-13T10:00:00Z', stored_at: '2026-11-13T11:00:00Z', deleted_at: null, created_at: '2026-11-13T11:00:00Z' },
    ],
  })
})

const get = (q = '', id = CAPTURE) => GET(new NextRequest(`http://localhost/api/account/captures/${id}/audio${q}`), { params: Promise.resolve({ id }) })

describe('GET /api/account/captures/[id]/audio', () => {
  it('401 signed out', async () => {
    h.user = new Response('{}', { status: 401 })
    expect((await get()).status).toBe(401)
  })
  it('the files of a capture they may read', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [{ id: FILE, part: 0, state: 'ready', durationMs: 60_000, expiresAt: '2026-12-13T10:00:00.000Z', deletedAt: null }] })
  })
  it('404 for a capture they may not read, and for a bad id', async () => {
    expect((await get('', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).status).toBe(404)
    expect((await get('', 'nope')).status).toBe(404)
    expect((await get('?file=nope')).status).toBe(404)
  })
  it('a link signed as them, an hour long; 404 for a file not kept', async () => {
    const res = await get(`?file=${FILE}&as=play`)
    expect(await res.json()).toEqual({ url: 'https://sb.example.test/s/ch/call/audio/f.m4a?token=t', expiresIn: 3600 })
    expect(signed).toEqual(['ch/call/audio/f.m4a'])
    expect((await get('?file=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).status).toBe(404)
  })
})
