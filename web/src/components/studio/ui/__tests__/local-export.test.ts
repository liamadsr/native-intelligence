// @vitest-environment jsdom
/**
 * An export on the person's own computer, the page's side (../local-export.ts), with the desktop app stubbed: what the
 * computer can do (and why not, in plain words), starting there (and going to the server when it can't), and what the
 * dialog shows from the job and the app's events: running, waiting for this computer (asleep, quit) and carried on,
 * stopped, failed then finished on the server, done and uploaded, done and kept here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorJob } from '@/lib/studio/engine/api'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { STUDIO_RENDER_VERSION } from '@/lib/studio/engine/render-version'
import { studioRefusal, type StudioLocalStatus } from '@/lib/tauri-bridge'
import {
  LOCAL_WORDS, STALL_MS, asSavedAgain, canSaveAgain, capabilityFor, markSavedAgain, capabilityOf, continueOnComputer, destinationOf, emptyRunner, finishOnServer, foldEvents, localView,
  readLocalCapability, revealLabel, savesParts, startOnComputer,
} from '../local-export'

afterEach(() => localStorage.clear())
const ready: StudioLocalStatus = { available: true, platform: 'macos', arch: 'arm64', components: { runtime: 'ready', chrome: 'ready', ffmpeg: 'ready' }, downloadBytes: 0, renderVersion: STUDIO_RENDER_VERSION, encoder: 'videotoolbox' }
const project = { id: 'v1', title: 'Spring launch', layers: [] } as unknown as EditorProject
const JOB = 'bbbbbbbb-1111-4222-8333-444444444444'
const job = (over: Partial<EditorJob> = {}): EditorJob => ({ id: JOB, kind: 'export', where: 'computer', status: 'running', progress: 0, logs: [], ...over })
const destination = { destinationId: 'd1', name: 'Spring launch.mp4' }
const noPick = vi.fn(async () => null)

describe('what this computer can do', () => {
  it('in a browser, nothing is said: it exports on the server as before', async () => {
    expect(await readLocalCapability(null)).toEqual({ kind: 'browser' })
  })

  it('available, on macOS and on Windows', () => {
    expect(capabilityOf(ready)).toEqual({ kind: 'ready', platform: 'macos', encoder: 'videotoolbox' })
    expect(capabilityOf({ ...ready, platform: 'windows', encoder: undefined })).toEqual({ kind: 'ready', platform: 'windows' })
    expect(revealLabel('macos')).toBe('Show in Finder')
    expect(revealLabel('windows')).toBe('Show in Explorer')
  })

  it('not available, each with its reason in plain words', async () => {
    // An app older than the computer export: its status command is not there.
    const old = await readLocalCapability({ status: async () => { throw new Error('Command studio_local_status not found') } })
    expect(old).toEqual({ kind: 'unavailable', reason: LOCAL_WORDS.oldApp, saveParts: false })
    expect(savesParts(old)).toBe(false)
    // Another render version.
    expect(capabilityOf({ ...ready, renderVersion: '2026-01-01.1' })).toMatchObject({ kind: 'unavailable', reason: LOCAL_WORDS.otherVersion })
    // A computer that can't: the app's own sentence, else ours.
    expect(capabilityOf({ ...ready, available: false, reason: 'This Mac is older than macOS 13.' })).toMatchObject({ reason: 'This Mac is older than macOS 13.' })
    expect(capabilityOf({ ...ready, available: false })).toMatchObject({ reason: LOCAL_WORDS.unsupported })
    // A video only the server makes.
    const scenes = { ...project, layers: [{ style: { scene: { id: 'chart' } } }] } as unknown as EditorProject
    expect(capabilityFor(capabilityOf(ready), scenes)).toMatchObject({ kind: 'unavailable', reason: LOCAL_WORDS.codeScenes })
    expect(capabilityFor(capabilityOf(ready), project)).toMatchObject({ kind: 'ready' })
  })

  it('first use: the one-time download, with its size', () => {
    expect(capabilityOf({ ...ready, components: { runtime: 'ready', chrome: 'missing', ffmpeg: 'missing' }, downloadBytes: 412_000_000 })).toEqual({ kind: 'prepare', bytes: 412_000_000, downloading: false })
    expect(capabilityOf({ ...ready, components: { runtime: 'downloading', chrome: 'missing', ffmpeg: 'ready' }, downloadBytes: 9 })).toMatchObject({ kind: 'prepare', downloading: true })
  })
})

describe('starting on this computer', () => {
  const requests = (answers: Record<string, unknown>) => vi.fn(async (path: string, body?: unknown) => {
    const key = `${path}${(body as { where?: string } | undefined)?.where ? ':computer' : ''}`
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as <T>(path: string, body?: unknown) => Promise<T>

  it('queues it for this computer and hands the token to the app, with where to save it and uploading on', async () => {
    const start = vi.fn(async () => undefined)
    const request = requests({ '/api/account/studio/export:computer': { job: job(), local: { token: 'tok' } } })
    expect(await startOnComputer(project, destination, { request, bridge: { start }, pick: noPick })).toEqual({ job: job() })
    expect(start).toHaveBeenCalledWith({ jobId: JOB, token: 'tok', destinationId: 'd1', upload: true })
    expect(destinationOf(JOB)).toEqual(destination)
  })

  it('exports on the server, saying why, when the server refuses it for this computer', async () => {
    const refused = Object.assign(new Error("This computer's Studio app is a different version from the Studio."), { code: 'RENDER_VERSION' })
    const server = job({ id: 'srv', where: 'server' })
    const request = requests({ '/api/account/studio/export:computer': refused, '/api/account/studio/export': { job: server } })
    const start = vi.fn()
    expect(await startOnComputer(project, destination, { request, bridge: { start }, pick: noPick })).toEqual({ job: server, notice: refused.message })
    expect(start).not.toHaveBeenCalled()
    const tooMany = Object.assign(new Error('You have 2 exports open on your computers.'), { code: 'TOO_MANY_LOCAL' })
    await expect(startOnComputer(project, destination, { request: requests({ '/api/account/studio/export:computer': tooMany }), bridge: { start }, pick: noPick })).rejects.toThrow('2 exports open')
  })

  it('moves it to the server when the app cannot start it', async () => {
    const moved = job({ id: 'srv', where: 'server' })
    const request = requests({ '/api/account/studio/export:computer': { job: job(), local: { token: 'tok' } }, [`/api/account/studio/jobs/${JOB}/to-server`]: { job: moved, replaces: JOB } })
    expect(await startOnComputer(project, destination, { request, bridge: { start: async () => { throw new Error('Command studio_local_export_start not found') } }, pick: noPick })).toEqual({ job: moved, notice: LOCAL_WORDS.failedStart })
  })
})

describe('what the dialog shows of it', () => {
  const at = 1_000_000
  it('running: waiting to start, then the app’s progress', () => {
    expect(localView(job(), emptyRunner(), at, at + 1000)).toEqual({ kind: 'rendering', progress: 0, waiting: true })
    const runner = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 2, kind: 'progress', progress: 0.4 }, { jobId: JOB, seq: 1, kind: 'log', message: 'x' }], at + 2000)
    expect(localView(job({ progress: 0.3 }), runner, at, at + 3000)).toEqual({ kind: 'rendering', progress: 0.4, waiting: false })
    // An event seen twice counts once.
    expect(foldEvents(runner, [{ jobId: JOB, seq: 2, kind: 'progress', progress: 0.1 }], at + 4000).progress).toBe(0.4)
  })

  it('cancelled: by the app, or as the server says', () => {
    expect(localView(job(), foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'cancelled' }], at), at, at)).toEqual({ kind: 'cancelled' })
    expect(localView(job({ status: 'cancelled' }), emptyRunner(), at, at)).toEqual({ kind: 'cancelled' })
  })

  it('slept and resumed: no word from the app for a while offers to carry on, and carrying on hands it a new token', async () => {
    const runner = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'progress', progress: 0.5 }], at)
    expect(localView(job({ progress: 0.5 }), runner, at, at + STALL_MS - 1).kind).toBe('rendering')
    expect(localView(job({ progress: 0.5 }), runner, at, at + STALL_MS + 1)).toEqual({ kind: 'stalled', progress: 0.5 })
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: destination }))
    const start = vi.fn(async () => undefined)
    const request = vi.fn(async () => ({ token: 'fresh' })) as unknown as <T>(path: string, body?: unknown) => Promise<T>
    await continueOnComputer(JOB, 'Spring launch.mp4', { request, bridge: { start }, pick: noPick })
    expect(request).toHaveBeenCalledWith(`/api/account/studio/jobs/${JOB}/local-token`, {})
    expect(start).toHaveBeenCalledWith({ jobId: JOB, token: 'fresh', destinationId: 'd1', upload: true })
    // The app speaks again: rendering.
    const back = foldEvents(runner, [{ jobId: JOB, seq: 2, kind: 'progress', progress: 0.55 }], at + STALL_MS + 5000)
    expect(localView(job({ progress: 0.5 }), back, at, at + STALL_MS + 6000).kind).toBe('rendering')
  })

  it('failed, with the app’s sentence, then finished on the server', async () => {
    const runner = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'failed', message: 'The video engine stopped: out of memory.' }], at)
    expect(localView(job(), runner, at, at)).toEqual({ kind: 'failed', message: 'The video engine stopped: out of memory.' })
    expect(localView(job({ status: 'failed', error: 'No computer took this export within 15 minutes.' }), emptyRunner(), at, at)).toEqual({ kind: 'failed', message: 'No computer took this export within 15 minutes.' })
    const moved = job({ id: 'srv', where: 'server' })
    const request = vi.fn(async () => ({ job: moved, replaces: JOB })) as unknown as <T>(path: string, body?: unknown) => Promise<T>
    const cancel = vi.fn(async () => undefined)
    expect(await finishOnServer(JOB, request, { cancel })).toEqual({ job: moved, moved: true })
    // The app here stops the old one at once; one without the command is fine.
    expect(cancel).toHaveBeenCalledWith(JOB)
    expect(await finishOnServer(JOB, request, { cancel: async () => { throw new Error('Command studio_local_export_cancel not found') } })).toEqual({ job: moved, moved: true })
  })

  it('finishing on the server an export that ended meanwhile shows how it ended, without an error', async () => {
    const finished = job({ status: 'completed', progress: 1, kept: 'computer' })
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/to-server')) throw Object.assign(new Error('That export has ended.'), { code: 'ENDED' })
      return { job: finished }
    }) as unknown as <T>(path: string, body?: unknown) => Promise<T>
    const cancel = vi.fn(async () => undefined)
    expect(await finishOnServer(JOB, request, { cancel })).toEqual({ job: finished, moved: false })
    expect(request).toHaveBeenLastCalledWith(`/api/account/studio/jobs/${JOB}`)
    expect(cancel).not.toHaveBeenCalled()
    const other = vi.fn(async () => { throw Object.assign(new Error('Job not found'), { code: 'NOT_FOUND' }) }) as unknown as <T>(path: string, body?: unknown) => Promise<T>
    await expect(finishOnServer(JOB, other)).rejects.toThrow('Job not found')
  })

  it('on another computer: not started here and nothing from the app here; no stall is read; a word from the app here wins', () => {
    expect(localView(job({ progress: 0.42 }), emptyRunner(), at, at + 10 * STALL_MS, null, false)).toEqual({ kind: 'elsewhere', progress: 0.42 })
    const here = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'progress', progress: 0.5 }], at)
    expect(localView(job({ progress: 0.42 }), here, at, at + 1000, null, false).kind).toBe('rendering')
    // Started here (it knows the place): waiting for this computer after a while, as before.
    expect(localView(job({ progress: 0.42 }), emptyRunner(), at, at + STALL_MS + 1, null, true).kind).toBe('stalled')
    // It ends as the server says, wherever it ran.
    expect(localView(job({ status: 'completed', progress: 1, kept: 'computer' }), emptyRunner(), at, at, null, false).kind).toBe('done')
  })

  it('saved here and uploading, then done and also in the Studio', () => {
    const saved = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 3, kind: 'done', savedName: 'Spring launch.mp4' }], at)
    expect(localView(job({ progress: 0.96 }), saved, at, at)).toEqual({ kind: 'uploading', savedName: 'Spring launch.mp4' })
    expect(localView(job({ status: 'completed', progress: 1, downloadUrl: '/api/account/studio/file/w/exports/x/1/video.mp4' }), saved, at, at)).toEqual({ kind: 'done', savedName: 'Spring launch.mp4', uploaded: true })
  })

  it('done and kept on this computer only', () => {
    expect(localView(job({ status: 'completed', progress: 1, kept: 'computer' }), emptyRunner(), at, at, 'Spring launch.mp4')).toEqual({ kind: 'done', savedName: 'Spring launch.mp4', uploaded: false })
  })

  it('every run begins with started: what the app said of an earlier run is dropped, the seq kept', () => {
    const failed = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 4, kind: 'progress', progress: 0.7 }, { jobId: JOB, seq: 5, kind: 'failed', message: 'The disk is full.' }], at)
    expect(localView(job(), failed, at, at).kind).toBe('failed')
    const again = foldEvents(failed, [{ jobId: JOB, seq: 6, kind: 'started' }], at + 10)
    expect(again).toEqual({ ...emptyRunner(), seq: 6, lastAt: at + 10 })
    expect(localView(job(), again, at, at + 20)).toEqual({ kind: 'rendering', progress: 0, waiting: false })
    // A done, then a new run: not saved any more until the app says so again.
    const done = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'done', savedName: 'a.mp4' }, { jobId: JOB, seq: 2, kind: 'started' }], at)
    expect(done.done).toBe(false)
    expect(done.savedName).toBeNull()
  })

  it('after done only progress, logs and the upload count: a saved export whose upload failed is saved, kept here, with the app’s sentence', () => {
    const saved = foldEvents(emptyRunner(), [
      { jobId: JOB, seq: 1, kind: 'started' },
      { jobId: JOB, seq: 2, kind: 'done', savedName: 'Spring launch.mp4' },
      { jobId: JOB, seq: 3, kind: 'progress', progress: 0.2 },
      { jobId: JOB, seq: 4, kind: 'failed', message: 'should not count' },
      { jobId: JOB, seq: 5, kind: 'cancelled' },
      { jobId: JOB, seq: 6, kind: 'upload-failed', message: 'The upload stopped: the network went away.' },
    ], at)
    expect(saved).toMatchObject({ done: true, failed: null, cancelled: false, progress: 1, uploadFailed: 'The upload stopped: the network went away.' })
    const view = { kind: 'done', savedName: 'Spring launch.mp4', uploaded: false, note: 'The upload stopped: the network went away.' }
    // While the server still has it running, and after it marked it failed or cancelled: saved, never failed.
    expect(localView(job(), saved, at, at)).toEqual(view)
    expect(localView(job({ status: 'failed', error: 'The upload did not arrive.' }), saved, at, at)).toEqual(view)
    expect(localView(job({ status: 'cancelled' }), saved, at, at)).toEqual(view)
    // Saved and the upload went through.
    const uploaded = foldEvents(emptyRunner(), [{ jobId: JOB, seq: 1, kind: 'done', savedName: 'a.mp4' }, { jobId: JOB, seq: 2, kind: 'uploaded' }], at)
    expect(uploaded.uploaded).toBe(true)
    expect(localView(job({ status: 'failed', error: 'The file did not arrive.' }), uploaded, at, at)).toEqual({ kind: 'done', savedName: 'a.mp4', uploaded: false, note: 'The file did not arrive.' })
  })
})

describe('a place the app no longer takes', () => {
  const queued = { job: job(), local: { token: 'tok' } }
  const request = (vi.fn(async (path: string) => path.endsWith('/local-token') ? { token: 'fresh' } : queued)) as unknown as <T>(path: string, body?: unknown) => Promise<T>
  const refusing = (code: string) => vi.fn(async (args: { destinationId: string }) => { if (args.destinationId === 'd1') throw new Error(`${code}: That place was used already.`) })

  it('reads the app’s refusals: a code and a sentence, the sentence alone shown', () => {
    expect(studioRefusal(new Error('used: That place was used already.'))).toEqual({ code: 'used', message: 'That place was used already.' })
    expect(studioRefusal('unknown-destination: The app does not know that place.')).toEqual({ code: 'unknown-destination', message: 'The app does not know that place.' })
    expect(studioRefusal(new Error('KEPT_ON_COMPUTER: This export is kept on the computer that made it.'))).toEqual({ code: 'KEPT_ON_COMPUTER', message: 'This export is kept on the computer that made it.' })
    expect(studioRefusal(new Error('Something broke'))).toEqual({ code: null, message: 'Something broke' })
  })

  it('a second export with a place already used asks where to save again (suggesting the same name), never the server', async () => {
    for (const code of ['used', 'unknown-destination']) {
      const start = refusing(code), pick = vi.fn(async () => ({ destinationId: 'd2', name: 'Spring launch 2.mp4' }))
      expect(await startOnComputer(project, destination, { request, bridge: { start }, pick })).toEqual({ job: job() })
      expect(pick).toHaveBeenCalledWith('Spring launch.mp4')
      expect(start).toHaveBeenLastCalledWith({ jobId: JOB, token: 'tok', destinationId: 'd2', upload: true })
      expect(destinationOf(JOB)).toEqual({ destinationId: 'd2', name: 'Spring launch 2.mp4' })
      expect(request).not.toHaveBeenCalledWith(`/api/account/studio/jobs/${JOB}/to-server`, expect.anything())
    }
    // The panel closed: the export waits for this computer, saying so.
    const closed = await startOnComputer(project, destination, { request, bridge: { start: refusing('used') }, pick: noPick })
    expect(closed).toEqual({ job: job(), notice: LOCAL_WORDS.needsPlace })
  })

  it('other refusals from the app move it to the server with the app’s own sentence', async () => {
    const moved = job({ id: 'srv', where: 'server' })
    const req = (vi.fn(async (path: string) => path.endsWith('/to-server') ? { job: moved, replaces: JOB } : queued)) as unknown as <T>(path: string, body?: unknown) => Promise<T>
    const busy = async () => { throw new Error('busy: Another export is running in the app.') }
    expect(await startOnComputer(project, destination, { request: req, bridge: { start: busy }, pick: noPick })).toEqual({ job: moved, notice: `Another export is running in the app. ${LOCAL_WORDS.onServerNow}` })
  })

  it('continue after the app was quit: the save panel opens again and it starts with the new place; a closed panel leaves it waiting', async () => {
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: destination }))
    const start = refusing('unknown-destination'), pick = vi.fn(async () => ({ destinationId: 'd3', name: 'Spring launch.mp4' }))
    expect(await continueOnComputer(JOB, 'Spring launch.mp4', { request, bridge: { start }, pick })).toBe('started')
    expect(pick).toHaveBeenCalledWith('Spring launch.mp4')
    expect(start).toHaveBeenLastCalledWith({ jobId: JOB, token: 'fresh', destinationId: 'd3', upload: true })
    expect(destinationOf(JOB)?.destinationId).toBe('d3')
    // Nothing remembered (another browser profile): the panel first; never a start without a place.
    localStorage.clear()
    const none = vi.fn(async () => undefined)
    expect(await continueOnComputer(JOB, 'Spring launch.mp4', { request, bridge: { start: none }, pick: noPick })).toBe('cancelled')
    expect(none).not.toHaveBeenCalled()
    // A place the app refuses and a closed panel: still waiting, the place kept.
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: destination }))
    const used = refusing('used')
    expect(await continueOnComputer(JOB, 'Spring launch.mp4', { request, bridge: { start: used }, pick: noPick })).toBe('cancelled')
    expect(used).toHaveBeenCalledTimes(1)
  })
})

describe('made, but not saved where the person chose (save-failed)', () => {
  const at = 1_000_000
  const events = (...more: { kind: string; message?: string }[]) => [{ jobId: JOB, seq: 1, kind: 'started' }, { jobId: JOB, seq: 2, kind: 'progress', progress: 0.9 }, ...more.map((e, i) => ({ jobId: JOB, seq: 3 + i, ...e }))] as never

  it('ends the run in place of failed: the app’s sentence, the video kept to be saved again; nothing after it fails or stops it', () => {
    const runner = foldEvents(emptyRunner(), events({ kind: 'save-failed', message: 'The old file is open in another app.' }, { kind: 'failed', message: 'x' }, { kind: 'cancelled' }), at)
    expect(runner).toMatchObject({ saveFailed: 'The old file is open in another app.', failed: null, cancelled: false, done: false })
    for (const status of ['running', 'failed', 'cancelled'] as const)
      expect(localView(job({ status }), runner, at, at)).toEqual({ kind: 'save-failed', message: 'The old file is open in another app.' })
    // Kept on the computer only (no upload): still to be saved again.
    expect(localView(job({ status: 'completed', kept: 'computer' }), runner, at, at).kind).toBe('save-failed')
    // No sentence: ours.
    expect(foldEvents(emptyRunner(), events({ kind: 'save-failed' }), at).saveFailed).toBe(LOCAL_WORDS.saveFailed)
  })

  it('with the upload through, the ordinary done view: saved from the Studio, the app’s sentence beside it', () => {
    const runner = foldEvents(emptyRunner(), events({ kind: 'save-failed', message: 'The disk is full.' }, { kind: 'uploaded' }), at)
    expect(runner.uploaded).toBe(true)
    expect(localView(job({ status: 'completed', downloadUrl: '/api/account/studio/file/w/exports/x/1/video.mp4' }), runner, at, at))
      .toEqual({ kind: 'done', savedName: null, uploaded: true, note: 'The disk is full.', notHere: true })
  })

  it('saved again here: read as saved with its new name; a new run is not', () => {
    const runner = foldEvents(emptyRunner(), events({ kind: 'save-failed', message: 'The folder went away.' }), at)
    expect(asSavedAgain(JOB, runner)).toBe(runner)
    markSavedAgain(JOB, 'Spring launch (2).mp4')
    expect(localView(job({ status: 'failed', error: 'Not saved.' }), asSavedAgain(JOB, runner), at, at)).toEqual({ kind: 'done', savedName: 'Spring launch (2).mp4', uploaded: false, note: 'Not saved.' })
    expect(localView(job(), asSavedAgain(JOB, runner), at, at)).toEqual({ kind: 'uploading', savedName: 'Spring launch (2).mp4' })
    const again = foldEvents(runner, [{ jobId: JOB, seq: 9, kind: 'started' }], at)
    expect(asSavedAgain(JOB, again).done).toBe(false)
  })

  it('the app says `done` after `save-failed` once it is saved again: a page that reloads reads it as saved', () => {
    // As replayed after a reload: the run's last word, then the save that followed it.
    const replayed = foldEvents(emptyRunner(), events({ kind: 'save-failed', message: 'The disk is full.' }, { kind: 'done', savedName: 'Spring launch (3).mp4' }), at)
    expect(replayed).toMatchObject({ done: true, saveFailed: null, savedName: 'Spring launch (3).mp4', failed: null, cancelled: false })
    expect(localView(job({ status: 'completed', kept: 'computer' }), replayed, at, at)).toMatchObject({ kind: 'done', savedName: 'Spring launch (3).mp4', uploaded: false })
    // A second `done` changes nothing more, and a failure after it still does not count.
    const later = foldEvents(replayed, [{ jobId: JOB, seq: 50, kind: 'done', savedName: 'Other.mp4' }, { jobId: JOB, seq: 51, kind: 'failed', message: 'x' }], at)
    expect(later).toMatchObject({ done: true, savedName: 'Spring launch (3).mp4', failed: null })
  })

  it('knows whether the app can save again, without touching anything', async () => {
    const present = vi.fn(async () => { throw new Error('bad-request: jobId is not an id') })
    expect(await canSaveAgain({ saveAgain: present })).toBe(true)
    expect(present).toHaveBeenCalledWith({ jobId: '', destinationId: '' })
    expect(await canSaveAgain({ saveAgain: async () => { throw new Error('Command studio_local_export_save_again not found') } })).toBe(false)
  })
})
