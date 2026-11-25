// @vitest-environment jsdom
/**
 * A Studio take outlives the Studio card (record/controller.ts): it keeps recording while the person is anywhere in
 * the app, the card finds it again when it opens, a Stop from elsewhere (the Mac's floating control, the browser's
 * own bar) saves it with no card on screen and says "Recording saved" in the shell, never while a take records. The
 * page's leave guard is on only while a take records or is saved, a take belongs to the workspace it started in, and
 * signing out forgets everything. A made-up recorder and Studio stand in for the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { onRecordingNotice, recordingBusy, stopRecording, resetRecording, type RecordingNotice } from '@/lib/studio/recording-bus'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'
import { RecordingController, replaceRecordingController, type RecordingStart } from '../controller'
import type { FinishedTake, Recorder, RecorderHandlers, TakeFile } from '../types'
import { handoffKey, writeHandoff } from '@/lib/studio/prompter/channel'
import { useManualRecording, type ManualRecording } from '../../ui/useManualRecording'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@tauri-apps/api/event', () => ({ emit: async () => {}, listen: async () => () => {} }))

const WS_A = 'aaaaaaaa-1111-4222-8333-444444444444', WS_B = 'bbbbbbbb-1111-4222-8333-444444444444'
const VIDEO = 'd1d1d1d1-1111-4222-8333-888888888888'

/** The browser's recorder, made up: Start records until stop(), or until `end()` (the browser's own Stop sharing). */
class FakeRecorder {
  readonly kind = 'browser' as const
  handlers: RecorderHandlers | null = null
  uploads: string[] = []
  discarded = 0
  cancelled = 0
  disposed = 0
  async prepare() {}
  async start(handlers: RecorderHandlers) { this.handlers = handlers }
  async stop(): Promise<FinishedTake> {
    const screen = { role: 'screen', name: 'screen.webm', bytes: 10, offsetSeconds: 0 } as unknown as TakeFile
    return { kind: 'browser', sessionId: 'browser-take', files: [screen], trace: null, sourceCursorHidden: false, transcript: null, durationSeconds: 12 }
  }
  async cancel() { this.cancelled++ }
  async upload(_take: FinishedTake, file: TakeFile, onProgress: (f: number) => void) { onProgress(1); this.uploads.push(file.role); return `key-${file.role}` }
  async discard() { this.discarded++ }
  dispose() { this.disposed++ }
  onShareChange() {}
  async chooseShare() { return null }
  clearShare() {}
  /** The browser's own "Stop sharing". */
  end() { this.handlers?.onEnded({ kind: 'share-ended' } as never) }
}

let fake: FakeRecorder, controller: RecordingController, notices: RecordingNotice[], stopNotices: () => void
let studio: { recordings: number; answer: 'done' | 'fail' }
let win: { added: string[]; removed: string[]; addEventListener: (t: string) => void; removeEventListener: (t: string) => void }
const START: RecordingStart = { screen: { kind: 'shared' }, cameraId: false, microphoneId: false, systemAudio: false, countdownSeconds: 0, placement: { kind: 'new' } }

beforeEach(() => {
  setClientWorkspaceId(WS_A, { persist: false })
  localStorage.clear()
  fake = new FakeRecorder()
  studio = { recordings: 0, answer: 'done' }
  win = { added: [], removed: [], addEventListener: (t) => { win.added.push(t) }, removeEventListener: (t) => { win.removed.push(t) } }
  controller = new RecordingController({ opener: async () => ({ kind: 'browser', recorder: fake as unknown as Recorder & import('../browser').BrowserRecorder, desktopShell: false }) as never, win: win as never })
  replaceRecordingController(controller)
  notices = []
  stopNotices = onRecordingNotice((n) => notices.push(n))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/live-takes')) return Response.json({ takes: [] })
    if (url.includes('/recordings')) {
      studio.recordings++
      if (studio.answer === 'fail') return Response.json({ error: 'The recording could not be put together.' }, { status: 500 })
      return Response.json({ recording: { id: 'r1', status: 'done', step: 'Done', projectId: VIDEO, placed: 'new' } })
    }
    return Response.json({})
  }))
})
afterEach(() => { stopNotices(); resetRecording(); replaceRecordingController(null); vi.unstubAllGlobals(); unmount() })

let root: Root | null = null, host: HTMLElement | null = null, seen: ManualRecording | null = null
const said: string[] = []
function Studio() { seen = useManualRecording((text) => said.push(text), controller); return null }
async function mountStudio() { host = document.createElement('div'); document.body.appendChild(host); await act(async () => { root = createRoot(host!); root.render(<Studio />) }); await settle() }
function unmount() { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; seen = null }
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const statusOf = () => controller.getSnapshot().sessions[0]?.status

describe('a take outlives the Studio card', () => {
  it('keeps recording when the card closes, and the card finds it again', async () => {
    await mountStudio()
    await act(async () => { await seen!.start(START) })
    expect(seen!.active?.status).toBe('recording')
    const id = seen!.active!.id
    unmount()
    // Time passes with no card: the take's clock still moves.
    act(() => fake.handlers!.onStatus({ elapsedMs: 42_000, level: 0.3 }))
    expect(statusOf()).toBe('recording')
    await mountStudio()
    expect(seen!.active?.id).toBe(id)
    expect(seen!.active?.elapsedMs).toBe(42_000)
  })

  it('saves a take stopped with no card on screen, and says so in the shell only after it stopped', async () => {
    await controller.start(START)
    act(() => fake.handlers!.onStatus({ elapsedMs: 1000, level: 0.1 }))
    expect(notices).toEqual([])
    await act(async () => { fake.end() })
    await settle()
    expect(fake.uploads).toEqual(['screen'])
    expect(studio.recordings).toBe(1)
    expect(statusOf()).toBe('completed')
    expect(notices.map((n) => n.text)).toEqual(['Sharing ended, so the recording stopped.', 'Recording saved'])
    expect(notices[1]!.videoId).toBe(VIDEO)
    // The Studio opening later doesn't say it again.
    await mountStudio()
    expect(seen!.claimed.has(controller.getSnapshot().sessions[0]!.id)).toBe(true)
  })

  it('holds a notice made while a take records until it stops', async () => {
    await controller.start(START)
    controller.notify('Something to say')
    expect(notices).toEqual([])
    await act(async () => { await controller.stop(controller.getSnapshot().sessions[0]!.id) })
    await settle()
    expect(notices.map((n) => n.text)).toContain('Something to say')
  })

  it('says what happens through the Studio card while it is on screen, not the shell', async () => {
    await mountStudio()
    await act(async () => { await seen!.start(START) })
    await act(async () => { fake.end() })
    await settle()
    expect(said).toContain('Sharing ended, so the recording stopped.')
    expect(notices).toEqual([])
  })

  it('refuses a second take while one records', async () => {
    expect(await controller.start(START)).not.toBeNull()
    expect(await controller.start(START)).toBeNull()
    expect(controller.getSnapshot().sessions).toHaveLength(1)
  })

  it('says a take that failed needs attention, with no card on screen', async () => {
    studio.answer = 'fail'
    await controller.start(START)
    await act(async () => { fake.end() })
    await settle()
    expect(statusOf()).toBe('failed')
    expect(notices.at(-1)).toMatchObject({ tone: 'error' })
  })
})

describe('the page’s leave guard', () => {
  const on = () => win.added.filter((t) => t === 'beforeunload').length - win.removed.filter((t) => t === 'beforeunload').length

  it('is on while a take records and is saved, and off once it is saved', async () => {
    await controller.start(START)
    expect(on()).toBe(1)
    await act(async () => { fake.end() })
    await settle()
    expect(on()).toBe(0)
  })

  it('comes off when the take fails', async () => {
    studio.answer = 'fail'
    await controller.start(START)
    await act(async () => { fake.end() })
    await settle()
    expect(statusOf()).toBe('failed')
    expect(on()).toBe(0)
  })

  it('comes off when the take is cancelled', async () => {
    await controller.start(START)
    await controller.cancel(controller.getSnapshot().sessions[0]!.id)
    expect(on()).toBe(0)
    expect(notices).toEqual([])
  })

  it('comes off when a failed take kept for Try again is discarded', async () => {
    studio.answer = 'fail'
    await controller.start(START)
    await act(async () => { fake.end() })
    await settle()
    const id = controller.getSnapshot().sessions[0]!.id
    await controller.cancel(id)
    expect(statusOf()).toBe('cancelled')
    expect(fake.discarded).toBe(1)
    expect(on()).toBe(0)
  })
})

describe('the workspace a take started in', () => {
  it('sends nothing for a take once the window is on another workspace, and says it needs attention', async () => {
    await controller.start(START)
    setClientWorkspaceId(WS_B, { persist: false })
    await act(async () => { fake.end() })
    await settle()
    expect(fake.uploads).toEqual([])
    expect(studio.recordings).toBe(0)
    expect(controller.getSnapshot().sessions[0]).toMatchObject({ status: 'failed', retry: true })
    expect(controller.getSnapshot().sessions[0]!.error).toMatch(/^Recording needs attention: it started in another workspace/)
    // Back in its workspace, Try again sends it.
    setClientWorkspaceId(WS_A, { persist: false })
    await act(async () => { await controller.retry(controller.getSnapshot().sessions[0]!.id) })
    await settle()
    expect(statusOf()).toBe('completed')
    expect(studio.recordings).toBe(1)
  })
})

describe('the shell’s guard', () => {
  it('says a take is busy, stops it and waits for it to be saved', async () => {
    expect(recordingBusy()).toBe(false)
    await controller.start(START)
    expect(recordingBusy()).toBe(true)
    await stopRecording(5000)
    expect(recordingBusy()).toBe(false)
    expect(statusOf()).toBe('completed')
  })

  it('forgets everything of the take on sign-out, so the next account sees none of it', async () => {
    await controller.start(START)
    writeHandoff({ sessionId: 'mac-take', following: 'on', lines: [{ text: 'Secret script' }], items: [] })
    controller.notify('held while recording')
    await stopRecording(5000, { reset: true })
    const snap = controller.getSnapshot()
    expect(snap.sessions).toEqual([])
    expect(snap.recorderState).toEqual({ state: 'checking' })
    expect(snap.drafts).toBeNull()
    expect(controller.claimed.size).toBe(0)
    expect(fake.disposed).toBe(1)
    expect(localStorage.getItem(handoffKey('mac-take'))).toBeNull()
    // A new account's Studio starts clean and opens its own recorder.
    await mountStudio()
    expect(seen!.sessions).toEqual([])
    expect(seen!.recorderState.state).toBe('browser')
  })
})

describe('a Mac take stopped from the floating control with no Studio on screen', () => {
  it('is stopped and saved by the page, and the copy left for the control goes', async () => {
    const { DesktopRecorder } = await import('../desktop')
    const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
    const stopped = new Set<(p: unknown) => void>()
    const native = {
      available: async () => true,
      permissions: async () => ({ screenRecording: 'granted', camera: 'granted', microphone: 'granted', accessibility: 'granted', inputMonitoring: 'granted' }),
      requestPermissions: async () => ({}),
      targets: async () => ({ displays: [], apps: [], cameras: [], microphones: [] }),
      start: async () => ({ sessionId: SESSION, files: [{ role: 'screen', path: `/takes/${SESSION}/screen` }], transcription: 'local', liveWords: true }),
      stop: vi.fn(async () => ({ sessionId: SESSION, durationMs: 3000, files: [{ role: 'screen', path: `/takes/${SESSION}/screen`, bytes: 10, codec: 'h264', firstPts: 0, lastPts: 3, offsetMs: 0, durationSeconds: 3 }], trace: null })),
      upload: async () => ({ bytes: 10, sha256: 'a'.repeat(64), parts: [] }),
      discard: async () => ({}),
      cancel: async () => ({}),
      hideControl: async () => ({}),
      showControl: async () => ({}),
      onStopped: (cb: (p: unknown) => void) => { stopped.add(cb); return () => { stopped.delete(cb) } },
    }
    const recorder = new DesktopRecorder(native as never, { get: async () => ({}), post: async () => { throw new Error('offline') }, put: async () => {}, remove: async () => {} } as never)
    const mac = new RecordingController({ opener: async () => ({ kind: 'desktop', recorder }) as never, win: win as never })
    replaceRecordingController(mac)
    await mac.start({ ...START, screen: { kind: 'display', displayId: 1 } })
    expect(mac.getSnapshot().takeLive).toEqual({ sessionId: SESSION, following: 'on' })
    mac.handOff({ sessionId: SESSION, following: 'on', lines: [{ text: 'A line' }], items: [] })
    expect(localStorage.getItem(handoffKey(SESSION))).not.toBeNull()
    // The person presses Stop on the floating control: the app says the take stopped. No Studio is mounted.
    await act(async () => { for (const cb of stopped) cb({ sessionId: SESSION, files: [] }) })
    await settle()
    expect(native.stop).toHaveBeenCalledWith(SESSION)
    expect(mac.getSnapshot().sessions[0]!.status).not.toBe('recording')
    expect(localStorage.getItem(handoffKey(SESSION))).toBeNull()
    expect(notices.map((n) => n.text)[0]).toBe('Recording stopped.')
    mac.reset()
  })
})
