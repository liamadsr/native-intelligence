/**
 * The Mac body's two Studio product routes (../route.ts, ../capture/route.ts) over the Studio's in-memory tables: only a
 * session the person started or asked for in a typed turn, only for the job that session took and still runs (not
 * finished, not expired); a capture of the kind its header says (type, name and bytes), read under its size cap and
 * never held whole past it. The session token check is stood in for (agent-access.ts has its own tests); the worker's
 * import too (products.test.ts covers the rest). A made-up product and Mac.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as unknown, caller: 'person_remote' as string, imported: 0 }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/local-agent/agent-access', () => ({
  authorizeMacBody: async () => ({
    claims: {},
    caller: state.caller,
    session: { id: SESSION, userId: AVA, workspaceId: WS, conversationId: 'c', startedBy: 'person', mode: 'read', request: '', createdAt: '', startWords: [], localModel: false, deviceName: 'Test Mac', folderLabel: 'planner' },
  }),
}))
vi.mock('@/lib/studio/server/library', async (load) => ({
  ...(await load<object>()),
  importBytes: async () => {
    state.imported++
    return { asset: { id: SHA, name: 'Planner · PricingCard.png', kind: 'image', file: `assets/${SHA}.png`, sha256: SHA, bytes: 16, width: 768, height: 664, hasAudio: false, sourceCursorHidden: false } }
  },
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { AVA, WS, fakeDb } from '@/lib/studio/server/__tests__/fake'
import { getProductJob, JOB_TTL_MS, PRODUCT_COLLECTIONS, prepareJob } from '@/lib/studio/server/products'
import { readCappedBody } from '@/lib/studio/server/product-mac'
import { GET, POST as report } from '../route'
import { POST as capture } from '../capture/route'

const SESSION = 'e5e5e5e5-1111-4222-8333-888888888888'
const FOLDER = 'c3c3c3c3-1111-4222-8333-888888888888'
const SHA = 'ab'.repeat(32)
const KEY = '6407e050dd1da3926f837678f2dc2411'
const KIT = { slug: 'planner', title: 'Planner', framework: 'vite', alias: { '@': 'src' }, css: null, tailwind: null, discover: ['src/components'], components: {} }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const COMPONENT = 'src-components-PricingCard--PricingCard'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
const ctx = () => ({ supabase: state.db as SupabaseClient, workspaceId: WS, userId: AVA })

beforeEach(() => {
  tables = {
    member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }],
    local_agent_session: [{ id: SESSION, folder_id: FOLDER }],
  }
  state.db = fakeDb(tables).client
  state.caller = 'person_remote'
  state.imported = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** A product and a capture job for it, waiting for the Mac. */
async function captureJob() {
  const now = new Date().toISOString()
  tables.studio_record = [{ workspace_id: WS, collection: PRODUCT_COLLECTIONS.products, key: 'planner', value: { slug: 'planner', title: 'Planner', folderId: FOLDER, folderLabel: 'planner', deviceName: 'Test Mac', kit: KIT, notes: [], components: [], commit: null, listedAt: null, captures: [], createdAt: now, updatedAt: now } }]
  return prepareJob(ctx(), { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: COMPONENT, options: { still: true } } })
}

const take = (id: string) => GET(new Request(`https://app.example.com/api/local-agent/agent/studio?job=${id}`, { headers: { authorization: 'Bearer t' } }))

function captureRequest(job: string, body: BodyInit, options: { kind?: 'video' | 'still'; name?: string; type?: string; length?: string; extra?: Record<string, unknown> } = {}) {
  const meta = { job, component: COMPONENT, name: options.name ?? 'Planner · PricingCard.png', kind: options.kind ?? 'still', width: 384, height: 332, aspect: 1.1566, seconds: 0, key: KEY, commit: null, ...options.extra }
  const headers: Record<string, string> = { authorization: 'Bearer t', 'content-type': options.type ?? 'image/png', 'x-studio-capture': Buffer.from(JSON.stringify(meta)).toString('base64url') }
  if (options.length) headers['content-length'] = options.length
  return new Request('https://app.example.com/api/local-agent/agent/studio/capture', { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
}

const reportRequest = (body: unknown) =>
  new Request('https://app.example.com/api/local-agent/agent/studio', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('who may use the routes', () => {
  it('a loop-started (unattended) Mac job reaches none of them', async () => {
    const job = await captureJob()
    state.caller = 'agent_unattended'
    expect((await take(job.id)).status).toBe(403)
    expect((await capture(captureRequest(job.id, PNG))).status).toBe(403)
    expect((await report(reportRequest({ job: job.id, ok: false, error: 'x' }))).status).toBe(403)
    expect(state.imported).toBe(0)
  })

  it('a capture is taken only for the job this session took and still runs', async () => {
    const job = await captureJob()
    // Not taken yet by this session: refused, nothing imported.
    expect((await capture(captureRequest(job.id, PNG))).status).toBe(404)
    expect((await take(job.id)).status).toBe(200)
    const ok = await capture(captureRequest(job.id, PNG))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ assetId: SHA })
    expect((await getProductJob(ctx(), job.id))?.status).toBe('done')
    // Finished: the same capture sent again is refused, so nothing is imported or placed twice.
    expect((await capture(captureRequest(job.id, PNG))).status).toBe(404)
    expect(state.imported).toBe(1)
  })

  it('a finished or expired job takes no report', async () => {
    const job = await captureJob()
    await take(job.id)
    const old = tables.studio_record!.find((r) => r.key === job.id)!
    old.value = { ...(old.value as Row), createdAt: new Date(Date.now() - JOB_TTL_MS - 60_000).toISOString() }
    expect((await report(reportRequest({ job: job.id, ok: false, error: 'late' }))).status).toBe(404)
    expect((await capture(captureRequest(job.id, PNG))).status).toBe(404)
    old.value = { ...(old.value as Row), createdAt: new Date().toISOString(), status: 'done' }
    expect((await report(reportRequest({ job: job.id, ok: false, error: 'again' }))).status).toBe(404)
    expect((await getProductJob(ctx(), job.id))?.status).toBe('done')
  })
})

describe('what a capture may be', () => {
  it('its content type, its name and its bytes all say the kind its header says', async () => {
    const job = await captureJob()
    await take(job.id)
    expect((await capture(captureRequest(job.id, PNG, { type: 'text/html' }))).status).toBe(415)
    expect((await capture(captureRequest(job.id, PNG, { name: 'card.svg' }))).status).toBe(400)
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    expect((await capture(captureRequest(job.id, html))).status).toBe(415)
    expect((await capture(captureRequest(job.id, PNG, { kind: 'video', type: 'video/webm', name: 'card.webm' }))).status).toBe(415)
    // The header names nothing beyond the capture: no workspace, video, asset or provenance of its own.
    for (const extra of [{ workspace: '0c0c0c0c-1111-4222-8333-555555555555' }, { videoId: '0c0c0c0c-1111-4222-8333-555555555555' }, { provenance: { link: 'x' } }]) {
      expect((await capture(captureRequest(job.id, PNG, { extra }))).status).toBe(400)
    }
    expect(state.imported).toBe(0)
  })

  it('a body over 100 MB is cut off while it is read, with or without a length', async () => {
    const job = await captureJob()
    await take(job.id)
    expect((await capture(captureRequest(job.id, PNG, { length: String(101 * 1024 * 1024) }))).status).toBe(413)
    // No length: the stream is read only until it passes the cap (the same 1 MB chunk, so the test holds no 100 MB).
    const chunk = new Uint8Array(1024 * 1024)
    chunk.set(PNG)
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 400) controller.close()
        else controller.enqueue(chunk)
      },
    })
    expect((await capture(captureRequest(job.id, endless))).status).toBe(413)
    expect(pulled).toBeLessThan(110)
    expect(state.imported).toBe(0)
  })

  it('readCappedBody answers the bytes under the cap, and null past it', async () => {
    const small = new Request('https://app.example.com/', { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    expect(await readCappedBody(small, 3)).toEqual(new Uint8Array([1, 2, 3]))
    const big = new Request('https://app.example.com/', { method: 'POST', body: new Uint8Array([1, 2, 3, 4]) })
    expect(await readCappedBody(big, 3)).toBeNull()
  })
})
