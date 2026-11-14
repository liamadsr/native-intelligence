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
import { activeJob, cancelJob, claimJob, getJob, MAX_OPEN_EXPORTS, queueJob, toEditorJob, UNTAKEN, videoExports } from '../jobs'
import { ClaimBody, LOCAL_TOKEN_SECONDS, MAX_OPEN_LOCAL_EXPORTS, STUDIO_JOB_KINDS, type LocalTaken } from '../job-contract'
import { handleLocalRunner, LOCAL_CALLS_PER_MINUTE, resetLocalCalls } from '../local-http'
import { LOCAL_RETAKE_AFTER_MS, LOCAL_RUN_FLOOR_MS, localExportKey, localReadable, localJob, localRunLimit, localToken, moveToServer, readAllowance, scrubLocalText, startsLikeMp4 } from '../local-jobs'
import { getBlob, PENDING } from '../blobs'
import { sweepStudio } from '../sweep'
import { forgetStudioSwitches } from '../auth'
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
    const { job } = await queued()
    const input = row(job.id).input as never
    for (let i = 1; i < MAX_OPEN_EXPORTS; i++) await queueJob(env.ctx, 'local-export', input)
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

  it('ends at once when the person cancels, whether or not the computer ever reports again', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const editor = await cancelJob(env.ctx, job.id)
    // No worker of ours would notice a request, and a runner stopped outright never reports: it is over now.
    expect(editor).toMatchObject({ status: 'cancelled', where: 'computer' })
    expect(row(job.id)).toMatchObject({ status: 'cancelled', cancel_requested: true, error: 'Cancelled.' })
    // A computer still working is refused at its next call, and can neither store nor finish the export.
    expect((await call('progress', t.token, { progress: 0.5 })).body).toMatchObject({ code: 'NOT_HELD' })
    expect((await call('complete', t.token, { result: { kept: 'computer', bytes: 4_000_000, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })).body).toMatchObject({ code: 'NOT_HELD' })
    expect(row(job.id).status).toBe('cancelled')
    // It no longer counts against the person's open exports, and cannot be taken or continued.
    await expect(localToken(env.ctx, job.id)).rejects.toMatchObject({ code: 'ENDED' })
    expect((await call('take', token)).body).toMatchObject({ code: 'ENDED' })
  })

  it('a cancel does not undo an export the computer finished first', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    expect((await call('complete', t.token, { result: { kept: 'computer', bytes: 4_000_000, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })).status).toBe(200)
    expect(await cancelJob(env.ctx, job.id)).toMatchObject({ status: 'completed', kept: 'computer' })
    expect(row(job.id).status).toBe('completed')
  })

  it('"Continue on this computer": a running export whose computer went quiet is taken again by its person, a live one is not', async () => {
    const { job, token } = await queued()
    const first = await taken(token)
    // Its computer reported a moment ago: not to be taken from it.
    expect((await call('take', token)).body).toMatchObject({ code: 'NOT_HELD' })
    expect(row(job.id)).toMatchObject({ attempts: 1, status: 'running' })
    // Quiet for longer than a runner's heartbeat (it was quit, or stopped outright): the person's app takes it again.
    Object.assign(row(job.id), { heartbeat_at: new Date(Date.now() - LOCAL_RETAKE_AFTER_MS - 1000).toISOString() })
    const fresh = (await localToken(env.ctx, job.id)).token
    const second = await taken(fresh)
    expect(second.job.attempts).toBe(2)
    expect(row(job.id)).toMatchObject({ status: 'running', attempts: 2 })
    // The first runner, should it wake, no longer holds it; the second does.
    expect((await call('progress', first.token, { progress: 0.3 })).body).toMatchObject({ code: 'NOT_HELD' })
    expect((await call('progress', second.token, { progress: 0.3 })).status).toBe(200)
    // Never another person's, however quiet, and never one asked to stop.
    Object.assign(row(job.id), { heartbeat_at: new Date(Date.now() - 10 * LOCAL_RETAKE_AFTER_MS).toISOString() })
    expect((await call('take', signLocalToken({ jid: job.id, uid: BEN, wid: WS }).token)).status).toBe(409)
    expect(row(job.id).attempts).toBe(2)
    Object.assign(row(job.id), { cancel_requested: true })
    expect((await call('take', fresh)).body).toMatchObject({ code: 'ENDED' })
  })

  it('a computer that reports between the read and the take keeps its export', async () => {
    const { job, token } = await queued()
    await taken(token)
    const stale = new Date(Date.now() - LOCAL_RETAKE_AFTER_MS - 1000).toISOString()
    Object.assign(row(job.id), { heartbeat_at: stale })
    // Its heartbeat moves just as the second take reads the row: the compare-and-set on the heartbeat refuses.
    const from = env.ctx.supabase.from.bind(env.ctx.supabase)
    let reads = 0
    env.ctx.supabase.from = ((table: string) => {
      const q = from(table as never)
      if (table === 'studio_job' && ++reads === 2) Object.assign(row(job.id), { heartbeat_at: new Date().toISOString() })
      return q
    }) as typeof env.ctx.supabase.from
    const res = await call('take', (await localToken(env.ctx, job.id)).token)
    env.ctx.supabase.from = from
    expect(res.body).toMatchObject({ code: 'NOT_HELD' })
    expect(row(job.id)).toMatchObject({ attempts: 1, status: 'running' })
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
    // A body of this shape MACed under the model tokens' domain, with the same key, is refused: the domains differ.
    const body = Buffer.from(JSON.stringify({ jid: job.id, uid: AVA, wid: WS, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')
    const { createHmac } = await import('node:crypto')
    const crossed = createHmac('sha256', process.env[SECRET_ENV]!).update('dial8.local-agent.model-token.v1:').update(body).digest('base64url')
    expect(verifyLocalToken(`ls1.${body}.${crossed}`)).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('a token for another job, another person’s job, another workspace, or a guest', async () => {
    const mine = await queued()
    const bens = await queued({ as: BEN })
    // A token naming Ben's job but Ava as its person: not hers, at the door and in the fence every call reads.
    expect((await call('take', signLocalToken({ jid: bens.job.id, uid: AVA, wid: WS }).token)).status).toBe(409)
    await expect(localJob(deps(), { jid: bens.job.id, uid: AVA, wid: WS, exp: 0 })).rejects.toMatchObject({ code: 'NOT_HELD' })
    // Nor a server export of hers: only a local export is a computer's.
    const video = await createBlankVideo(env.ctx, { title: 'Server one', seconds: 2, fps: 30 })
    const server = await queueExport(env.ctx, video, 'editor')
    await expect(localJob(deps(), { jid: server.id, uid: AVA, wid: WS, exp: 0 })).rejects.toMatchObject({ code: 'NOT_HELD' })
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
  it('moves a queued local export to the server as a new export, where a worker takes it', async () => {
    const { job, token } = await queued()
    const { job: moved, replaces } = await moveToServer(env.ctx, job.id)
    expect(moved).toMatchObject({ kind: 'export', where: 'server', status: 'running' })
    expect(replaces).toBe(job.id)
    expect(row(job.id)).toMatchObject({ kind: 'local-export', status: 'cancelled', error: 'Moved to our server.' })
    expect(row(moved.id)).toMatchObject({ kind: 'export', attempts: 0, input: { title: 'Spring launch', source: 'editor' } })
    expect((row(moved.id).input as Record<string, unknown>).renderVersion).toBeUndefined()
    expect((await claimJob(deps(), 'server-worker', ['export']))?.id).toBe(moved.id)
    // The computer's token no longer takes it.
    expect((await call('take', token)).status).toBe(409)
  })

  it('moves one a computer holds too (it slept, or the person would rather not wait): the computer no longer holds it', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    expect((await call('progress', t.token, { progress: 0.4 })).status).toBe(200)
    const { job: moved, replaces } = await moveToServer(env.ctx, job.id)
    expect(replaces).toBe(job.id)
    expect(moved).toMatchObject({ kind: 'export', where: 'server', status: 'running' })
    expect(row(job.id)).toMatchObject({ kind: 'local-export', status: 'cancelled', cancel_requested: true, error: 'Moved to our server.' })
    // The computer, still working, is told at its next call, and can neither store nor finish the export.
    expect((await call('progress', t.token, { progress: 0.5 })).body).toMatchObject({ code: 'NOT_HELD' })
    expect((await call('blobs/write', t.token, { key: localExportKey({ id: job.id, attempts: 1 }), bytes: 40, contentType: 'video/mp4' })).body).toMatchObject({ code: 'NOT_HELD' })
    expect((await call('complete', t.token, { result: { kept: 'computer', bytes: 4_000_000, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })).body).toMatchObject({ code: 'NOT_HELD' })
    expect(row(job.id).status).toBe('cancelled')
    // A second press finds it ended, and queues nothing more.
    await expect(moveToServer(env.ctx, job.id)).rejects.toMatchObject({ code: 'ENDED' })
    expect(rows().filter((j) => j.kind === 'export' && !j.cancel_requested)).toHaveLength(1)
  })

  it('not another person’s, not past the export cap', async () => {
    const bens = await queued({ as: BEN })
    await expect(moveToServer(env.ctx, bens.job.id)).rejects.toMatchObject({ status: 404 })
    const waiting = await queued()
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) await queueJob(env.ctx, 'export', { project: {} as never, title: 'x' })
    await expect(moveToServer(env.ctx, waiting.job.id)).rejects.toMatchObject({ status: 429 })
    expect(row(waiting.job.id).kind).toBe('local-export')
    expect(rows().filter((j) => j.kind === 'export' && j.input && (j.input as { title?: string }).title === 'Spring launch')).toHaveLength(0)
  })

  it('never passes the export cap by moving many at once', async () => {
    const { job } = await queued()
    const input = row(job.id).input as never
    const ids = [job.id]
    for (let i = 0; i < MAX_OPEN_EXPORTS + 2; i++) ids.push((await queueJob(env.ctx, 'local-export', input)).id)
    const answers = await Promise.allSettled(ids.map((id) => moveToServer(env.ctx, id)))
    expect(answers.filter((a) => a.status === 'fulfilled')).toHaveLength(MAX_OPEN_EXPORTS)
    expect(rows().filter((j) => j.kind === 'export' && (j.status === 'queued' || j.status === 'running') && !j.cancel_requested)).toHaveLength(MAX_OPEN_EXPORTS)
    // Those refused stay on the computer's side, untouched.
    expect(rows().filter((j) => j.kind === 'local-export' && j.status === 'queued')).toHaveLength(ids.length - MAX_OPEN_EXPORTS)
  })

  it('stops the new server export again when the local one finished meanwhile', async () => {
    const { job } = await queued()
    // The computer finishes it just as the server's export is queued.
    const rpc = env.ctx.supabase.rpc.bind(env.ctx.supabase)
    env.ctx.supabase.rpc = (async (name: string, args: unknown) => {
      const answer = await rpc(name as never, args as never)
      if (name === 'studio_queue_job') Object.assign(row(job.id), { status: 'completed', worker_id: `local:${AVA}:x`, attempts: 1 })
      return answer
    }) as unknown as typeof env.ctx.supabase.rpc
    await expect(moveToServer(env.ctx, job.id)).rejects.toMatchObject({ code: 'ENDED' })
    env.ctx.supabase.rpc = rpc
    expect(row(job.id).status).toBe('completed')
    const server = rows().find((j) => j.kind === 'export')!
    expect(server).toMatchObject({ status: 'cancelled' })
  })
})

describe('the review’s findings', () => {
  it('upload links never replace the stored video, before or after it is filed', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    const write = await call('blobs/write', t.token, { key, bytes: 40, contentType: 'video/mp4' })
    const links = write.body.parts as { url: string; headers: Record<string, string> }[]
    expect(links.every((l) => l.headers['x-upsert'] === 'false')).toBe(true)
    expect(env.storage.putLink(links[0]!, mp4(40))).toBe(true)
    // A second PUT through the same link, before the commit: refused (the part is there).
    expect(env.storage.putLink(links[0]!, new Uint8Array(40).fill(9))).toBe(false)
    expect((await call('blobs/commit', t.token, { key })).status).toBe(200)
    await call('complete', t.token, { result: { key, bytes: 40, width: 16, height: 16, fps: 30, durationSeconds: 1 } })
    // And after it is filed: refused, the file stays what was checked.
    expect(env.storage.putLink(links[0]!, new Uint8Array(4000).fill(9))).toBe(false)
    expect([...(await env.storage.head(`${WS}/${key}/0`, 12))]).toEqual([...mp4(12)])
  })

  it('a refused commit keeps its place and its space until the sweep, then every part goes', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    const write = await call('blobs/write', t.token, { key, bytes: 64 * 1024 * 1024, contentType: 'video/mp4' })
    const links = write.body.parts as { url: string; headers: Record<string, string> }[]
    expect(links).toHaveLength(2)
    env.storage.putLink(links[0]!, new Uint8Array(12).fill(0x3c))
    expect((await call('blobs/commit', t.token, { key })).body).toMatchObject({ code: 'NOT_MP4' })
    // Nothing removed: the pending write still holds the space, the part still holds its place.
    expect(env.tables.studio_record!.some((r) => r.collection === PENDING && r.key === key)).toBe(true)
    expect(env.storage.putLink(links[0]!, mp4(32 * 1024 * 1024))).toBe(false)
    // One set of links an attempt.
    expect((await call('blobs/write', t.token, { key, bytes: 40, contentType: 'video/mp4' })).body).toMatchObject({ code: 'WRITE_PENDING' })
    // The links' other part, stored with something nobody counts.
    env.storage.putLink(links[1]!, new Uint8Array(1000).fill(1))
    await call('fail', t.token, { error: 'Could not upload.' })
    // Ended more than the links' life ago: the sweep takes the parts and the record.
    Object.assign(row(job.id), { updated_at: new Date(Date.now() - 4 * 3600_000).toISOString() })
    const counts = await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(counts.strays).toBeGreaterThan(0)
    expect(await env.storage.list(`${WS}/${key}`)).toEqual([])
    expect(env.tables.studio_record!.some((r) => r.collection === PENDING && r.key === key)).toBe(false)
  })

  it('the sweep removes parts stored again after their file went, parts past a file’s count, and a file whose part changed', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    await upload(t.token, key, mp4(40))
    await call('complete', t.token, { result: { key, bytes: 40, width: 16, height: 16, fps: 30, durationSeconds: 1 } })
    // A part past the file's count, as a link it was never given would store.
    env.storage.put(`${WS}/${key}/7`, new Uint8Array(10))
    Object.assign(row(job.id), { updated_at: new Date(Date.now() - 4 * 3600_000).toISOString() })
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect((await env.storage.list(`${WS}/${key}`)).map((i) => i.name)).toEqual(['0'])
    expect(await getBlob(env.ctx, key)).toBeTruthy()
    // A committed part no longer its size: the file goes (it is not what was checked).
    env.storage.put(`${WS}/${key}/0`, new Uint8Array(999))
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(await getBlob(env.ctx, key)).toBeNull()
    expect(await env.storage.list(`${WS}/${key}`)).toEqual([])
    // The person's own upload, removed by its import while its links still worked, then stored again: swept too.
    const imported = await queueJob(env.ctx, 'import', { uploadKey: 'uploads/0e0e0e0e-1111-4222-8333-999999999999', name: 'x.mp4' })
    Object.assign(row(imported.id), { status: 'completed', updated_at: new Date(Date.now() - 4 * 3600_000).toISOString() })
    env.storage.put(`${WS}/uploads/0e0e0e0e-1111-4222-8333-999999999999/0`, new Uint8Array(100))
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(await env.storage.list(`${WS}/uploads/0e0e0e0e-1111-4222-8333-999999999999`)).toEqual([])
  })

  it('each operation has its own allowance: one write, reads by the files named, progress once a second', async () => {
    const { job, asset, token } = await queued()
    const t = await taken(token)
    const key = localExportKey({ id: job.id, attempts: 1 })
    await upload(t.token, key, mp4(40))
    expect((await call('blobs/write', t.token, { key, bytes: 40, contentType: 'video/mp4' })).body).toMatchObject({ code: 'STORED' })
    // Three reads a file the project names, and ten more, then refused, counted in the database (every process alike).
    const files = localReadable(row(job.id).input as never).size
    expect(files).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < readAllowance(files); i++) expect((await call('blobs/read', t.token, { key: asset.file })).status).toBe(200)
    expect((await call('blobs/read', t.token, { key: asset.file })).body).toMatchObject({ code: 'TOO_MANY_READS' })
    expect((await call('progress', t.token, { progress: 0.1 })).status).toBe(200)
    expect((await call('progress', t.token, { progress: 0.2 })).body).toMatchObject({ code: 'TOO_FAST' })
  })

  it('a local export no computer takes in 15 minutes ends, wherever it would be seen or counted', async () => {
    const { job } = await queued()
    Object.assign(row(job.id), { updated_at: new Date(Date.now() - 16 * 60_000).toISOString() })
    expect(await getJob(env.ctx, job.id)).toMatchObject({ status: 'failed', error: UNTAKEN })
    const other = await queued()
    Object.assign(row(other.job.id), { updated_at: new Date(Date.now() - 16 * 60_000).toISOString() })
    expect(await activeJob(env.ctx, AVA)).toBeNull()
    expect(row(other.job.id).status).toBe('failed')
    const third = await queued()
    Object.assign(row(third.job.id), { updated_at: new Date(Date.now() - 16 * 60_000).toISOString() })
    expect((await sweepStudio(env.ctx.supabase, { storage: env.storage })).untaken).toBe(1)
    expect((await call('take', third.token)).status).toBe(409)
  })

  it('a running attempt may not go on past its time, however often it reports', async () => {
    const { job, token } = await queued()
    const t = await taken(token)
    expect(localRunLimit(row(job.id).input as never)).toBe(LOCAL_RUN_FLOOR_MS)
    Object.assign(row(job.id), { claimed_at: new Date(Date.now() - LOCAL_RUN_FLOOR_MS - 1000).toISOString() })
    expect((await call('progress', t.token, { progress: 0.9 })).body).toMatchObject({ code: 'TOO_LONG' })
    expect(row(job.id)).toMatchObject({ status: 'failed' })
  })

  it('one person has at most a few exports open on their computer', async () => {
    for (let i = 0; i < MAX_OPEN_LOCAL_EXPORTS; i++) await queued()
    await expect(queued()).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_LOCAL' })
    // Another member is not held back by them.
    await expect(queued({ as: BEN })).resolves.toBeTruthy()
  })

  it('kept on the computer: done there, nothing to download from the server', async () => {
    const { job, token, video } = await queued()
    const t = await taken(token)
    expect((await call('complete', t.token, { result: { kept: 'computer', key: 'exports/x/1/video.mp4', bytes: 40, width: 16, height: 16, fps: 30, durationSeconds: 1 } })).status).toBe(400)
    expect((await call('complete', t.token, { result: { kept: 'computer', bytes: 4_000_000, width: 1920, height: 1080, fps: 30, durationSeconds: 2 } })).status).toBe(200)
    const editor = await getJob(env.ctx, job.id)
    expect(editor).toMatchObject({ kind: 'export', where: 'computer', status: 'completed', kept: 'computer' })
    expect(editor.downloadUrl).toBeUndefined()
    // Listed for the person who made it (their computer has the file), with nothing to download; not for anyone else.
    const mine = (await videoExports(env.ctx, video.id)).exports
    expect(mine.map((e) => e.id)).toEqual([job.id])
    expect(mine[0]).toMatchObject({ kept: 'computer', where: 'computer', title: 'Spring launch' })
    expect(mine[0]!.downloadUrl).toBeUndefined()
    expect((await videoExports({ ...env.ctx, userId: BEN }, video.id)).exports).toEqual([])
    expect(jobView({ ...row(job.id), input: {} } as never)).not.toHaveProperty('download_url')
    expect(delivered.finished).toHaveLength(1)
  })

  it('the workspace’s Studio switch holds on every call', async () => {
    const { token } = await queued()
    const t = await taken(token)
    ;(env.tables as Record<string, unknown[]>).workspace = [{ id: WS, settings: { feature_overrides: { studio: 'off' } } }]
    forgetStudioSwitches()
    expect(await call('progress', t.token, { progress: 0.3 })).toMatchObject({ status: 403, body: { code: 'FEATURE_DISABLED' } })
    forgetStudioSwitches()
  })

  it('keeps no path on the computer in what it stores of a failure or a log line', async () => {
    expect(scrubLocalText('Could not write /Users/ava/Movies/Spring launch.mp4: disk full', 500)).toBe('Could not write [a file on the computer] launch.mp4: disk full')
    expect(scrubLocalText('C:\\Users\\Ava\\AppData\\Local\\Temp\\x.mp4 is locked', 500)).not.toMatch(/Users|AppData/)
    expect(scrubLocalText('see https://example.com/help and ~/Library/Logs/app.log', 500)).toBe('see https://example.com/help and [a file on the computer]')
    expect(scrubLocalText('x'.repeat(600), 500)).toHaveLength(500)
    const { job, token } = await queued()
    const t = await taken(token)
    await call('progress', t.token, { progress: 0.2, log: 'Staged /home/ava/.cache/studio/a.mp4' })
    await call('fail', t.token, { error: 'FFmpeg failed reading /Users/ava/Desktop/clip.mov' })
    expect(JSON.stringify(row(job.id))).not.toMatch(/\/(Users|home)\//)
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
