// Filing a Mac take behind the editor (filing.ts), against a made-up Studio that answers as recordings.ts does
// (`received`, `lost`, `attaching`; POST /recordings/:id/tracks and /words) and a made-up Mac (its files' hashes, its
// uploads, its folders, its holds as studio_recorder.rs Leases keeps them). The Studio's own side of each answer is
// proved against its code in lib/studio/server/__tests__/live-takes.test.ts ('a track that did not make it, sent
// again', 'the Mac's words arriving after the take'). Made-up take, hashes and words.
import { describe, expect, it, vi } from 'vitest'
import { compareFiled, Filer, PageLeases, releaseWhenSafe, settleRecording, wordsRefusal, WORDS_MISSES_FOR_GOOD, type FilerDeps, type FilingApi, type LocalTrack } from '../filing'
import { memoryDraftStore, provisionalDraft, provisionalRecord, type ProvisionalRecord } from '../provisional'
import type { FinishedTake, TakeRole } from '../types'
import type { RecordingView } from '@/lib/studio/server/recordings'

vi.mock('../../ui/client', () => ({ request: async () => { throw new Error('the test answers every call itself') } }))

const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
const SESSION_2 = '1f1f1f1f-1111-4222-8333-444444444444'
const PROJECT = '7e7e7e7e-1111-4222-8333-444444444444'
const PROJECT_2 = '8e8e8e8e-1111-4222-8333-444444444444'
const hex = (c: string) => `${c}${'0123456789abcdef'.repeat(4)}`.slice(0, 64)
const BYTES_DIFFER = 'the copy that reached the Studio is not the one on your computer (its bytes differ)'

const takeOf = (sessionId: string): FinishedTake => ({
  kind: 'desktop', sessionId, trace: null, sourceCursorHidden: true, transcript: null, durationSeconds: 10, wordsPending: true, wordsShiftMs: 0,
  files: [
    { role: 'screen', name: 'Screen.mp4', contentType: 'video/mp4', bytes: 5_000, offsetSeconds: 0, durationSeconds: 10, width: 1280, height: 720, frames: 600, fps: 60, sha256: hex('a') },
    { role: 'microphone', name: 'Microphone.m4a', contentType: 'audio/mp4', bytes: 1_600, offsetSeconds: -0.044, durationSeconds: 10.05, sha256: hex('c') },
  ],
})
const local: LocalTrack[] = [{ role: 'screen', sha256: hex('a'), bytes: 5_000 }, { role: 'microphone', sha256: hex('c'), bytes: 1_600 }]

/** A made-up Studio: recordings as recordings.ts answers them, a log of every call. */
function studio() {
  const log: string[] = []
  const recordings = new Map<string, RecordingView & { input?: Record<string, unknown> }>()
  let uploads = 0
  const behave = {
    /** What the next POST /recordings does: made whole, made without the microphone (its bytes differed), or refused. */
    next: [] as ('whole' | 'mic-differs' | 'mic-fails' | 'screen-differs' | 'fails' | 'elsewhere')[],
    /** How many POST /words fail first (the Studio busy making it, no connection). */
    wordsFail: 0,
    /** POST /recover answers with no code this many times (a Studio that keeps erroring). */
    recoverErrors: 0,
    /** A track sent again imports (true) or fails again. */
    attachWorks: true,
    /** What GET /recordings/:id answers before it is made (rounds of `processing`). */
    processingRounds: 0,
  }
  const made = (id: string, kind: string, input: Record<string, unknown>): RecordingView => {
    const base = { id, status: 'done' as const, progress: 1, step: 'Done', projectId: kind === 'elsewhere' ? '9e9e9e9e-1111-4222-8333-444444444444' : (input.projectId as string) }
    if (kind === 'fails') return { ...base, status: 'failed', error: 'The screen recording could not be imported.' } as RecordingView
    if (kind === 'mic-differs') return { ...base, lost: [{ role: 'microphone', reason: BYTES_DIFFER }], received: { screen: { sha256: hex('a'), bytes: 5_000 } }, note: `The microphone could not be added to this take: ${BYTES_DIFFER}.` }
    if (kind === 'mic-fails') return { ...base, lost: [{ role: 'microphone', reason: 'The file could not be read' }], received: { screen: { sha256: hex('a'), bytes: 5_000 } }, note: 'The microphone could not be added to this take: The file could not be read.' }
    return { ...base, received: { screen: { sha256: hex('a'), bytes: 5_000 }, microphone: { sha256: hex('c'), bytes: 1_600 } } }
  }
  const api: FilingApi = {
    async get<T>(url: string): Promise<T> {
      log.push(`GET ${url}`)
      const id = /recordings\/([^/?]+)/.exec(url)![1]!
      const r = recordings.get(id)!
      if (behave.processingRounds > 0) { behave.processingRounds--; return { recording: { ...r, status: 'processing', progress: 0.5 } } as T }
      // A track sent again: imported by the next look.
      if (r.attaching?.length) {
        const view: RecordingView = behave.attachWorks ? { ...r, attaching: undefined, lost: undefined, note: undefined, received: { ...r.received, microphone: { sha256: hex('c'), bytes: 1_600 } } } : { ...r, attaching: undefined }
        recordings.set(id, view)
        return { recording: view } as T
      }
      return { recording: r } as T
    },
    async post<T>(url: string, body?: unknown): Promise<T> {
      const b = (body ?? {}) as Record<string, unknown>
      log.push(`POST ${url}`)
      if (url.endsWith('/uploads')) return { uploadKey: `uploads/0e0e0e0e-1111-4222-8333-${String(++uploads).padStart(12, '0')}`, parts: [{ index: 0, bytes: b.bytes, url: 'fake://upload', headers: {} }] } as T
      if (url.includes('/recordings?wait=1')) {
        const kind = behave.next.shift() ?? 'whole'
        if (kind === 'screen-differs') throw Object.assign(new Error(`The screen recording could not be imported: ${BYTES_DIFFER}. It is kept on your computer: send it again.`), { code: undefined })
        const id = `r-${recordings.size + 1}`
        recordings.set(id, { ...made(id, kind, b), input: b })
        return { recording: recordings.get(id)! } as T
      }
      if (url.endsWith('/tracks')) {
        const id = /recordings\/([^/]+)\/tracks/.exec(url)![1]!
        const r = recordings.get(id)!
        log.push(`  attach ${b.role} ${b.uploadKey} ${b.sha256 === hex('c') ? 'with the recorder’s hash' : 'without'}`)
        recordings.set(id, { ...r, attaching: [b.role as 'microphone'] })
        return { recording: recordings.get(id)! } as T
      }
      if (url.endsWith('/words')) {
        if (behave.wordsFail > 0) { behave.wordsFail--; throw Object.assign(new Error('The recording is being put together. Try again in a moment.'), { code: 'BUSY' }) }
        const id = /recordings\/([^/]+)\/words/.exec(url)![1]!
        const r = recordings.get(id)!
        if (!r.input?.transcript) r.input = { ...r.input, transcript: b }
        return { recording: r } as T
      }
      if (url.endsWith('/recover')) {
        if (behave.recoverErrors > 0) { behave.recoverErrors--; throw new Error('Something went wrong on the Studio.') }
        const id = `r-${recordings.size + 1}`
        recordings.set(id, { ...made(id, behave.next.shift() ?? 'whole', b), input: b })
        return { recording: recordings.get(id)! } as T
      }
      throw new Error(`unexpected ${url}`)
    },
  }
  return { api, log, recordings, behave }
}

/** A made-up Mac: its files' hashes, its uploads (whole files), its folders, and holds as studio_recorder.rs keeps them. */
function mac() {
  const log: string[] = []
  const folders = new Set([SESSION, SESSION_2])
  const held = new Map<string, string>()
  const native = {
    takeMedia: async () => ({ tracks: local }),
    upload: async (session: string, role: string) => void log.push(`upload ${role} of ${session.slice(0, 4)}`),
    discard: async (session: string) => { folders.delete(session); log.push(`discard ${session.slice(0, 4)}`) },
    hold: async (session: string, holder: string, release?: boolean) => {
      if (release) { if (held.get(session) === holder) held.delete(session); return { held: false } }
      if (held.has(session) && held.get(session) !== holder) return { held: false }
      held.set(session, holder)
      return { held: true }
    },
    words: async (): Promise<{ transcript: unknown; pending: boolean }> => ({ transcript: null, pending: false }),
  }
  return { native, log, folders, held }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const none = async () => undefined

function setup(s = studio(), m = mac(), store = memoryDraftStore(), holder = 'page-a', more: Partial<FilerDeps> = {}) {
  const states: Record<string, { failed?: string; step: string } | null> = {}
  const filed: string[] = []
  const uploaded: { session: string; whole: boolean }[] = []
  const order: string[] = []
  const leases = new PageLeases(m.native, holder, 1e9)
  const kept: string[] = []
  const filer = new Filer({
    store, api: s.api, native: m.native, leases, sleep: none, alive: () => true, onKept: (_id, note) => kept.push(note),
    uploadTake: async (take, whole) => {
      uploaded.push({ session: take.sessionId, whole })
      if (whole) for (const f of take.files) await m.native.upload(take.sessionId, f.role)
      return { screen: whole ? 'uploads/0e0e0e0e-1111-4222-8333-000000000999' : `live/t/screen`, microphone: whole ? 'uploads/0e0e0e0e-1111-4222-8333-000000000998' : `live/t/microphone` } as Partial<Record<TakeRole, string>>
    },
    sendUnfinished: async () => { order.push('send the last pieces'); return 1 },
    onState: (projectId, state) => { states[projectId] = state },
    onFiled: (projectId) => filed.push(projectId),
    ...more,
  })
  return { filer, s, m, store, states, filed, uploaded, order, leases, kept }
}

async function draftRecord(store: ReturnType<typeof memoryDraftStore>, sessionId: string, projectId: string, extra: Partial<ProvisionalRecord> = {}) {
  const take = takeOf(sessionId)
  const draft = provisionalDraft({ take, media: { tracks: local, waveform: null }, projectId, title: 't' })!
  const record = { ...provisionalRecord(draft, { sessionId, takeId: null, title: 't', files: take.files, take }), ...extra }
  await store.put(record)
  return { take, record }
}

describe('the files on this computer go only once the Studio holds every byte of them', () => {
  it('compares what the Studio received, track by track, with the files here', () => {
    const done = (extra: Partial<RecordingView>): RecordingView => ({ id: 'r', status: 'done', progress: 1, step: '', ...extra })
    const all = { screen: { sha256: hex('a'), bytes: 5_000 }, microphone: { sha256: hex('c'), bytes: 1_600 } }
    expect(compareFiled(done({ received: all }), local)).toMatchObject({ safe: true, resend: [] })
    // The Studio has fewer bytes of the screen (a short take brought back from its pieces): kept, nothing it can be sent as.
    expect(compareFiled(done({ received: { ...all, screen: { sha256: hex('9'), bytes: 4_000 } } }), local)).toMatchObject({ safe: false, short: ['screen'], resend: [] })
    expect(compareFiled(done({ received: { screen: all.screen }, lost: [{ role: 'microphone', reason: BYTES_DIFFER }] }), local)).toMatchObject({ safe: false, resend: ['microphone'] })
    expect(compareFiled(done({ received: all, attaching: ['microphone'] }), local)).toMatchObject({ safe: false, waiting: true })
    expect(compareFiled({ status: 'processing' }, local)).toMatchObject({ safe: false, waiting: true })
  })

  it('a microphone whose import fails is kept, in each path: after a "Preparing" take, in the editor’s filing, and at the next launch', async () => {
    const s = studio()
    s.behave.attachWorks = false
    s.behave.next = ['mic-fails', 'mic-fails']
    const m = mac()
    // The "Preparing your recording" path (useManualRecording finish): made, then let go only when safe.
    const first = await s.api.post<{ recording: RecordingView }>('/x/recordings?wait=1', {})
    const kept = await releaseWhenSafe({ api: s.api, native: m.native, sleep: none }, first.recording.id, SESSION, { rounds: 4 })
    expect(kept.safe).toBe(false)
    expect(kept.note).toMatch(/microphone could not be sent again|missing the microphone/)
    expect(m.folders.has(SESSION)).toBe(true)
    expect(m.log).toContain(`upload microphone of ${SESSION.slice(0, 4)}`)
    // The editor's path (Filer.release after the edit is on the Studio).
    const { filer, store } = setup(s, m)
    await draftRecord(store, SESSION_2, PROJECT_2, { recordingId: 'r-2', state: 'adopted', wordsSent: true })
    await s.api.post('/x/recordings?wait=1', {})
    const settled = await filer.release(PROJECT_2)
    expect(settled.safe).toBe(false)
    expect(m.folders.has(SESSION_2)).toBe(true)
    // The next launch (desktop.ts sendAll) settles the same way: desktop-live.test.ts runs it against the Studio's code.
  })

  it('Try again after the Studio refused the microphone’s bytes sends the file again, whole under a new upload, and the voice arrives', async () => {
    const { filer, s, m, store, filed } = setup()
    s.behave.next = ['mic-differs']
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    expect(filed).toEqual([PROJECT])
    expect(s.recordings.get('r-1')!.note).toContain(BYTES_DIFFER)
    await store.put({ ...(await store.get(PROJECT))!, state: 'adopted', wordsSent: true })
    const settled = await filer.release(PROJECT)
    expect(settled.safe).toBe(true)
    expect(s.log.filter((l) => l.startsWith('  attach'))).toEqual(['  attach microphone uploads/0e0e0e0e-1111-4222-8333-000000000001 with the recorder’s hash'])
    expect(m.log).toEqual([`upload microphone of ${SESSION.slice(0, 4)}`, `discard ${SESSION.slice(0, 4)}`])
    expect(s.recordings.get('r-1')!.received?.microphone).toEqual({ sha256: hex('c'), bytes: 1_600 })
  })

  it('a screen the Studio refused: Try again uploads every file again whole, never the pieces it refused', async () => {
    const { filer, s, store, states, uploaded, filed } = setup()
    s.behave.next = ['screen-differs', 'whole']
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    expect(states[PROJECT]?.failed).toMatch(/could not be filed: The screen recording could not be imported: the copy that reached the Studio is not the one on your computer/)
    expect((await store.get(PROJECT))!.state).toBe('failed')
    await filer.refile(PROJECT)
    expect(uploaded).toEqual([{ session: SESSION, whole: false }, { session: SESSION, whole: true }])
    expect(filed).toEqual([PROJECT])
  })
})

describe('each take is filed on its own', () => {
  it('two takes, the first fails, the second files; Try again on the first sends the first', async () => {
    const { filer, s, store, uploaded, filed } = setup()
    s.behave.next = ['screen-differs', 'whole', 'whole']
    await draftRecord(store, SESSION, PROJECT)
    await draftRecord(store, SESSION_2, PROJECT_2)
    await filer.start(takeOf(SESSION), PROJECT, 'first')
    await filer.start(takeOf(SESSION_2), PROJECT_2, 'second')
    expect(filed).toEqual([PROJECT_2])
    await filer.refile(PROJECT)
    expect(uploaded.map((u) => [u.session, u.whole])).toEqual([[SESSION, false], [SESSION_2, false], [SESSION, true]])
    expect(filed).toEqual([PROJECT_2, PROJECT])
    expect((s.recordings.get('r-2')!.input as { title?: string }).title).toBe('first')
  })

  it('after a reload mid-filing: the last pieces are sent before the take is brought back, and the folder stays while the Studio has fewer bytes', async () => {
    const { filer, s, m, store, order, filed } = setup()
    await draftRecord(store, SESSION, PROJECT, { takeId: 'take-1' })
    s.api.post = ((post) => async <T,>(url: string, body?: unknown): Promise<T> => { if (url.endsWith('/recover')) order.push('bring it back'); return post<T>(url, body) })(s.api.post.bind(s.api))
    expect(await filer.resume((await store.get(PROJECT))!)).toBe(true)
    for (let i = 0; i < 20; i++) await tick()
    expect(order).toEqual(['send the last pieces', 'bring it back'])
    expect(filed).toEqual([PROJECT])
    expect(s.log.find((l) => l.includes('/recover'))).toBeTruthy()
    // Brought back from fewer bytes than recorded (the Studio's screen is short): never let go of.
    s.recordings.set('r-1', { ...s.recordings.get('r-1')!, received: { screen: { sha256: hex('9'), bytes: 4_000 }, microphone: { sha256: hex('c'), bytes: 1_600 } } })
    await store.put({ ...(await store.get(PROJECT))!, state: 'adopted', wordsSent: true })
    expect((await filer.release(PROJECT)).safe).toBe(false)
    expect(m.folders.has(SESSION)).toBe(true)
  })

  it('a take that never reached the Studio (offline), found after a restart, is filed whole from the computer', async () => {
    const { filer, store, uploaded, filed } = setup()
    await draftRecord(store, SESSION, PROJECT, { takeId: null })
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 20; i++) await tick()
    expect(uploaded).toEqual([{ session: SESSION, whole: true }])
    expect(filed).toEqual([PROJECT])
  })

  it('another window holds the take: this one leaves it alone (and takes it once that window let go)', async () => {
    const m = mac()
    const a = setup(studio(), m, memoryDraftStore(), 'page-a')
    const store = a.store
    await draftRecord(store, SESSION, PROJECT, { takeId: 'take-1' })
    const b = setup(studio(), m, store, 'page-b')
    expect(await a.filer.resume((await store.get(PROJECT))!)).toBe(true)
    expect(await b.filer.resume((await store.get(PROJECT))!)).toBe(false)
    expect(b.order).toEqual([])
    await new PageLeases(m.native, 'page-a').hold(SESSION) // the same page renews
    expect(m.held.get(SESSION)).toBe('page-a')
    m.held.delete(SESSION) // page A went (pagehide let go)
    expect(await b.filer.resume((await store.get(PROJECT))!)).toBe(true)
  })
})

describe('words that come after Stop', () => {
  const words = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]
  it('before the recording is handed over: they go with it, and into the record (base and draft)', async () => {
    const { filer, s, store, leases } = setup()
    await draftRecord(store, SESSION, PROJECT)
    await leases.hold(SESSION) // the page that recorded it holds it from Start
    await filer.heardRaw(SESSION, { words })
    const record = (await store.get(PROJECT))!
    expect(record.base.transcripts[0]!.words.map((w) => w.text)).toEqual(['Hello', 'there'])
    expect(record.draft.transcripts).toEqual(record.base.transcripts)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    expect((s.recordings.get('r-1')!.input as { transcript?: { words: unknown[] } }).transcript?.words).toHaveLength(2)
    expect(s.log.some((l) => l.endsWith('/words'))).toBe(false)
  })
  it('after it was handed over: sent to the recording once', async () => {
    const { filer, s, store } = setup()
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    await filer.heardRaw(SESSION, { words })
    await filer.heardRaw(SESSION, { words })
    expect(s.log.filter((l) => l.endsWith('/words'))).toHaveLength(1)
    expect((await store.get(PROJECT))!.wordsSent).toBe(true)
  })
})

describe('settling never waits when asked for one look', () => {
  it('a recording still being made: one look, no wait, kept', async () => {
    const s = studio()
    s.behave.processingRounds = 5
    await s.api.post('/x/recordings?wait=1', {})
    const sleep = vi.fn(none)
    const m = mac()
    expect((await settleRecording({ api: s.api, native: m.native, sleep }, 'r-1', SESSION, { rounds: 1 })).safe).toBe(false)
    expect(sleep).not.toHaveBeenCalled()
    expect(m.folders.has(SESSION)).toBe(true)
  })
})

describe('the second review', () => {
  const words = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]

  it('after a restart, Try again on a recording that failed brings the take back again (never follows the failed one)', async () => {
    const { filer, s, store, states, filed } = setup()
    s.behave.next = ['fails']
    await draftRecord(store, SESSION, PROJECT, { takeId: 'take-1' })
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 20; i++) await tick()
    expect(states[PROJECT]?.failed).toMatch(/could not be filed: The screen recording could not be imported/)
    expect((await store.get(PROJECT))!.recordingId).toBeNull()
    // A restart: a new page, the record as kept.
    const again = setup(s, mac(), store)
    s.behave.next = ['whole']
    await again.filer.resume((await store.get(PROJECT))!)
    await again.filer.refile(PROJECT)
    expect(s.log.filter((l) => l.endsWith('/recover'))).toHaveLength(2)
    expect(again.filed).toEqual([PROJECT])
    expect(filed).toEqual([])
  })

  it('Try again on a recording still being made follows it, never uploads the take again (no "video taken")', async () => {
    const { filer, s, store, uploaded, filed } = setup()
    await draftRecord(store, SESSION, PROJECT)
    await s.api.post('/x/recordings?wait=1', { projectId: PROJECT })
    await store.put({ ...(await store.get(PROJECT))!, recordingId: 'r-1', state: 'failed', failed: 'gave up following' })
    await filer.refile(PROJECT)
    expect(uploaded).toEqual([])
    expect(filed).toEqual([PROJECT])
  })

  it('bringing a take back ends, plainly, when the Studio keeps erroring (no code), with Try again', async () => {
    const { filer, s, store, states } = setup()
    s.behave.recoverErrors = 1_000
    await draftRecord(store, SESSION, PROJECT, { takeId: 'take-1' })
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 20; i++) await tick()
    expect(states[PROJECT]?.failed).toMatch(/Something went wrong on the Studio/)
    expect(s.log.filter((l) => l.endsWith('/recover')).length).toBeLessThan(5)
  })

  it('words the Studio could not take yet (busy, no connection) are sent again until they are, and again after a restart', async () => {
    const { filer, s, store, leases } = setup()
    s.behave.wordsFail = 3
    await draftRecord(store, SESSION, PROJECT)
    await leases.hold(SESSION)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    await filer.heardRaw(SESSION, { words })
    for (let i = 0; i < 30; i++) await tick()
    expect(s.log.filter((l) => l.endsWith('/words'))).toHaveLength(4)
    expect((await store.get(PROJECT))!.wordsSent).toBe(true)
    // A record whose words never reached the Studio (the page closed first): its next page sends them, whatever its state.
    await store.put({ ...(await store.get(PROJECT))!, wordsSent: false, state: 'adopted' })
    const next = setup(s, mac(), store, 'page-b')
    await next.filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 30; i++) await tick()
    expect(s.log.filter((l) => l.endsWith('/words'))).toHaveLength(5)
  })

  it('words that come between Stop and the record being kept reach the record and the editor, not only the request', async () => {
    const { filer, store, leases } = setup()
    const take = takeOf(SESSION)
    await leases.hold(SESSION)
    await filer.heardRaw(SESSION, { words }, 0) // no record yet
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(take, PROJECT, 't')
    const record = (await store.get(PROJECT))!
    expect(record.heard?.map((w) => w.text)).toEqual(['Hello', 'there'])
    expect(record.draft.transcripts[0]!.words.map((w) => w.text)).toEqual(['Hello', 'there'])
  })

  it('a window that does not hold the take never writes its draft nor sends its words', async () => {
    const m = mac()
    const store = memoryDraftStore()
    const a = setup(studio(), m, store, 'page-a')
    const b = setup(a.s, m, store, 'page-b')
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1' })
    await a.leases.hold(SESSION)
    await b.filer.heardRaw(SESSION, { words })
    expect((await store.get(PROJECT))!.heard).toBeUndefined()
    expect(a.s.log.filter((l) => l.endsWith('/words'))).toEqual([])
  })

  it('waits for the words before the edit is carried on, at most as long as asked', async () => {
    const { filer, store } = setup()
    await draftRecord(store, SESSION, PROJECT)
    expect(await filer.wordsSettled(PROJECT, 3_000)).toBe(false) // still being read on the Mac, never came
    await store.put({ ...(await store.get(PROJECT))!, heard: words, wordsSent: true })
    expect(await filer.wordsSettled(PROJECT, 3_000)).toBe(true)
  })

  it('a take brought back elsewhere first: the recording names another video, and it is adopted under that one', async () => {
    const { filer, s, store, filed } = setup()
    s.behave.next = ['elsewhere']
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    expect(filed).toEqual([PROJECT])
    expect((await store.get(PROJECT))!.filedAs).toBe('9e9e9e9e-1111-4222-8333-444444444444')
  })

  it('files kept when a resumed adopted take is let go of: the note is said, never thrown away', async () => {
    const { filer, s, store, kept } = setup()
    s.behave.next = ['mic-fails']
    s.behave.attachWorks = false
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'adopted', wordsSent: true })
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 50; i++) await tick()
    expect(kept[0]).toMatch(/microphone/)
  })
})

describe('the third review', () => {
  const words = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]

  it('a filed take, its edit not on the video yet, is never let go of: its record and edit stay', async () => {
    const { filer, s, m, store } = setup()
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'filed' })
    const settled = await filer.release(PROJECT)
    expect(settled.safe).toBe(false)
    expect(settled.note).toMatch(/Your edits are not on the video yet/)
    expect(m.log).not.toContain(`discard ${SESSION.slice(0, 4)}`)
    expect(m.folders.has(SESSION)).toBe(true)
  })

  it('an adopted take whose edits are still to be saved over the Studio’s keeps its files, until the person lets go anyway', async () => {
    const { filer, s, m, store } = setup()
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'adopted', saveOwed: true, wordsSent: true })
    expect((await filer.release(PROJECT)).note).toMatch(/not saved onto its video yet, so its files are kept on this computer. Record lists it: Put my edits on it saves them there./)
    expect(m.folders.has(SESSION)).toBe(true)
    // The save landed (App.tsx clears saveOwed through the same keeper): the files go.
    void filer.records.update(PROJECT, (r) => ({ ...r, saveOwed: undefined }))
    expect((await filer.release(PROJECT)).safe).toBe(true)
    expect(m.folders.has(SESSION)).toBe(false)
    // Asked anyway (the row told the person to check the video first).
    await draftRecord(store, SESSION_2, PROJECT_2, { recordingId: 'r-1', state: 'adopted', saveOwed: true, wordsSent: true })
    expect((await filer.release(PROJECT_2, { anyway: true })).safe).toBe(true)
  })

  it('words kept beside a filed or adopted take reach its recording after a reload', async () => {
    for (const state of ['filed', 'adopted'] as const) {
      const { filer, s, m, store } = setup()
      m.native.words = async () => ({ transcript: { words }, pending: false })
      await s.api.post('/x/recordings?wait=1', {})
      await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state, take: { ...takeOf(SESSION), transcript: null } })
      await filer.resume((await store.get(PROJECT))!)
      for (let i = 0; i < 30; i++) await tick()
      expect(s.log.filter((l) => l.endsWith('/words'))).toHaveLength(1)
      expect((await store.get(PROJECT))!.wordsSent).toBe(true)
    }
  })

  it('no words kept and none still being read: nothing to wait for (never the full minute)', async () => {
    const { filer, store } = setup()
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'filed' })
    expect((await store.get(PROJECT))!.take?.wordsPending).toBe(true)
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 20; i++) await tick()
    expect(await filer.wordsSettled(PROJECT, 0)).toBe(true)
  })

  it('words the Studio refuses for good are never sent again (another member), and the person is told once', async () => {
    const dropped: string[] = []
    const { filer, s, store, leases } = setup(studio(), mac(), memoryDraftStore(), 'page-a', { onWordsDropped: (_id, note) => void dropped.push(note) })
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-other', heard: words })
    await leases.hold(SESSION)
    const post = s.api.post.bind(s.api)
    let tries = 0
    s.api.post = (async <T,>(url: string, body?: unknown): Promise<T> => {
      // Refused a few times, then taken (so a filing that asks for ever is caught by the count, never hangs the test).
      if (url.endsWith('/words')) { if (++tries <= 5) throw Object.assign(new Error('Only the person recording can send a recording'), { status: 403, code: 'FORBIDDEN' }); return {} as T }
      return post<T>(url, body)
    }) as FilingApi['post']
    await filer.ensureWords(PROJECT)
    expect(tries).toBe(1)
    expect((await store.get(PROJECT))!.wordsRefused).toBe(true)
    expect(await filer.wordsSettled(PROJECT, 0)).toBe(true)
    await filer.ensureWords(PROJECT)
    expect(tries).toBe(1)
    expect(dropped).toEqual(["The words the Mac heard could not be added to this recording's video (Only the person recording can send a recording). You can transcribe it from the Words tab."])
  })

  it('a recording missing here (maybe the wrong workspace open) stops this page only; words are given up after a few launches', async () => {
    const s = studio()
    const store = memoryDraftStore()
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-elsewhere', heard: words })
    let tries = 0
    const post = s.api.post.bind(s.api)
    s.api.post = (async <T,>(url: string, body?: unknown): Promise<T> => {
      if (url.endsWith('/words')) { if (++tries <= 10) throw Object.assign(new Error('Recording not found'), { status: 404, code: 'NOT_FOUND' }); return {} as T }
      return post<T>(url, body)
    }) as FilingApi['post']
    for (let launch = 1; launch <= WORDS_MISSES_FOR_GOOD; launch++) {
      const page = setup(s, mac(), store, `page-${launch}`)
      await page.leases.hold(SESSION)
      await page.filer.ensureWords(PROJECT)
      await page.filer.ensureWords(PROJECT) // asked again on the same page: not counted again
      expect(await page.filer.wordsSettled(PROJECT, 0)).toBe(true) // this page waits on them no more
      expect((await store.get(PROJECT))!.wordsRefused).toBe(launch === WORDS_MISSES_FOR_GOOD ? true : undefined)
    }
    expect(tries).toBe(WORDS_MISSES_FOR_GOOD)
  })

  it('a busy Studio, no connection or a session renewing (401) is tried again; only 400, 403 and 413 are final, a 404 maybe', () => {
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 409, code: 'BUSY' }))).toBeNull()
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 429 }))).toBeNull()
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 401 }))).toBeNull()
    expect(wordsRefusal(new TypeError('Failed to fetch'))).toBeNull()
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 500 }))).toBeNull()
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 409, code: 'NOT_LOST' }))).toBeNull()
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 403, code: 'FORBIDDEN' }))).toBe('final')
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 400 }))).toBe('final')
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 413 }))).toBe('final')
    expect(wordsRefusal(Object.assign(new Error('x'), { status: 404 }))).toBe('missing')
  })

  it('the Mac heard nothing (its event says null): nothing to wait for, so adoption never waits the minute', async () => {
    const { filer, store, leases } = setup()
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'filed' })
    expect(await filer.wordsSettled(PROJECT, 0)).toBe(false)
    await leases.hold(SESSION)
    await filer.wordsEvent({ sessionId: SESSION, transcript: null })
    expect(await filer.wordsSettled(PROJECT, 0)).toBe(true)
  })

  it('a window that does not hold the take never writes it when the Mac heard nothing', async () => {
    const m = mac()
    const store = memoryDraftStore()
    const a = setup(studio(), m, store, 'page-a')
    const b = setup(a.s, m, store, 'page-b')
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1' })
    await a.leases.hold(SESSION)
    await b.filer.wordsEvent({ sessionId: SESSION, transcript: null })
    expect((await store.get(PROJECT))!.take?.wordsPending).toBe(true)
  })

  it('heard nothing before the record was kept: the record waits for no words once it is', async () => {
    const { filer, store, leases } = setup()
    await leases.hold(SESSION)
    await filer.wordsEvent({ sessionId: SESSION, transcript: null })
    await draftRecord(store, SESSION, PROJECT)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    expect(await filer.wordsSettled(PROJECT, 0)).toBe(true)
  })
})

describe('the fifth review', () => {
  const words = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]

  it('the files wait for the Mac’s words (kept beside the take) until they reach the Studio or are given up', async () => {
    const { filer, s, m, store } = setup()
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'adopted', heard: words, wordsMisses: 1 })
    const kept = await filer.release(PROJECT)
    expect(kept.safe).toBe(false)
    expect(kept.note).toMatch(/words the Mac heard have not reached the Studio yet/)
    expect(m.folders.has(SESSION)).toBe(true)
    await store.put({ ...(await store.get(PROJECT))!, wordsSent: true })
    expect((await filer.release(PROJECT)).safe).toBe(true)
  })

  it('a recording made again after the first failed is owed the words afresh (a miss or a no for the old one does not count)', async () => {
    const { filer, s, store, leases } = setup()
    await draftRecord(store, SESSION, PROJECT, { recordingId: null, heard: words, wordsMisses: 2, wordsRefused: true })
    await leases.hold(SESSION)
    await filer.start(takeOf(SESSION), PROJECT, 't')
    for (let i = 0; i < 20; i++) await tick()
    expect(s.log.filter((l) => l.endsWith('/words'))).toHaveLength(1)
    expect((await store.get(PROJECT))!).toMatchObject({ wordsSent: true })
    expect((await store.get(PROJECT))!.wordsRefused).toBeUndefined()
  })

  it('letting go of a filed take whose video changed elsewhere settles it, once the Studio holds every byte', async () => {
    const { filer, s, m, store } = setup()
    s.behave.next = ['mic-fails']
    s.behave.attachWorks = false
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'filed', wordsSent: true })
    expect((await filer.release(PROJECT)).safe).toBe(false) // never without being asked
    const settled = await filer.release(PROJECT, { anyway: true })
    expect(settled.safe).toBe(false) // the Studio lacks the microphone: the files stay
    expect(m.folders.has(SESSION)).toBe(true)
    expect((await store.get(PROJECT))!.state).toBe('adopted')
  })
})

describe('the sixth review', () => {
  const words = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]

  it('words sent to a recording that failed go again to the one brought back after a reload (its recover sends none)', async () => {
    const { filer, s, store } = setup()
    // r-1 had the words, then failed (its id cleared); the take is on the Studio as a live take.
    await draftRecord(store, SESSION, PROJECT, { recordingId: null, takeId: 'take-1', heard: words, wordsSent: true })
    await filer.resume((await store.get(PROJECT))!)
    for (let i = 0; i < 30; i++) await tick()
    const posts = s.log.filter((l) => l.endsWith('/words'))
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(`recordings/${(await store.get(PROJECT))!.recordingId}/words`)
    expect((await store.get(PROJECT))!.wordsSent).toBe(true)
  })

  it('Try again on the same recording three times counts at most one miss on this page (never gives the words up by itself)', async () => {
    const { filer, s, store, leases } = setup()
    await s.api.post('/x/recordings?wait=1', {})
    await draftRecord(store, SESSION, PROJECT, { recordingId: 'r-1', state: 'failed', failed: 'gave up following', heard: words })
    await leases.hold(SESSION)
    const post = s.api.post.bind(s.api)
    s.api.post = (async <T,>(url: string, body?: unknown): Promise<T> => {
      if (url.endsWith('/words')) throw Object.assign(new Error('Recording not found'), { status: 404, code: 'NOT_FOUND' })
      return post<T>(url, body)
    }) as FilingApi['post']
    for (let press = 0; press < 3; press++) {
      await store.put({ ...(await store.get(PROJECT))!, state: 'failed' })
      await filer.refile(PROJECT)
      for (let i = 0; i < 20; i++) await tick()
    }
    expect((await store.get(PROJECT))!.wordsMisses).toBe(1)
    expect((await store.get(PROJECT))!.wordsRefused).toBeUndefined()
  })
})
