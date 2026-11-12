/**
 * The Studio's HTTP doors, end to end over the in-memory tables: the person's catch-all route (guests refused,
 * errors as `{ error }` sentences with their status, unknown paths 404, wrong methods 405, the shapes the editor
 * reads for what is not built yet), the file route (members of that workspace only, byte ranges), and the
 * worker's routes (its secret first: 503 in production without one, 401 without it; a worker only reaches the
 * blobs of a job it holds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeContext, OTHER_WS, WS, AVA } from '@/lib/studio/server/__tests__/fake'
import type { StudioContext } from '@/lib/studio/server/context'
import { forgetStudioSwitches } from '@/lib/studio/server/auth'

const h = vi.hoisted(() => ({
  ctx: null as unknown as StudioContext,
  svc: null as unknown as SupabaseClient,
  member: { role: 'member' } as { role: string } | null,
  /** The workspace the request's device token is pinned to, or null (a session cookie). */
  pin: null as string | null,
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/api-auth', () => ({
  deviceTokenWorkspace: async () => h.pin,
  requireUser: async () => ({ supabase: h.svc, user: { id: AVA } }),
  requireWorkspaceMember: async () => ({ supabase: h.svc, user: { id: AVA }, workspaceId: WS, member: { id: 'm1', role: h.member?.role } }),
}))

import * as route from '../[...path]/route'
import { POST as claim } from '../../../internal/studio/jobs/claim/route'
import { POST as write } from '../../../internal/studio/blobs/write/route'
import { POST as complete } from '../../../internal/studio/jobs/[id]/complete/route'
import { POST as commit } from '../../../internal/studio/blobs/commit/route'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  forgetStudioSwitches()
  env = fakeContext({ member: [{ id: 'm1', user_id: AVA, workspace_id: WS, role: 'member' }] })
  h.ctx = env.ctx
  h.svc = env.ctx.supabase
  h.member = { role: 'member' }
  h.pin = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// The route builds its own service client (getServiceClient, mocked to the fake) but not its storage: give the
// fake's bucket to every context the route makes, through the fake client.
beforeEach(() => {
  ;(env.ctx.supabase as unknown as { storage: unknown }).storage = {
    from: () => ({
      createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `fake://upload/${path}` }, error: null }),
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `fake://read/${path}` })), error: null }),
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `fake://read/${path}` }, error: null }),
      list: async (folder: string) => ({ data: (await env.storage.list(folder)).map((o) => ({ id: o.name, name: o.name, metadata: { size: o.size } })), error: null }),
      remove: async (paths: string[]) => ((await env.storage.remove(paths)), { data: [], error: null }),
      upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => ((await env.storage.upload(path, bytes, opts.contentType)), { data: {}, error: null }),
    }),
  }
})

const at = (path: string, init: RequestInit = {}) => {
  const segments = path.split('?')[0]!.split('/').filter(Boolean)
  return route.GET(new Request(`http://localhost/api/account/studio/${path}`, init), { params: Promise.resolve({ path: segments }) })
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('the person’s route', () => {
  it('reads no costs or checks of a video that is not here or is in the trash', async () => {
    const made = await (await at('projects/blank', json('POST', { title: 'Old cut', seconds: 2, fps: 30 }))).json()
    const id = made.project.id as string
    expect((await at(`projects/${id}/costs`)).status).toBe(200)
    expect(await (await at(`projects/${id}/checks/look`)).json()).toEqual({ check: null })
    expect((await at(`projects/${id}`, json('DELETE'))).status).toBe(200)
    for (const path of [`projects/${id}/costs`, `projects/${id}/checks/look`, 'projects/x/costs', 'projects/00000000-0000-4000-8000-000000000000/checks/review']) {
      const res = await at(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('refuses a workspace with the Studio switched off (as the other switched-off features), and reads the switch once a while', async () => {
    forgetStudioSwitches()
    ;(env.tables as Record<string, unknown[]>).workspace = [{ id: WS, settings: { feature_overrides: { studio: 'off' } } }]
    const off = await at('bootstrap')
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'The Studio is not enabled for this workspace.', code: 'FEATURE_DISABLED' })
    // The file route too.
    expect((await at(`file/${WS}/assets/x.png`)).status).toBe(403)
    // Read again only after a while: switched back on, the cached answer holds for now, then the new one.
    ;(env.tables as Record<string, unknown[]>).workspace = [{ id: WS, settings: {} }]
    expect((await at('bootstrap')).status).toBe(403)
    forgetStudioSwitches()
    expect((await at('bootstrap')).status).toBe(200)
  })

  it('answers one calm 503 where the Studio’s tables are not in the database, without an error line per request', async () => {
    const real = h.svc as unknown as { from: (t: string) => unknown; storage: unknown }
    const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.studio_video' in the schema cache" } }
    const broken = (): unknown =>
      new Proxy(() => undefined, {
        get: (_t, prop) => (prop === 'then' ? (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(missing).then(ok, bad) : prop === 'maybeSingle' || prop === 'single' ? async () => missing : () => broken()),
      })
    h.svc = { from: (t: string) => (t.startsWith('studio_') ? broken() : real.from(t)), rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }), storage: real.storage } as unknown as SupabaseClient
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const path of ['bootstrap', 'projects', 'campaigns']) {
      const res = await at(path)
      expect(res.status, path).toBe(503)
      expect(await res.json(), path).toEqual({ error: 'The Studio is not set up on this server yet.', code: 'STUDIO_NOT_SET_UP' })
    }
    expect(console.error).not.toHaveBeenCalled()
    expect(warned.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('refuses guests', async () => {
    h.member = { role: 'guest' }
    const res = await at('bootstrap')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Guests can't use the Studio in this workspace.")
  })

  it('makes a blank video, saves it, and refuses a stale save with the editor’s sentence', async () => {
    const made = await (await at('projects/blank', json('POST', { title: 'Launch', seconds: 3, fps: 30 }))).json()
    expect(made.project.title).toBe('Launch')
    const boot = await (await at(`bootstrap?video=${made.project.id}`)).json()
    expect(boot).toMatchObject({ project: { id: made.project.id }, sessionToken: 'studio-session', workspaceId: WS })
    const digest = (await (await at(`projects/${made.project.id}/digest`)).json()).projectDigest
    expect(digest).toBe(boot.projectDigest)
    const ok = await at(`projects/${made.project.id}`, json('PUT', { project: { ...made.project, title: 'Launch v2' }, expectedDigest: digest }))
    expect(ok.status).toBe(200)
    const stale = await at(`projects/${made.project.id}`, json('PUT', { project: { ...made.project, title: 'Late' }, expectedDigest: digest }))
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toMatch(/changed in another editor tab/)
    const wrongId = await at(`projects/${made.project.id}`, json('PUT', { project: { ...made.project, id: crypto.randomUUID() } }))
    expect((await wrongId.json()).error).toBe('Project id differs from route')
    const campaigns = await (await at('campaigns')).json()
    expect(campaigns.campaigns[0]).toMatchObject({ id: `single-${made.project.id}`, single: true })
    const checks = await (await at(`projects/${made.project.id}/checklist`)).json()
    expect(Array.isArray(checks.checks)).toBe(true)
    // No thumbnail yet: 404, and one job queued for it, once.
    expect((await at(`projects/${made.project.id}/thumbnail.jpg`)).status).toBe(404)
    expect((await at(`projects/${made.project.id}/thumbnail.jpg`)).status).toBe(404)
    expect(env.tables.studio_job!.filter((j) => j.kind === 'thumbnail')).toHaveLength(1)
  })

  it('answers 404 and 405 as sentences, and bad JSON as 400', async () => {
    const missing = await at('nothing/here')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'Not found' })
    expect((await at('campaigns', json('DELETE'))).status).toBe(405)
    const bad = await at('presets', { method: 'POST', body: '{nope' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('The request body is not JSON.')
  })

  it('answers what is not built yet in the shapes the editor reads', async () => {
    expect(await (await at('fonts')).json()).toEqual({ installed: [], faces: [] })
    expect(await (await at('transcription/config')).json()).toEqual({ config: null, ready: true, serviceFee: 0 })
    expect((await (await at('browser/places')).json()).places.map((p: { id: string }) => p.id)).toEqual(['library', 'files'])
    // The Mac's wallpapers and local speech models have no meaning here: gone, not placeholders.
    expect((await at('wallpapers')).status).toBe(404)
    expect((await at('transcription/models')).status).toBe(404)
    const made = await (await at('projects/blank', json('POST', { title: 'Costs', seconds: 2, fps: 30 }))).json()
    const costs = await (await at(`projects/${made.project.id}/costs`)).json()
    expect(costs).toMatchObject({ projectId: made.project.id, usd: 0, entries: [], rates: { higgsfield: { usdPerCredit: expect.any(Number) } } })
    // Narration is built (voiceover.ts): with no voice chosen, it asks for one and spends nothing.
    const generate = await at('voiceover/generate', json('POST', { text: 'Hi', allowPaid: false }))
    expect(generate.status).toBe(400)
    expect(await generate.json()).toMatchObject({ error: 'Choose a voice for narration first.', code: 'NO_VOICE' })
  })
})

describe('the file route', () => {
  it('serves members of that workspace only, with ranges', async () => {
    const key = `assets/${'a'.repeat(64)}.png`
    env.storage.put(`${WS}/${key}/0`, Uint8Array.from([1, 2, 3, 4]))
    env.tables.studio_blob = [{ workspace_id: WS, key, bytes: 4, parts: 1, part_bytes: 32, content_type: 'image/png', sha256: null }]
    vi.stubGlobal('fetch', async (url: string, init: { headers: { range: string } }) => {
      const path = url.replace('fake://read/', '')
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.range)!
      return new Response(env.storage.objects.get(path)!.bytes.slice(Number(a), Number(b) + 1), { status: 206 })
    })
    const res = await at(`file/${WS}/${key}`, { headers: { range: 'bytes=1-2' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600, immutable')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3])
    expect((await at(`file/${OTHER_WS}/${key}`)).status).toBe(403)
    expect((await at(`file/${WS}/assets/missing.png`)).status).toBe(404)
    expect((await at(`file/${WS}/..%2Fescape`)).status).toBe(400)
    vi.unstubAllGlobals()
  })

  it('holds a device token pinned to one workspace to that workspace’s files, though its person is in both', async () => {
    env.tables.member!.push({ id: 'm2', user_id: AVA, workspace_id: OTHER_WS, role: 'member' })
    const key = `assets/${'b'.repeat(64)}.png`
    env.tables.studio_blob = [{ workspace_id: WS, key, bytes: 4, parts: 1, part_bytes: 32, content_type: 'image/png', sha256: null }]
    h.pin = OTHER_WS
    const refused = await at(`file/${WS}/${key}`, { method: 'HEAD' })
    expect(refused.status).toBe(403)
    h.pin = WS
    expect((await at(`file/${WS}/${key}`, { method: 'HEAD' })).status).toBe(200)
    // A session cookie (no pin) reaches every workspace its person is a member of.
    h.pin = null
    expect((await at(`file/${WS}/${key}`, { method: 'HEAD' })).status).toBe(200)
  })
})

describe('the worker’s routes', () => {
  const call = (handler: (r: Request, a: never) => Promise<Response>, body: unknown, auth = 'Bearer dev-studio-worker', id?: string) =>
    handler(new Request('http://localhost/api/internal/studio/x', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never)

  it('wants the secret: 503 in production without one, 401 without it, the dev secret locally', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('STUDIO_WORKER_SECRET', '')
    const off = await call(claim, { workerId: 'w', kinds: ['import'] })
    expect(off.status).toBe(503)
    expect((await off.json()).error).toMatch(/STUDIO_WORKER_SECRET/)
    vi.stubEnv('STUDIO_WORKER_SECRET', 'a-real-secret-of-its-own')
    expect((await call(claim, { workerId: 'w', kinds: ['import'] })).status).toBe(401)
    expect((await call(claim, { workerId: 'w', kinds: ['import'] }, 'Bearer a-real-secret-of-its-own')).status).toBe(200)
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUDIO_WORKER_SECRET', '')
    expect(await (await call(claim, { workerId: 'w', kinds: ['import'] })).json()).toEqual({ job: null })
    expect((await call(claim, { workerId: 'w', kinds: ['juggle'] })).status).toBe(400)
  })

  it('reaches only the blobs of a job it holds, and files what it made', async () => {
    env.tables.studio_job = [{ id: '11111111-2222-4333-8444-555555555555', workspace_id: WS, video_id: null, kind: 'thumbnail', status: 'queued', progress: 0, logs: [], input: { key: 'thumbs/v.jpg' }, result: null, error: null, cancel_requested: false, worker_id: null, attempts: 0, created_at: '2031-01-01T00:00:00Z', updated_at: '2031-01-01T00:00:00Z' }]
    const jobId = '11111111-2222-4333-8444-555555555555'
    expect((await call(write, { jobId, workerId: 'w', key: 'thumbs/v.jpg', bytes: 3, contentType: 'image/jpeg' })).status).toBe(409)
    const claimed = await (await call(claim, { workerId: 'w', kinds: ['thumbnail'] })).json()
    expect(claimed.job).toMatchObject({ id: jobId, workspaceId: WS, kind: 'thumbnail' })
    const ticket = await (await call(write, { jobId, workerId: 'w', key: 'thumbs/v.jpg', bytes: 3, contentType: 'image/jpeg' })).json()
    expect(ticket.parts[0]).toMatchObject({ index: 0, bytes: 3, url: `fake://upload/${WS}/thumbs/v.jpg/0` })
    expect((await call(write, { jobId, workerId: 'someone-else', key: 'thumbs/v.jpg', bytes: 3, contentType: 'image/jpeg' })).status).toBe(409)
    // A result naming a file it did not store, or a key it was not given, is refused.
    expect((await call(complete, { workerId: 'w', result: { key: 'thumbs/v.jpg' } }, undefined, jobId)).status).toBe(422)
    env.tables.studio_job![0]!.status = 'running'
    env.storage.put(`${WS}/thumbs/v.jpg/0`, Uint8Array.from([1, 2, 3]))
    expect((await call(commit, { jobId, workerId: 'w', key: 'thumbs/v.jpg' })).status).toBe(200)
    expect((await call(complete, { workerId: 'w', result: { key: 'thumbs/other.jpg' } }, undefined, jobId)).status).toBe(422)
    env.tables.studio_job![0]!.status = 'running'
    expect((await call(complete, { workerId: 'w', result: { key: 'thumbs/v.jpg' } }, undefined, jobId)).status).toBe(200)
    expect(env.tables.studio_job![0]).toMatchObject({ status: 'completed', progress: 1 })
  })
})
