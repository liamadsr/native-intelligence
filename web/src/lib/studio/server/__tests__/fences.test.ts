/**
 * The Studio server's fences, over the in-memory tables (./fake.ts): which workspaces may spend on the worker's
 * provider accounts (STUDIO_PROVIDER_WORKSPACES); a worker's result tied to the bytes its job stored (ownAsset) and
 * its ads files and ids to its own job; a worker's writes kept off files another job committed; the sweep that
 * skips what it can't read and keeps the uploads an open job names; the byte quota and the job caps under requests
 * at once; a paid job whose result comes late still leaves its charge; and a database without the Studio's tables
 * answering one calm refusal. Made-up workspaces, voices and numbers; nothing reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EditorAsset } from '../../engine/contracts'
import { fileAdsResult, listAds, AD_BATCHES } from '../ads'
import { getAssets } from '../assets'
import { createBlobWrite, getBlob, putBlobBytes, workerWriteFence } from '../blobs'
import { currentCapabilities, forgetWorkers, noteWorker, providerWorkspaces, providersAllowed, requireCapability } from '../capabilities'
import { must } from '../context'
import { COSTS_COLLECTION } from '../costs'
import { notSetUpError } from '../errors'
import { quoteBeat, startShot } from '../generation'
import { workerBlobCommit, workerBlobWrite, workerComplete } from '../http'
import { claimJob, completeJob, MAX_OPEN_JOBS, ownAsset, queueJob, type WorkerDeps } from '../jobs'
import { getRecord, putRecord } from '../records'
import { sweepStudio } from '../sweep'
import { bootstrap } from '../videos'
import { generateNarration, listVoices, NARRATION_COLLECTION, previewNarration, startNarration } from '../voiceover'
import { createBlankVideo } from '../blank'
import { openVideo, saveVideo } from '../videos'
import { jobView } from '../../agent/job-tools'
import { fakeContext, fakeDb, fakeStorage, OTHER_WS, WS, AVA } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const deps = (): WorkerDeps => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const sha = (c: string) => c.repeat(64)
const image = (s: string, bytes = 10): EditorAsset => ({ id: s, name: 'Made-up still.png', kind: 'image', file: `assets/${s}.png`, sha256: s, bytes, width: 64, height: 36, hasAudio: false, sourceCursorHidden: false })
const audio = (s: string, bytes = 10): EditorAsset => ({ id: s, name: 'Made-up narration.mp3', kind: 'audio', file: `assets/${s}.mp3`, sha256: s, bytes, durationSeconds: 1, hasAudio: true, sourceCursorHidden: false })

/** A file stored under a key as the worker leaves it: parts put, then committed (a library file with its hash). */
async function store(key: string, bytes = 10, sha256: string | null = /^assets\/([0-9a-f]{64})\./.exec(key)?.[1] ?? null) {
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'application/octet-stream', sha256 })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  const { commitBlob } = await import('../blobs')
  await commitBlob(env.ctx, key)
}

/** A worker request to one of the worker's handlers (the development secret, as under test). */
const workerRequest = (body: unknown) => new Request('http://localhost/api/internal/studio/x', { method: 'POST', headers: { authorization: 'Bearer dev-studio-worker', 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Queue a job of a kind and have this worker claim it. */
async function held(kind: string, input: Record<string, unknown>, worker = 'w-1', videoId: string | null = null) {
  const row = await queueJob(env.ctx, kind as never, input as never, videoId)
  const claimed = await claimJob(deps(), worker, [kind as never])
  expect(claimed?.id).toBe(row.id)
  return row.id
}

describe('the provider accounts are only for the workspaces STUDIO_PROVIDER_WORKSPACES lists', () => {
  it('reads the setting: unset is every workspace outside production and none in it; ids or *', () => {
    expect(providerWorkspaces({ NODE_ENV: 'development' })).toBe('all')
    expect(providerWorkspaces({ NODE_ENV: 'production' })).toEqual(new Set())
    expect(providerWorkspaces({ NODE_ENV: 'production', STUDIO_PROVIDER_WORKSPACES: ' * ' })).toBe('all')
    expect(providersAllowed(WS, { NODE_ENV: 'production', STUDIO_PROVIDER_WORKSPACES: `${OTHER_WS}, ${WS.toUpperCase()}` })).toBe(true)
    expect(providersAllowed(WS, { NODE_ENV: 'production', STUDIO_PROVIDER_WORKSPACES: OTHER_WS })).toBe(false)
    expect(providersAllowed(WS, { NODE_ENV: 'production' })).toBe(false)
    expect(providersAllowed(WS, { NODE_ENV: 'test' })).toBe(true)
  })

  it('a workspace not listed sees no provider capability and may not list voices, preview, narrate, quote or start a shot', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('STUDIO_PROVIDER_WORKSPACES', OTHER_WS)
    noteWorker('mac-1', ['voiceover', 'generatedShots', 'sound'])
    expect(currentCapabilities(env.ctx)).toEqual({ voiceover: false, generatedShots: false, costs: false })
    expect(currentCapabilities({ workspaceId: OTHER_WS })).toEqual({ voiceover: true, generatedShots: true, costs: true })
    expect((await bootstrap(env.ctx)).capabilities).toMatchObject({ voiceover: false, generatedShots: false, costs: false, sound: true })
    // The account's voices (cloned ones too) are kept from an earlier read: still not this workspace's to see.
    await putRecord(env.ctx, 'voice', 'list', { at: new Date().toISOString(), voices: [{ voiceId: 'voice-fake-01', name: 'Made-up Clone' }] })
    await putRecord(env.ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Clone', modelId: 'eleven_multilingual_v2' })
    const refused = { status: 403, code: 'NOT_SET_UP', message: 'Narration is not set up for this workspace.' }
    await expect(listVoices(env.ctx)).rejects.toMatchObject(refused)
    await expect(previewNarration(env.ctx, 'Hello')).rejects.toMatchObject(refused)
    await expect(startNarration(env.ctx, 'Hello', { allowPaid: true })).rejects.toMatchObject(refused)
    const shots = { status: 403, code: 'NOT_SET_UP', message: 'Generated shots are not set up for this workspace.' }
    await expect(quoteBeat(env.ctx, 'v', 'b', { what: 'still' })).rejects.toMatchObject(shots)
    await expect(startShot(env.ctx, 'v', 'b', { what: 'still', confirm: { model: 'made_up_model', credits: 1 } })).rejects.toMatchObject(shots)
    expect(() => requireCapability(env.ctx, 'voiceover', { worker: false })).toThrow('Narration is not set up')
    // Capabilities that spend nothing are not fenced.
    expect(() => requireCapability(env.ctx, 'sound')).not.toThrow()
    expect(env.tables.studio_job ?? []).toHaveLength(0)
    // Listed, the same workspace may.
    vi.stubEnv('STUDIO_PROVIDER_WORKSPACES', `${OTHER_WS},${WS}`)
    expect(await previewNarration(env.ctx, 'Hello')).toMatchObject({ characters: 5, cached: false })
    expect(await listVoices(env.ctx)).toMatchObject({ voices: [{ voiceId: 'voice-fake-01' }] })
  })
})

describe('a worker’s result is tied to the bytes its job stored (ownAsset)', () => {
  it('refuses an asset not named by its bytes, not stored under them, or not the stored bytes', async () => {
    const s = sha('a')
    await expect(ownAsset(env.ctx, image(s))).rejects.toThrow('The worker did not store the file.')
    await store(`assets/${s}.png`, 10)
    expect(await ownAsset(env.ctx, image(s))).toMatchObject({ id: s })
    await expect(ownAsset(env.ctx, { ...image(s), id: sha('b') })).rejects.toThrow('not named by its contents')
    await expect(ownAsset(env.ctx, { ...image(s), file: `assets/${sha('c')}.png` })).rejects.toThrow('not stored under its contents')
    await expect(ownAsset(env.ctx, image(s, 11))).rejects.toThrow('not the file the worker described')
    // Some other blob at a library key whose stored hash is not the key's: refused.
    await putBlobBytes(env.ctx, `assets/${sha('d')}.png`, new Uint8Array(10), 'image/png', null)
    await expect(ownAsset(env.ctx, image(sha('d')))).rejects.toThrow('not the file the worker described')
  })

  it('a narration whose audio is not the stored bytes registers nothing, but its charge is kept', async () => {
    noteWorker('mac-1', ['voiceover'])
    await putRecord(env.ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    const started = await startNarration(env.ctx, 'Hello there', { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['narration'])
    const s = sha('e')
    await store(`assets/${s}.mp3`, 10)
    const result = { asset: audio(s, 999), words: [{ text: 'Hello', startMs: 0, endMs: 300 }], alignmentSha256: sha('f'), characters: 11 }
    await expect(completeJob(deps(), started.job.id, 'mac-1', result)).rejects.toMatchObject({ status: 422 })
    expect((await getAssets(env.ctx, [s])).size).toBe(0)
    expect(await getRecord(env.ctx, COSTS_COLLECTION, `elevenlabs:${started.job.id}`)).toMatchObject({ credits: 11 })
  })

  it('a static batch: every image checked before any is registered; files and the batch id are its own job’s', async () => {
    const jobId = await held('ads-static', { projectId: 'p-1', batch: { id: 'spring' } })
    const good = sha('1'), bad = sha('2')
    await store(`assets/${good}.png`, 10)
    await store(`assets/${bad}.png`, 10)
    for (const f of ['report.json', 'report.md', 'contact-sheet.jpg']) await store(`ads/${jobId}/${f}`, 4)
    const files = { reportJson: `ads/${jobId}/report.json`, reportMd: `ads/${jobId}/report.md`, contactSheet: `ads/${jobId}/contact-sheet.jpg` }
    const ad = (assets: EditorAsset[]) => ({ id: 'A1', pattern: 'AD-1', template: 'statement', flags: [], photo: [], people: false, images: assets.map((asset) => ({ size: 'square', asset, findings: [] })) })
    const row = { id: jobId, kind: 'ads-static' as never, input: { projectId: 'p-1', batch: { id: 'spring' } } }
    const result = (over: Record<string, unknown> = {}) => ({ batchId: 'spring', ads: [ad([image(good), image(bad, 99)])], files, withoutPeople: [], notes: [], ...over })
    await expect(fileAdsResult(env.ctx, row, result())).rejects.toThrow('not the file the worker described')
    // Nothing registered: the good image was not registered before the bad one was found.
    expect((await getAssets(env.ctx, [good, bad])).size).toBe(0)
    // Files outside this job's folder, or not stored, or another batch's id: refused.
    await expect(fileAdsResult(env.ctx, row, result({ ads: [ad([image(good)])], files: { ...files, reportMd: 'thumbs/other.jpg' } }))).rejects.toThrow("outside this job's files")
    await expect(fileAdsResult(env.ctx, row, result({ ads: [ad([image(good)])], files: { ...files, reportMd: `ads/${jobId}/../../uploads/x` } }))).rejects.toThrow()
    await expect(fileAdsResult(env.ctx, row, result({ ads: [ad([image(good)])], files: { ...files, reportMd: `ads/${jobId}/missing.md` } }))).rejects.toThrow('did not store')
    await expect(fileAdsResult(env.ctx, row, result({ ads: [ad([image(good)])], batchId: 'someone-elses' }))).rejects.toThrow('another batch')
    expect(await getRecord(env.ctx, AD_BATCHES, 'p-1/someone-elses')).toBeNull()
    const filed = await fileAdsResult(env.ctx, row, result({ ads: [ad([image(good)])] }))
    expect(filed).toMatchObject({ batchId: 'spring', recordKey: 'p-1/spring' })
    expect((await getAssets(env.ctx, [good])).size).toBe(1)
  })

  it('a motion ad’s renders must be among the files it stored; a reel’s id is its job’s', async () => {
    const jobId = await held('ads-motion', { projectId: 'p-1', brief: { id: 'beat' } })
    const render = sha('3'), stranger = sha('4')
    await store(`assets/${render}.png`, 10)
    await store(`assets/${stranger}.png`, 10)
    for (const f of ['report.md', 'brief.json']) await store(`ads/${jobId}/${f}`, 4)
    const row = { id: jobId, kind: 'ads-motion' as never, input: { projectId: 'p-1', brief: { id: 'beat' } } }
    const files = { report: `ads/${jobId}/report.md`, brief: `ads/${jobId}/brief.json` }
    await expect(fileAdsResult(env.ctx, row, { briefId: 'beat', title: 'Beat', errors: 0, findings: [], report: '', files, renders: { '9x16': image(stranger), strip: image(render) }, parts: { layers: [] }, assets: [image(render)], notes: [] })).rejects.toThrow('not among the files the worker stored')
    await expect(fileAdsResult(env.ctx, row, { briefId: 'other', title: 'Beat', errors: 0, findings: [], report: '', files, renders: { '9x16': image(render), strip: image(render) }, parts: { layers: [] }, assets: [image(render)], notes: [] })).rejects.toThrow('another brief')
    expect((await getAssets(env.ctx, [render, stranger])).size).toBe(0)
    const reelRow = { id: jobId, kind: 'ads-reel' as never, input: { projectId: 'p-1', spec: { id: 'shop' } } }
    await expect(fileAdsResult(env.ctx, reelRow, { reelId: 'not-shop', title: 'Shop', seconds: 3, render: image(render), strip: image(render), notes: [], files: { notes: files.report } })).rejects.toThrow('another reel')
  })

  it('a listed record’s files become links only when they are file keys', async () => {
    await putRecord(env.ctx, AD_BATCHES, 'p-1/old', { projectId: 'p-1', batchId: 'old', jobId: 'j', createdAt: '2031-03-01T09:00:00Z', ads: [], files: { reportJson: '../../../account/settings', reportMd: 'ads/j/report.md', contactSheet: 'ads/j/c.jpg' }, withoutPeople: [], notes: [] })
    const [batch] = (await listAds(env.ctx, 'p-1')).batches
    expect(batch!.links.reportJson).toBe('')
    expect(batch!.links.report).toBe(`/api/account/studio/file/${WS}/ads/j/report.md`)
  })
})

describe('a worker’s writes are fenced to its own job’s files', () => {
  it('refuses to replace a file another job committed, writes its own again, and answers a stored library file as there', async () => {
    const a = await held('export', { title: 'A' }, 'w-a')
    await store(`exports/${a}/1/video.mp4`, 20)
    await store('thumbs/v-1.jpg', 5)
    const b = await held('stills', { times: [0] }, 'w-b')
    const write = (key: string, extra: Record<string, unknown> = {}) => workerBlobWrite(workerRequest({ jobId: b, workerId: 'w-b', key, bytes: 10, contentType: 'image/png', ...extra }), deps())
    const commit = (key: string) => workerBlobCommit(workerRequest({ jobId: b, workerId: 'w-b', key }), deps())
    for (const key of [`exports/${a}/1/video.mp4`, 'thumbs/v-1.jpg']) {
      const res = await write(key)
      expect(res.status, key).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'NOT_YOURS' })
    }
    expect((await getBlob(env.ctx, `exports/${a}/1/video.mp4`))?.bytes).toBe(20)
    // Its own key, new and then again (a re-run of the job).
    for (let i = 0; i < 2; i++) {
      const res = await write(`stills/${b}/0.png`)
      expect(res.status).toBe(200)
      for (const part of (await res.json()).parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
      expect((await commit(`stills/${b}/0.png`)).status).toBe(200)
    }
    // A library file: written once with its hash; then it is there, and nothing is sent again.
    const s = sha('5')
    expect((await write(`assets/${s}.png`, { sha256: sha('6') })).status).toBe(409)
    expect((await write(`assets/${s}.png`)).status).toBe(409)
    const first = await write(`assets/${s}.png`, { sha256: s })
    for (const part of (await first.json()).parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
    expect((await commit(`assets/${s}.png`)).status).toBe(200)
    const again = await write(`assets/${s}.png`, { sha256: s })
    expect(await again.json()).toMatchObject({ exists: true, parts: [] })
    expect((await commit(`assets/${s}.png`)).status).toBe(200)
    // A library key holding bytes that are not its hash is not replaced either.
    await putBlobBytes(env.ctx, `assets/${sha('7')}.png`, new Uint8Array(3), 'image/png', null)
    expect((await write(`assets/${sha('7')}.png`, { sha256: sha('7') })).status).toBe(409)
  })

  it('the thumbnail job may replace its own given key, and nothing else', async () => {
    await store('thumbs/v-2.jpg', 5)
    const t = await held('thumbnail', { key: 'thumbs/v-2.jpg' }, 'w-t')
    const job = { id: t, kind: 'thumbnail', input: { key: 'thumbs/v-2.jpg' } }
    expect(await workerWriteFence(env.ctx, job, 'thumbs/v-2.jpg')).toEqual({ exists: null })
    await store('thumbs/v-3.jpg', 5)
    await expect(workerWriteFence(env.ctx, job, 'thumbs/v-3.jpg')).rejects.toMatchObject({ status: 409 })
  })

  it('a re-run of an import whose file is stored already completes', async () => {
    const s = sha('8')
    const asset = { ...image(s, 10), name: 'Walkthrough.png' }
    for (const worker of ['w-1', 'w-2']) {
      await store('uploads/0a0a0a0a-1111-4222-8333-444444444444', 3)
      const id = await held('import', { uploadKey: 'uploads/0a0a0a0a-1111-4222-8333-444444444444', name: 'Walkthrough.png' }, worker)
      const ticket = await (await workerBlobWrite(workerRequest({ jobId: id, workerId: worker, key: asset.file, bytes: 10, contentType: 'image/png', sha256: s }), deps())).json()
      if (!ticket.exists) {
        for (const part of ticket.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
        expect((await workerBlobCommit(workerRequest({ jobId: id, workerId: worker, key: asset.file }), deps())).status).toBe(200)
      } else expect(worker).toBe('w-2')
      const done = await workerComplete(workerRequest({ workerId: worker, result: { asset } }), id, deps())
      expect(done.status, worker).toBe(200)
    }
  })
})

describe('the sweep', () => {
  /** The fake client, with the first read of one file (getBlob's maybeSingle on studio_blob) failing, as a passing timeout does. */
  function failingBlobReads(client: SupabaseClient): SupabaseClient {
    let failures = 1
    return {
      rpc: client.rpc,
      from: (table: string) => {
        const builder = client.from(table) as unknown as Record<string, unknown>
        if (table !== 'studio_blob') return builder
        const proxy: Record<string, unknown> = new Proxy(builder, {
          get(target, prop) {
            if (prop === 'maybeSingle' && failures > 0) {
              failures--
              return async () => ({ data: null, error: { message: 'statement timeout' } })
            }
            const value = target[prop as string]
            return typeof value === 'function' ? (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown).apply(target, args); return out === target ? proxy : out } : value
          },
        })
        return proxy
      },
    } as unknown as SupabaseClient
  }

  it('skips a pending write whose committed file can’t be read, instead of removing the file', async () => {
    await store('thumbs/v-9.jpg', 5)
    env.tables.studio_record!.push({ workspace_id: WS, collection: 'blob-writes', key: 'thumbs/v-9.jpg', value: { bytes: 5, partBytes: 5, contentType: 'image/jpeg', sha256: null, createdAt: '2031-01-01T00:00:00Z' }, created_at: '2031-01-01T00:00:00Z', updated_at: '2031-01-01T00:00:00Z' })
    await sweepStudio(failingBlobReads(env.ctx.supabase), { storage: env.ctx.storage, now: new Date('2031-03-05T09:00:00Z') })
    expect(env.tables.studio_blob!.some((b) => b.key === 'thumbs/v-9.jpg')).toBe(true)
    expect(env.storage.objects.has(`${WS}/thumbs/v-9.jpg/0`)).toBe(true)
  })

  it('keeps an old upload an open job of any kind names, however many other jobs are open', async () => {
    const key = 'uploads/0b0b0b0b-1111-4222-8333-444444444444'
    await store(key, 3)
    env.tables.studio_blob!.find((b) => b.key === key)!.created_at = '2031-01-01T00:00:00Z'
    // A sound import still waiting for the worker, behind many other workspaces' open jobs.
    const others = Array.from({ length: 2100 }, (_, i) => ({ id: `0000${String(i).padStart(4, '0')}-1111-4222-8333-444444444444`, workspace_id: OTHER_WS, kind: 'import', status: 'queued', cancel_requested: false, input: { uploadKey: `uploads/other-${i}` }, created_at: '2031-01-01T00:00:00Z', updated_at: '2031-01-01T00:00:00Z' }))
    env.tables.studio_job = [...others, { id: '0c0c0c0c-1111-4222-8333-444444444444', workspace_id: WS, kind: 'sound-import', status: 'queued', cancel_requested: false, input: { uploadKey: key, name: 'bed.wav' }, created_at: '2031-03-01T00:00:00Z', updated_at: '2031-03-01T00:00:00Z' }]
    const now = new Date('2031-03-05T09:00:00Z')
    expect((await sweepStudio(env.ctx.supabase, { storage: env.ctx.storage, now })).uploads).toBe(0)
    expect(await getBlob(env.ctx, key)).not.toBeNull()
    // Running and asked to stop: its worker may still be reading it.
    Object.assign(env.tables.studio_job.at(-1)!, { status: 'running', cancel_requested: true })
    expect((await sweepStudio(env.ctx.supabase, { storage: env.ctx.storage, now })).uploads).toBe(0)
    // Ended: it goes.
    Object.assign(env.tables.studio_job.at(-1)!, { status: 'failed' })
    expect((await sweepStudio(env.ctx.supabase, { storage: env.ctx.storage, now })).uploads).toBe(1)
    expect(await getBlob(env.ctx, key)).toBeNull()
  })
})

describe('the limits hold under requests at once', () => {
  it('two uploads at once can’t together pass the byte limit', async () => {
    vi.stubEnv('STUDIO_WORKSPACE_BYTES', '100')
    const both = await Promise.allSettled([
      createBlobWrite(env.ctx, { key: 'uploads/one', bytes: 60, contentType: 'video/mp4' }),
      createBlobWrite(env.ctx, { key: 'uploads/two', bytes: 60, contentType: 'video/mp4' }),
    ])
    expect(both.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1)
    for (const r of both) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 413, code: 'QUOTA' })
    const held = (env.tables.studio_record ?? []).filter((r) => r.collection === 'blob-writes').reduce((n, r) => n + Number((r.value as { bytes: number }).bytes), 0)
    expect(held).toBeLessThanOrEqual(100)
    // Alone, one fits; past the limit it is refused and holds nothing.
    env.tables.studio_record = []
    await createBlobWrite(env.ctx, { key: 'uploads/three', bytes: 60, contentType: 'video/mp4' })
    await expect(createBlobWrite(env.ctx, { key: 'uploads/four', bytes: 60, contentType: 'video/mp4' })).rejects.toMatchObject({ code: 'QUOTA', message: expect.stringMatching(/holds 1 MB/) })
    expect(env.tables.studio_record!.map((r) => r.key)).toEqual(['uploads/three'])
    await expect(putBlobBytes(env.ctx, 'assets/x.bin', new Uint8Array(60), 'application/octet-stream')).rejects.toMatchObject({ code: 'QUOTA' })
    expect(env.tables.studio_blob ?? []).toHaveLength(0)
  })

  it('jobs queued at once never pass the open-job cap (studio_queue_job), and without 627 it is counted first as before', async () => {
    const made = await Promise.allSettled(Array.from({ length: MAX_OPEN_JOBS + 5 }, () => queueJob(env.ctx, 'stills', { times: [0] } as never)))
    expect(made.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_OPEN_JOBS)
    expect(made.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 429, code: 'TOO_MANY_JOBS' } })
    expect(env.tables.studio_job).toHaveLength(MAX_OPEN_JOBS)
    // The queued row reads as the editor reads any job.
    expect((made[0] as PromiseFulfilledResult<{ kind: string; status: string; input: unknown }>).value).toMatchObject({ kind: 'stills', status: 'queued', input: {} })
    const db = fakeDb({}, { queueFunction: false })
    const ctx = { supabase: db.client, workspaceId: WS, userId: AVA, storage: fakeStorage() }
    for (let i = 0; i < MAX_OPEN_JOBS; i++) await queueJob(ctx, 'stills', { times: [0] } as never)
    await expect(queueJob(ctx, 'stills', { times: [0] } as never)).rejects.toMatchObject({ status: 429 })
  })
})

describe('a paid job whose worker went quiet', () => {
  const shotInput = { what: 'still', final: false, params: { prompt: 'A made-up kitchen' }, references: [], blocks: {}, confirm: { model: 'made_up_model', credits: 3 }, beatId: 'beat-1', name: 'beat-1-still', prompt: 'A made-up kitchen' }
  const stale = (id: string) => Object.assign(env.tables.studio_job!.find((j) => j.id === id)!, { heartbeat_at: '2020-01-01T00:00:00Z', claimed_at: '2020-01-01T00:00:00Z' })

  it('ends failed, saying the provider may have charged; its late result still leaves its charge, and places nothing', async () => {
    const id = await held('shot', shotInput, 'w-1')
    stale(id)
    expect(await claimJob(deps(), 'w-2', ['shot'])).toBeNull()
    expect(env.tables.studio_job!.find((j) => j.id === id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/may have charged\. Check the costs before trying again/) })
    const made = { outcome: 'made', quote: { credits: 3, model: 'made_up_model', tier: 'draft' }, providerJobId: 'hf-fake-1', assets: [image(sha('9'))], asset: image(sha('9')) }
    // Another worker's word is not taken.
    await expect(completeJob(deps(), id, 'w-other', made)).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect(await getRecord(env.ctx, COSTS_COLLECTION, `higgsfield:${id}`)).toBeNull()
    await expect(completeJob(deps(), id, 'w-1', made)).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect(await getRecord(env.ctx, COSTS_COLLECTION, `higgsfield:${id}`)).toMatchObject({ credits: 3, model: 'made_up_model', jobId: id, providerJobId: 'hf-fake-1' })
    expect((await getAssets(env.ctx, [sha('9')])).size).toBe(0)
    expect(env.tables.studio_job!.find((j) => j.id === id)).toMatchObject({ status: 'failed' })
  })

  it('a narration the same way: failed, and its late result charged once', async () => {
    const request = { voiceId: 'voice-fake-01', modelId: 'eleven_multilingual_v2', text: 'Hello there' }
    const id = await held('narration', { request, requestHash: sha('a'), voiceName: 'Made-up Voice', name: 'n.mp3' }, 'w-1')
    stale(id)
    await claimJob(deps(), 'w-2', ['narration'])
    expect(env.tables.studio_job!.find((j) => j.id === id)).toMatchObject({ status: 'failed' })
    for (let i = 0; i < 2; i++) await expect(completeJob(deps(), id, 'w-1', { characters: 11 })).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect((env.tables.studio_record ?? []).filter((r) => r.collection === COSTS_COLLECTION)).toMatchObject([{ value: { credits: 11, provider: 'elevenlabs' } }])
  })

  it.each(['revoice', 'sound-effect', 'music'])('a stale %s job ends failed too, never queued again', async (kind) => {
    const id = await held(kind, { name: 'made-up' }, 'w-1')
    stale(id)
    expect(await claimJob(deps(), 'w-2', [kind as never])).toBeNull()
    expect(env.tables.studio_job!.find((j) => j.id === id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/may have charged\. Check the costs before trying again/) })
  })

  it('other kinds still go back in the queue', async () => {
    const id = await held('stills', { times: [0] }, 'w-1')
    stale(id)
    expect((await claimJob(deps(), 'w-2', ['stills']))?.id).toBe(id)
  })
})

describe('a paid job that ends spent but not delivered, or after the person asked it to stop', () => {
  const VOICE = { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' }
  const SENTENCE = 'ElevenLabs made this narration (and charged 12 characters) but it could not be kept: the audio it returned cannot be read. It is not requested again on its own.'
  const undelivered = { outcome: 'undelivered', error: SENTENCE, characters: 12, charactersFrom: 'request' }
  const charges = () => (env.tables.studio_record ?? []).filter((r) => r.collection === COSTS_COLLECTION).map((r) => r.value as Record<string, unknown>)

  it('a narration not delivered: the charge (estimated), no asset, and the worker’s sentence as the answer, once, before a new request', async () => {
    noteWorker('mac-1', ['voiceover'])
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    const started = await startNarration(env.ctx, 'Hello there.', { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['narration'])
    await completeJob(deps(), started.job.id, 'mac-1', undelivered)
    const row = env.tables.studio_job!.find((j) => j.id === started.job.id)!
    expect(row).toMatchObject({ status: 'completed', result: { outcome: 'undelivered', error: SENTENCE, characters: 12, charactersFrom: 'request' } })
    expect(charges()).toMatchObject([{ provider: 'elevenlabs', credits: 12, estimated: true, detail: expect.stringMatching(/^Estimated from the request's length/) }])
    expect(env.tables.studio_asset ?? []).toHaveLength(0)
    expect((env.tables.studio_record ?? []).filter((r) => r.collection === NARRATION_COLLECTION)).toHaveLength(0)
    // The agent's job view reads it as not delivered, with the sentence.
    expect(jobView(row as never)).toMatchObject({ status: 'completed', outcome: 'undelivered', error: SENTENCE, characters: 12 })
    expect(jobView(row as never)).not.toHaveProperty('asset_id')
    // The editor's Generate answers the sentence as an error (no audio to stage), and asks nothing of the provider.
    await expect(generateNarration(env.ctx, { text: 'Hello there.', allowPaid: true }, { waitMs: 10 })).rejects.toMatchObject({ status: 502, code: 'UNDELIVERED', message: SENTENCE })
    expect(env.tables.studio_job!.filter((j) => j.kind === 'narration')).toHaveLength(1)
    // Read once, a Generate after is the person's new request.
    await expect(generateNarration(env.ctx, { text: 'Hello there.', allowPaid: true }, { waitMs: 10 })).rejects.toMatchObject({ code: 'STILL_RUNNING' })
    expect(env.tables.studio_job!.filter((j) => j.kind === 'narration')).toHaveLength(2)
  })

  it('a shot made after a cancel: charged, kept in the library, not placed; one not delivered after a cancel: charged', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring teaser', seconds: 3 })
    const opened = await openVideo(env.ctx, video.id)
    await saveVideo(env.ctx, { ...opened.project, storyboard: { beats: [{ id: 'beat-1', words: '', startFrame: 0, durationFrames: 60, source: 'generated', status: 'planned', shot: 'A made-up kitchen' }] } }, opened.projectDigest)
    const input = { what: 'still', final: false, params: { prompt: 'A made-up kitchen' }, references: [], blocks: {}, confirm: { model: 'made_up_model', credits: 3 }, beatId: 'beat-1', name: 'beat-1-still', prompt: 'A made-up kitchen' }
    const cancel = (id: string) => (env.tables.studio_job!.find((j) => j.id === id)!.cancel_requested = true)
    const made = await held('shot', input, 'w-1', video.id)
    cancel(made)
    const s = sha('b')
    await store(`assets/${s}.png`, 10)
    await completeJob(deps(), made, 'w-1', { outcome: 'made', quote: { credits: 3, model: 'made_up_model', tier: 'draft' }, providerJobId: 'hf-fake-2', assets: [image(s)], asset: image(s) })
    expect(env.tables.studio_job!.find((j) => j.id === made)).toMatchObject({ status: 'completed', result: { outcome: 'made', assetId: s, placed: false, placeError: expect.stringMatching(/cancelled this shot.*not placed/) } })
    expect((await getAssets(env.ctx, [s])).size).toBe(1)
    const after = await openVideo(env.ctx, video.id)
    expect(after.project.storyboard!.beats[0]!.generation?.stillAssetId).toBeUndefined()
    expect(after.project.assets.some((a) => a.id === s)).toBe(false)
    const lost = await held('shot', { ...input, beatId: 'beat-2' }, 'w-1', video.id)
    cancel(lost)
    await completeJob(deps(), lost, 'w-1', { outcome: 'undelivered', error: 'Higgsfield made it but the file could not be downloaded.', quote: { credits: 3, model: 'made_up_model', tier: 'draft' }, providerJobId: 'hf-fake-3' })
    expect(charges().map((c) => c.jobId).sort()).toEqual([made, lost].sort())
  })

  it('a narration made or not delivered after a cancel: charged either way; made, it is kept and cached', async () => {
    noteWorker('mac-1', ['voiceover'])
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    const one = await startNarration(env.ctx, 'First line.', { allowPaid: true })
    const two = await startNarration(env.ctx, 'Second line.', { allowPaid: true })
    if (!('job' in one) || !('job' in two)) throw new Error('expected jobs')
    await claimJob(deps(), 'mac-1', ['narration'])
    await claimJob(deps(), 'mac-1', ['narration'])
    for (const id of [one.job.id, two.job.id]) env.tables.studio_job!.find((j) => j.id === id)!.cancel_requested = true
    const s = sha('c')
    await store(`assets/${s}.mp3`, 10)
    await completeJob(deps(), one.job.id, 'mac-1', { asset: audio(s), text: 'First line.', words: [{ text: 'First', startMs: 0, endMs: 300 }], alignmentSha256: sha('d'), characters: 11, charactersFrom: 'provider' })
    await completeJob(deps(), two.job.id, 'mac-1', { ...undelivered, characters: 12, charactersFrom: 'provider' })
    expect(charges()).toHaveLength(2)
    expect(charges().find((c) => c.jobId === two.job.id)).not.toHaveProperty('estimated')
    expect((await getAssets(env.ctx, [s])).size).toBe(1)
    expect((env.tables.studio_record ?? []).filter((r) => r.collection === NARRATION_COLLECTION)).toHaveLength(1)
  })
})

describe('a database without the Studio’s tables', () => {
  it('is one 503 STUDIO_NOT_SET_UP, said in the log once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const code of ['PGRST205', '42P01', 'PGRST202']) {
      expect(() => must({ data: null, error: { message: 'relation "public.studio_video" does not exist', code } }, 'read videos')).toThrow(
        expect.objectContaining({ status: 503, code: 'STUDIO_NOT_SET_UP', message: 'The Studio is not set up on this server yet.' }),
      )
    }
    expect(notSetUpError().code).toBe('STUDIO_NOT_SET_UP')
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
    expect(console.error).not.toHaveBeenCalled()
    // Any other failure is still the plain one.
    expect(() => must({ data: null, error: { message: 'timeout', code: '57014' } }, 'read videos')).toThrow(expect.objectContaining({ status: 500, code: 'INTERNAL' }))
  })
})
