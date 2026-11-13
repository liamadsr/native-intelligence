/**
 * An export run on the person's own computer (local-jobs.ts, local-http.ts, local-token.ts): queued from the editor
 * with the desktop app's render version, taken and worked by the app with a token for that one job, through its own
 * door; read only the files the frozen project names, write only its attempt's video, which must be an MP4; filed and
 * read as an export everywhere an export is read. Every refusal the door makes, the stale re-queue and the resume by id,
 * and "Finish on the server". Made-up people, workspaces and bytes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const delivered = vi.hoisted(() => ({ finished: [] as string[], failed: [] as string[] }))
vi.mock('@/lib/work/recorder', () => ({
  startWork: async (_s: unknown, row: { title: string }) => ({ inert: false, finish: async () => void delivered.finished.push(row.title), fail: async () => void delivered.failed.push(row.title) }),
}))
vi.mock('@/lib/work/agent-run-mirror', () => ({ resolveMemberId: async () => 'member-ava' }))

import { createBlobWrite } from '../blobs'
import { createBlankVideo } from '../blank'
import { activeJob, cancelJob, claimJob, getJob, MAX_OPEN_EXPORTS, queueJob, toEditorJob, videoExports } from '../jobs'
import { ClaimBody, LOCAL_TOKEN_SECONDS, STUDIO_JOB_KINDS, type LocalTaken } from '../job-contract'
import { handleLocalRunner, LOCAL_CALLS_PER_MINUTE, resetLocalCalls } from '../local-http'
import { localExportKey, localToken, moveToServer, startsLikeMp4 } from '../local-jobs'
import { signLocalToken, verifyLocalToken } from '../local-token'
import { CODE_SCENES_REFUSAL, queueExport, RENDER_VERSION_REFUSAL, startExport } from '../media'
import { STUDIO_RENDER_VERSION } from '../../engine/render-version'
import { jobView } from '../../agent/job-tools'
import { signModelToken } from '@/lib/local-agent/tokens'
import { AVA, fakeContext, OTHER_WS, WS } from './fake'

const BEN = 'b2b2b2b2-1111-4222-8333-777777777777'
const CAL = 'c3c3c3c3-1111-4222-8333-888888888888'
const SECRET_ENV = 'LOCAL_AGENT_TOKEN_SECRET'
const before = process.env[SECRET_ENV]
process.env[SECRET_ENV] = 'made-up-local-export-secret-0123456789'
afterAll(() => {
  if (before === undefined) delete process.env[SECRET_ENV]
  else process.env[SECRET_ENV] = before
})

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext({
    member: [
      { id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'member' },
      { id: 'm-ben', workspace_id: WS, user_id: BEN, role: 'member' },
      { id: 'm-cal', workspace_id: WS, user_id: CAL, role: 'guest' },
    ],
  })
  resetLocalCalls()
  delivered.finished.length = 0
  delivered.failed.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const rows = () => env.tables.studio_job ?? []
const row = (id: string) => rows().find((j) => j.id === id)!

/** A call of the desktop app through its door. */
async function call(op: string, token: string | null, body: unknown = {}, init: { raw?: string; headers?: Record<string, string> } = {}) {
  const request = new Request(`http://localhost/api/local-agent/studio-export/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  })
  const res = await handleLocalRunner(request, op.split('/'), deps())
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** An MP4's first bytes, then filler. */
const mp4 = (bytes: number) => {
  const out = new Uint8Array(bytes).fill(7)
  out.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  return out
}

/** A saved video with one library file, queued for this computer: the job and the editor's token. */
async function queued(options: { as?: string } = {}) {
  const ctx = options.as ? { ...env.ctx, userId: options.as } : env.ctx
  const video = await createBlankVideo(ctx, { title: 'Spring launch', seconds: 2, fps: 30 })
  const asset = { id: 'd'.repeat(64), name: 'Clip.mp4', kind: 'video', file: `assets/${'d'.repeat(64)}.mp4`, sha256: 'd'.repeat(64), bytes: 10, width: 640, height: 360, sourceFps: 30, sourceFrames: 60, durationSeconds: 2, hasAudio: false, sourceCursorHidden: false }
  const project = { ...video, assets: [...(video.assets ?? []), asset] }
  // The library file is stored, as the editor's import would have.
  const write = await createBlobWrite(ctx, { key: asset.file, bytes: 10, contentType: 'video/mp4', sha256: asset.sha256 })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes).fill(1))
  const { commitBlob } = await import('../blobs')
  await commitBlob(ctx, asset.file)
  // validateVideo would refuse a library file it does not know: registered first.
  const { registerAsset } = await import('../assets')
  await registerAsset(ctx, asset as never)
  const started = await startExport(ctx, project, { where: 'computer', renderVersion: STUDIO_RENDER_VERSION })
  return { video, asset, job: started.job, token: started.local!.token }
}

/** Taken by the app: the job and the token that holds it. */
async function taken(token: string) {
  const res = await call('take', token)
  expect(res.status).toBe(200)
  return res.body as unknown as LocalTaken
}

/** Store and commit the attempt's video through the door. */
async function upload(token: string, key: string, bytes: Uint8Array) {
  const write = await call('blobs/write', token, { key, bytes: bytes.byteLength, contentType: 'video/mp4' })
  expect(write.status).toBe(200)
  for (const part of (write.body.parts as { url: string }[])) env.storage.put(part.url.replace('fake://upload/', ''), bytes)
  return call('blobs/commit', token, { key })
}

describe('queueing an export for this computer', () => {
  it('queues a local export the editor reads as an export on this computer, with a token for that job only', async () => {
    const { job, token } = await queued()
    expect(job).toMatchObject({ kind: 'export', where: 'computer', status: 'running', logs: ['Waiting for the Studio app on this computer…'] })
    expect(row(job.id)).toMatchObject({ kind: 'local-export', status: 'queued', created_by: AVA, input: { source: 'editor', renderVersion: STUDIO_RENDER_VERSION } })
    const check = verifyLocalToken(token)
    expect(check).toMatchObject({ ok: true, claims: { jid: job.id, uid: AVA, wid: WS } })
    expect(check.ok && check.claims.w).toBeUndefined()
    expect(check.ok && check.claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(LOCAL_TOKEN_SECONDS)
  })

  it('refuses a computer whose engine is another version, and a video with code scenes', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring launch', seconds: 2, fps: 30 })
    await expect(startExport(env.ctx, video, { where: 'computer', renderVersion: '1999-01-01.1' })).rejects.toMatchObject({ status: 409, code: 'RENDER_VERSION', message: RENDER_VERSION_REFUSAL })
    await expect(startExport(env.ctx, video, { where: 'computer' })).rejects.toMatchObject({ code: 'RENDER_VERSION' })
    const scene = { ...video, layers: [{ id: 'l1', kind: 'scene', start: 0, duration: 30, style: { scene: { id: 'abcdef0123456789', name: 'Chart' } } }] }
    await expect(startExport(env.ctx, scene, { where: 'computer', renderVersion: STUDIO_RENDER_VERSION })).rejects.toMatchObject({ code: expect.stringMatching(/CODE_SCENES|INVALID/) })
    expect(CODE_SCENES_REFUSAL).toMatch(/server/)
    expect(rows().filter((j) => j.kind === 'local-export')).toHaveLength(0)
  })

  it('keeps the agent’s exports on the server', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring launch', seconds: 2, fps: 30 })
    const job = await queueExport(env.ctx, video, 'agent')
    expect(row(job.id).kind).toBe('export')
  })

  it('is never a server worker’s to claim', async () => {
    const { job } = await queued()
    expect(ClaimBody.safeParse({ workerId: 'w', kinds: ['local-export'] }).success).toBe(false)
    expect((STUDIO_JOB_KINDS as readonly string[]).includes('local-export')).toBe(false)
    expect(await claimJob(deps(), 'w', [...STUDIO_JOB_KINDS])).toBeNull()
    expect(row(job.id).status).toBe('queued')
  })

  it('counts in the workspace’s open jobs but not in its exports', async () => {
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) await queued()
    // Five local exports open: a server export may still be queued.
    const video = await createBlankVideo(env.ctx, { title: 'More', seconds: 2, fps: 30 })
    await expect(startExport(env.ctx, video)).resolves.toBeTruthy()
  })
})

describe('the desktop app working it', () => {
  it('takes, reports, reads its files, stores its video and finishes: an export on this computer everywhere it is read', async () => {
    const { job, asset, token, video } = await queued()
    const t = await taken(token)
    expect(t.job).toMatchObject({ id: job.id, kind: 'local-export', workspaceId: WS, videoId: video.id, attempts: 1, input: { title: 'Spring launch' } })
    expect(row(job.id)).toMatchObject({ status: 'running', attempts: 1, worker_id: expect.stringMatching(new RegExp(`^local:${AVA}:`)) })
    expect(verifyLocalToken(t.token)).toMatchObject({ ok: true, claims: { w: row(job.id).worker_id } })

    // The editor sees it running here, as an export on this computer.
    expect(await activeJob(env.ctx, AVA)).toMatchObject({ id: job.id, kind: 'export', where: 'computer' })

    const progress = await call('progress', t.token, { progress: 0.4, log: 'Rendering' })
    expect(progress).toMatchObject({ status: 200, body: { cancelRequested: false, token: expect.stringMatching(/^ls1\./) } })
    expect(row(job.id)).toMatchObject({ progress: 0.4, logs: ['Rendering'] })
    const fresh = progress.body.token as string

    const read = await call('blobs/read', fresh, { key: asset.file })
    expect(read).toMatchObject({ status: 200, body: { key: asset.file, parts: [expect.objectContaining({ url: expect.any(String) })] } })

    const key = localExportKey({ id: job.id, attempts: 1 })
    expect(await upload(fresh, key, mp4(40))).toMatchObject({ status: 200 })
    const done = await call('complete', fresh, { result: { key, bytes: 40, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })
    expect(done).toMatchObject({ status: 200, body: { ok: true } })

    const editor = await getJob(env.ctx, job.id)
    expect(editor).toMatchObject({ kind: 'export', where: 'computer', status: 'completed', downloadUrl: `/api/account/studio/file/${WS}/${key}?download=Spring%20launch.mp4` })
    expect((await videoExports(env.ctx, video.id)).exports.map((e) => e.id)).toEqual([job.id])
    expect(jobView({ ...row(job.id), input: {} } as never)).toMatchObject({ kind: 'export', where: 'computer', megabytes: expect.any(Number) })
    // Delivered as an export is (nobody watched it finish).
    expect(delivered.finished).toEqual(['Exporting “Spring launch”'])
    // Ended: the token does nothing more.
    expect((await call('progress', fresh, { progress: 1 })).status).toBe(409)
  })

  it('asks the app to stop when the person cancels, and ends cancelled', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    await cancelJob(env.ctx, job.id)
    expect((await call('progress', t.token, { progress: 0.5 })).body).toMatchObject({ cancelRequested: true })
    expect((await call('fail', t.token, { error: 'Cancelled' })).status).toBe(200)
    expect(row(job.id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
  })

  it('fails with the app’s reason, delivered as a failed export', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    expect((await call('fail', t.token, { error: 'The computer ran out of disk.' })).status).toBe(200)
    expect(row(job.id)).toMatchObject({ status: 'failed', error: 'The computer ran out of disk.' })
    expect(delivered.failed).toHaveLength(1)
  })
})

describe('what the door refuses', () => {
  it('a missing, forged, expired or malformed token, before reading the body', async () => {
    const { job } = await queued()
    expect((await call('take', null)).status).toBe(401)
    const forged = signLocalToken({ jid: job.id, uid: AVA, wid: WS }, { secret: 'another-secret-entirely-0123456789' }).token
    expect((await call('take', forged)).status).toBe(401)
    const expired = signLocalToken({ jid: job.id, uid: AVA, wid: WS }, { now: Date.now() - 2 * LOCAL_TOKEN_SECONDS * 1000 }).token
    expect(await call('take', expired)).toMatchObject({ status: 401, body: { error: expect.stringMatching(/run out/) } })
    // Unauthorized even with a body that is not JSON at all: the body is never read.
    expect((await call('take', 'ls1.x.y', undefined, { raw: '{not json' })).status).toBe(401)
    // A model token of the local agent, on the same key, is not one of these (its own MAC domain), nor this one of those.
    const model = signModelToken({ sid: job.id, uid: AVA, wid: WS }).token
    expect((await call('take', model)).status).toBe(401)
    const { verifyModelToken } = await import('@/lib/local-agent/tokens')
    expect(verifyModelToken(signLocalToken({ jid: job.id, uid: AVA, wid: WS }).token).ok).toBe(false)
  })

  it('a token for another job, another person’s job, another workspace, or a guest', async () => {
    const mine = await queued()
    const bens = await queued({ as: BEN })
    // A token naming Ben's job but Ava as its person: not hers.
    expect((await call('take', signLocalToken({ jid: bens.job.id, uid: AVA, wid: WS }).token)).status).toBe(409)
    // Ava can't be handed a token for Ben's job at all.
    await expect(localToken(env.ctx, bens.job.id)).rejects.toMatchObject({ status: 404 })
    // Her job in another workspace: nothing there.
    expect((await call('take', signLocalToken({ jid: mine.job.id, uid: AVA, wid: OTHER_WS }).token)).status).toBe(409)
    // A job id that is not hers at all.
    expect((await call('take', signLocalToken({ jid: '0f0f0f0f-1111-4222-8333-000000000000', uid: AVA, wid: WS }).token)).status).toBe(409)
    // A guest is never a Studio maker, whatever the token says (the editor's door refuses guests before this).
    row(mine.job.id).created_by = CAL
    expect((await call('take', signLocalToken({ jid: mine.job.id, uid: CAL, wid: WS }).token)).status).toBe(403)
    // Nor someone who left the workspace.
    row(mine.job.id).created_by = AVA
    env.tables.member = env.tables.member!.filter((m) => m.user_id !== AVA)
    expect((await call('take', mine.token)).status).toBe(403)
  })

  it('the editor’s token anywhere but take, and the held token once another attempt holds the job', async () => {
    const { job, asset, token } = await queued()
    expect((await call('progress', token, { progress: 0.1 })).status).toBe(409)
    const t = await taken(token)
    // Taken: not taken twice.
    expect((await call('take', token)).status).toBe(409)
    expect((await call('blobs/read', token, { key: asset.file })).status).toBe(409)
    expect((await call('progress', t.token, { progress: 0.1 })).status).toBe(200)
  })

  it('reading a file the frozen project does not name, or a take’s pieces', async () => {
    const { token } = await queued()
    const t = await taken(token)
    // Another library file of the workspace, stored but not in this video.
    const other = `assets/${'e'.repeat(64)}.mp4`
    const write = await createBlobWrite(env.ctx, { key: other, bytes: 4, contentType: 'video/mp4', sha256: 'e'.repeat(64) })
    for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(4))
    expect((await call('blobs/read', t.token, { key: other })).body).toMatchObject({ code: 'NOT_YOURS' })
    expect((await call('blobs/read', t.token, { key: 'live/5a5a5a5a-1111-4222-8333-999999999999/screen' })).body).toMatchObject({ code: 'NOT_YOURS' })
    expect((await call('blobs/read', t.token, { key: 'exports/x/1/video.mp4' })).body).toMatchObject({ code: 'NOT_YOURS' })
    expect((await call('blobs/read', t.token, { key: '../secrets' })).status).toBe(400)
  })

  it('writing anywhere but this attempt’s video, anything but an MP4, or more than an export may be', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    expect((await call('blobs/write', t.token, { key: `assets/${'f'.repeat(64)}.mp4`, bytes: 10, contentType: 'video/mp4' })).body).toMatchObject({ code: 'NOT_YOURS' })
    expect((await call('blobs/write', t.token, { key: localExportKey({ id: job.id, attempts: 2 }), bytes: 10, contentType: 'video/mp4' })).body).toMatchObject({ code: 'NOT_YOURS' })
    expect((await call('blobs/write', t.token, { key, bytes: 10, contentType: 'text/html' })).status).toBe(400)
    expect((await call('blobs/write', t.token, { key, bytes: 9 * 1024 ** 3, contentType: 'video/mp4' })).status).toBe(400)
    // Uploaded bytes that are not an MP4: refused at commit, and removed.
    const commit = await upload(t.token, key, new Uint8Array(40).fill(0x3c))
    expect(commit).toMatchObject({ status: 422, body: { code: 'NOT_MP4' } })
    expect(env.tables.studio_blob?.some((b) => b.key === key)).toBeFalsy()
  })

  it('a completion that is not what was stored', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    await upload(t.token, key, mp4(40))
    const lie = await call('complete', t.token, { result: { key, bytes: 41, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })
    expect(lie).toMatchObject({ status: 422, body: { code: 'RESULT_REFUSED' } })
    expect(row(job.id).status).toBe('failed')
  })

  it('a completion naming another file, or nothing stored', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const elsewhere = await call('complete', t.token, { result: { key: `exports/${job.id}/2/video.mp4`, bytes: 40, width: 1, height: 1, fps: 30, durationSeconds: 2 } })
    expect(elsewhere).toMatchObject({ status: 422 })
    expect(row(job.id).status).toBe('failed')
  })

  it('a body past its cap, an unknown call, and too many calls', async () => {
    const { token } = await queued()
    const t = await taken(token)
    expect((await call('progress', t.token, undefined, { raw: JSON.stringify({ progress: 0.1, log: 'x'.repeat(70 * 1024) }) })).status).toBe(413)
    expect((await call('progress', t.token, { progress: 0.1, extra: true })).status).toBe(400)
    expect((await call('jobs/claim', t.token, {})).status).toBe(404)
    for (let i = 0; i < LOCAL_CALLS_PER_MINUTE; i++) await call('nothing', t.token)
    expect((await call('progress', t.token, { progress: 0.2 })).status).toBe(429)
  })
})

describe('a computer that goes quiet', () => {
  it('goes back in the queue, is taken again by id as a new attempt, and fails after three', async () => {
    const { job, token } = await queued()
    let t = await taken(token)
    const quiet = () => Object.assign(row(job.id), { heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(), claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    quiet()
    // Any server worker asking for work runs the stale rule: back in the queue, no worker of its own.
    expect(await claimJob(deps(), 'server-worker', ['export'])).toBeNull()
    expect(row(job.id)).toMatchObject({ status: 'queued', worker_id: null, attempts: 1 })
    // The old attempt's token is done.
    expect((await call('progress', t.token, { progress: 0.5 })).status).toBe(409)
    // The editor asks for a new token for its job; the app takes it again: attempt 2, its own key.
    for (const attempt of [2, 3]) {
      const again = await localToken(env.ctx, job.id)
      t = await taken(again.token)
      expect(t.job.attempts).toBe(attempt)
      expect((await call('blobs/write', t.token, { key: localExportKey({ id: job.id, attempts: attempt }), bytes: 40, contentType: 'video/mp4' })).status).toBe(200)
      quiet()
      await claimJob(deps(), 'server-worker', ['export'])
    }
    expect(row(job.id)).toMatchObject({ status: 'failed' })
    await expect(localToken(env.ctx, job.id)).rejects.toMatchObject({ code: 'ENDED' })
  })
})

describe('finishing on the server', () => {
  it('moves a queued local export to the server, where a worker takes it', async () => {
    const { job, token } = await queued()
    const { job: moved } = await moveToServer(env.ctx, job.id)
    expect(moved).toMatchObject({ kind: 'export', where: 'server' })
    expect((await claimJob(deps(), 'server-worker', ['export']))?.id).toBe(job.id)
    // The computer's token no longer takes it.
    expect((await call('take', token)).status).toBe(409)
  })

  it('not one running on the computer, not another person’s, not past the export cap', async () => {
    const running = await queued()
    await taken(running.token)
    await expect(moveToServer(env.ctx, running.job.id)).rejects.toMatchObject({ code: 'RUNNING' })
    const bens = await queued({ as: BEN })
    await expect(moveToServer(env.ctx, bens.job.id)).rejects.toMatchObject({ status: 404 })
    const waiting = await queued()
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) await queueJob(env.ctx, 'export', { project: {} as never, title: 'x' })
    await expect(moveToServer(env.ctx, waiting.job.id)).rejects.toMatchObject({ status: 429 })
    expect(row(waiting.job.id).kind).toBe('local-export')
  })
})

describe('pieces', () => {
  it('knows an MP4 by its first box', () => {
    expect(startsLikeMp4(mp4(12))).toBe(true)
    expect(startsLikeMp4(new Uint8Array(12))).toBe(false)
    expect(startsLikeMp4(new TextEncoder().encode('<html><body>'))).toBe(false)
  })

  it('reads a server export as one on the server', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring launch', seconds: 2, fps: 30 })
    expect((await startExport(env.ctx, video)).job).toMatchObject({ kind: 'export', where: 'server' })
    expect(toEditorJob({ ...rows()[0]!, kind: 'transcribe' } as never).where).toBeUndefined()
  })
})
