/**
 * /api/account/vocabulary and /[id] (migration 430). Pins: auth passes
 * through; GET lists the workspace's and the caller's words plus the
 * automatic names, ?view=compiled answers what transcription uses (and for
 * which workspace and person) and asks for a harvest refresh; POST adds
 * (201) or folds into the same word (200), `hide` turns an automatic name off
 * for the caller only; PATCH approves / edits; DELETE removes; bad ids and
 * bodies are 400s, other people's words 404s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { ME, OTHER, WS, termRow, vocabularyDb, type VocabularyDb } from '@/lib/vocabulary/__tests__/helpers/vocabulary-db'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), requestHarvest: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/vocabulary/harvest-trigger', () => ({ requestVocabularyHarvest: hoisted.requestHarvest }))

import { GET, POST } from '@/app/api/account/vocabulary/route'
import { DELETE, PATCH } from '@/app/api/account/vocabulary/[id]/route'

let db: VocabularyDb
function setup(seed: Parameters<typeof vocabularyDb>[0] = {}) {
  db = vocabularyDb(seed)
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db.client, user: { id: ME }, workspaceId: WS })
}

const BASE = 'https://dial8.ai/api/account/vocabulary'
const get = (q = '') => GET(buildRequest({ url: `${BASE}${q}`, method: 'GET' }) as unknown as NextRequest)
const post = (body: unknown, raw = false) => POST(buildRequest({ url: BASE, method: 'POST', body, raw }) as unknown as NextRequest)
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (id: string, body: unknown) => PATCH(buildRequest({ url: `${BASE}/${id}`, method: 'PATCH', body }) as unknown as NextRequest, ctx(id))
const del = (id: string) => DELETE(buildRequest({ url: `${BASE}/${id}`, method: 'DELETE' }) as unknown as NextRequest, ctx(id))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('auth', () => {
  it('passes the auth helper’s response through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(null, { status: 401 }))
    const id = termRow().id as string
    expect((await get()).status).toBe(401)
    expect((await post({ term: 'x' })).status).toBe(401)
    expect((await patch(id, {})).status).toBe(401)
    expect((await del(id)).status).toBe(401)
  })
})

describe('GET', () => {
  it("lists the workspace's words and mine, with the automatic names", async () => {
    setup({
      vocabulary_term: [termRow({ term: 'Supabase' }), termRow({ term: 'Private', user_id: OTHER }), termRow({ term: 'Inngest', status: 'dismissed' })],
      member: [{ id: 'm1', user_id: ME, display_name: 'Liam Alizadeh', workspace_id: WS }],
    })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await readJson<{ terms: Array<{ term: string; status: string }>; automatic: unknown[] }>(res)
    expect(body.terms.map((t) => t.term)).toEqual(['Inngest', 'Supabase'])
    expect(body.automatic).toEqual([{ term: 'Liam Alizadeh', kind: 'teammate' }])
  })

  it('?view=compiled answers what transcription uses, for whom, and asks for a harvest refresh', async () => {
    setup({ vocabulary_term: [termRow({ term: 'Supabase', sounds_like: ['Superbase'] }), termRow({ term: 'Inngest', status: 'dismissed' })] })
    const res = await get('?view=compiled')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    const body = await readJson<{ entries: unknown[]; version: string; workspaceId: string; userId: string }>(res)
    expect(body.entries).toEqual([{ term: 'Supabase', soundsLike: ['Superbase'] }])
    expect(typeof body.version).toBe('string')
    expect(body).toMatchObject({ workspaceId: WS, userId: ME })
    expect(hoisted.requestHarvest).toHaveBeenCalledWith(WS, ME)
  })
})

describe('POST', () => {
  it('adds a workspace word (201), then folds a repeat into it (200)', async () => {
    setup()
    const first = await post({ term: 'Supabase', sounds_like: ['Superbase'] })
    expect(first.status).toBe(201)
    expect(await readJson(first)).toMatchObject({ created: true, term: { term: 'Supabase', scope: 'workspace', soundsLike: ['Superbase'] } })
    const again = await post({ term: 'supabase', sounds_like: 'Soupabase' })
    expect(again.status).toBe(200)
    expect(db.tables.vocabulary_term).toHaveLength(1)
    expect(db.tables.vocabulary_term[0].sounds_like).toEqual(['Superbase', 'Soupabase'])
  })

  it('a personal word, and hide (an automatic name off for me only)', async () => {
    setup()
    await post({ term: 'Kowalczyk', scope: 'personal' })
    await post({ term: 'Will Smith', hide: true, scope: 'workspace' })
    expect(db.tables.vocabulary_term.map((r) => [r.term, r.user_id, r.status, r.source])).toEqual([
      ['Kowalczyk', ME, 'active', 'manual'],
      ['Will Smith', ME, 'dismissed', 'auto'],
    ])
  })

  it.each([
    ['no body', 'not json', true],
    ['an empty word', { term: '  ' }, false],
    ['a bad scope', { term: 'X', scope: 'team' }, false],
  ])('%s: 400', async (_label, body, raw) => {
    setup()
    expect((await post(body, raw as boolean)).status).toBe(400)
  })
})

describe('PATCH / DELETE', () => {
  it('turns a word off and edits its forms', async () => {
    const row = termRow({ term: 'Inngest' })
    setup({ vocabulary_term: [row] })
    const res = await patch(row.id as string, { status: 'dismissed', sounds_like: ['Ingest'] })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ term: { status: 'dismissed', soundsLike: ['Ingest'] } })
  })

  it("404 for another person's word; 400 for a bad id or status", async () => {
    const theirs = termRow({ user_id: OTHER })
    const ours = termRow({ term: 'Tauri' })
    setup({ vocabulary_term: [theirs, ours] })
    expect((await patch(theirs.id as string, { status: 'active' })).status).toBe(404)
    expect((await patch('nope', { status: 'active' })).status).toBe(400)
    expect((await patch(ours.id as string, { status: 'maybe' })).status).toBe(400)
    expect((await del(theirs.id as string)).status).toBe(404)
    expect((await del('nope')).status).toBe(400)
    const ok = await del(ours.id as string)
    expect(ok.status).toBe(200)
    expect(db.tables.vocabulary_term.map((r) => r.term)).toEqual(['Supabase'])
  })
})
