// A Mac take opened at Stop before the Studio filed it (provisional.ts), then carried on from the Studio's copies, in
// every order of events: filed before any edit, during and after edits (every step of the undo history moved over),
// after a restart (the edit and its mapping read back from beside the take), with a second device saving the
// video meanwhile (the save over it is refused, the edit kept, nothing applied twice), and when the Studio conformed the
// file instead of keeping it (another frame count: trims moved, playback from the Studio). The Studio's side is its own
// code over the in-memory tables (assets and transcripts registered as an import registers them, the edit it builds,
// the save that refuses anything it did not record). Made-up take, bytes and words.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorProjectSchema, type EditorAsset, type EditorProject } from '@/lib/studio/engine/contracts'
import { buildTakeProject, voiceAsset, wordsOnVoiceClock, type TakeMedia } from '@/lib/studio/engine/take-project'
import { registerAsset, registerTranscript, toTranscript } from '@/lib/studio/server/assets'
import { createVideo, openVideo, saveVideo } from '@/lib/studio/server/videos'
import { fakeContext } from '@/lib/studio/server/__tests__/fake'
import { adoptFiled, withoutTranscripts, filedAssets, hrefsFor, localTakeHref, matchWords, memoryDraftStore, nativeDraftStore, provisionalDraft, provisionalRecord, swapAssets, withWords, type LocalMedia } from '../provisional'
import type { FinishedTake } from '../types'
import { adoptKept, CHANGED_ELSEWHERE, markEditorAdopted } from '../../ui/provisional-editor'

const KEY = 'k'.repeat(64)

const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
const PROJECT = '7e7e7e7e-1111-4222-8333-444444444444'
/** A made-up SHA-256 starting with `c` (not a palindrome, as no real one is). */
const hex = (c: string) => `${c}${'0123456789abcdef'.repeat(4)}`.slice(0, 64)

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  // Nothing of a draft is kept in the browser's storage any more: a page that tried would throw here.
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('no browser storage') }, setItem: () => { throw new Error('no browser storage') }, removeItem: () => undefined })
})

/** A stopped take as the Mac app describes it: a 60 fps screen, a 30 fps camera a quarter second late, the microphone. */
const take: FinishedTake = {
  kind: 'desktop',
  sessionId: SESSION,
  files: [
    { role: 'screen', name: 'Screen recording 14 Nov, 09.41.mp4', contentType: 'video/mp4', bytes: 5_000_000, offsetSeconds: 0, durationSeconds: 10, width: 1280, height: 720, frames: 600, fps: 60 },
    { role: 'camera', name: 'Camera 14 Nov, 09.41.mp4', contentType: 'video/mp4', bytes: 900_000, offsetSeconds: 0.25, durationSeconds: 9.5, width: 640, height: 360, frames: 285, fps: 30 },
    { role: 'microphone', name: 'Microphone 14 Nov, 09.41.m4a', contentType: 'audio/mp4', bytes: 160_000, offsetSeconds: -0.044, durationSeconds: 10.05 },
  ],
  trace: null,
  sourceCursorHidden: true,
  transcript: { words: [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }, { text: 'everyone', startMs: 1500, endMs: 2100 }] },
  durationSeconds: 10,
}
const media: LocalMedia = { tracks: [{ role: 'screen', sha256: hex('a'), bytes: 5_000_000 }, { role: 'camera', sha256: hex('b'), bytes: 900_000 }, { role: 'microphone', sha256: hex('c'), bytes: 160_000 }], waveform: [0.1, 0.4, 0.2] }

const draftOf = () => provisionalDraft({ take, media, projectId: PROJECT, title: 'Recording · 14 Nov' })!

/**
 * What the Studio files for the same take: its imports' assets (named by the hash of what they stored, recording the hash
 * of what they read), registered; the transcript it registers from the words the Mac heard; and the edit it builds.
 * `conformed`: the screen was conformed, not kept (another file, two frames fewer).
 */
async function studioFiles(options: { conformed?: boolean; noCamera?: boolean; noWords?: boolean } = {}) {
  const asset = (provisional: EditorAsset, sha: string, extra: Partial<EditorAsset> = {}, kept = true): EditorAsset => ({
    ...provisional, id: sha, sha256: sha, file: `assets/${sha}.${provisional.kind === 'audio' ? 'm4a' : 'mp4'}`, bytes: provisional.bytes - 100,
    provenance: { recording: 'r-1', role: (provisional.provenance as { role: string }).role, recorder: 'desktop', rawSha256: provisional.sha256, ...(kept ? (provisional.kind === 'video' ? { keptAtFps: provisional.sourceFps } : {}) : { normalizedCfrFps: 60 }) },
    ...extra,
  })
  const draft = draftOf()
  const [screen, camera, mic] = ['screen', 'camera', 'microphone'].map((role) => draft.assets.find((a) => (a.provenance as { role: string }).role === role)!)
  const finals = {
    screen: await registerAsset(env.ctx, options.conformed ? asset(screen!, hex('d'), { sourceFrames: 598, durationSeconds: 598 / 60 }, false) : asset(screen!, hex('d'))),
    camera: options.noCamera ? null : await registerAsset(env.ctx, asset(camera!, hex('e'))),
    microphone: await registerAsset(env.ctx, asset(mic!, hex('f'))),
  }
  const takeMedia: TakeMedia = { screen: finals.screen, camera: finals.camera ? { asset: finals.camera, offsetSeconds: 0.25 } : null, microphone: { asset: finals.microphone, offsetSeconds: -0.044 }, systemAudio: null }
  const voice = voiceAsset(takeMedia)!
  const words = wordsOnVoiceClock(take.transcript!.words, voice)
  const transcript = options.noWords ? null : await registerTranscript(env.ctx, toTranscript(voice.asset, { words, text: words.map((w) => w.text).join(' ') }, 'imported', hex('9'), 'Microphone imported transcript'))
  const project = buildTakeProject({ id: PROJECT, title: 'Recording · 14 Nov', media: takeMedia, transcript })
  await createVideo(env.ctx, project)
  const opened = await openVideo(env.ctx, PROJECT)
  return { finals, project: opened.project, digest: opened.projectDigest }
}

/** An edit made while provisional: the clip trimmed, a word's caption corrected, the camera bubble moved. */
function edit(project: EditorProject): EditorProject {
  const word = project.transcripts[0]!.words[1]!
  const clip = project.clips[0]!
  return EditorProjectSchema.parse({
    ...project,
    title: 'Launch walkthrough',
    clips: [{ ...clip, trimStartSourceFrame: 30, trimEndSourceFrame: 570 }],
    captionCorrections: { [word.id]: 'there,' },
  })
}

describe('a take opened at Stop', () => {
  it('opens in about a millisecond from what the computer says: picture, camera bubble, voice with its waveform and words, played from the computer', () => {
    const started = performance.now()
    const draft = draftOf()
    const ms = performance.now() - started
    expect(ms).toBeLessThan(250)
    const p = draft.project
    expect(p.id).toBe(PROJECT)
    expect(p.output).toEqual({ width: 1280, height: 720, fps: 60 })
    expect(p.clips[0]).toMatchObject({ assetId: hex('a'), trimStartSourceFrame: 0, trimEndSourceFrame: 600 })
    expect(p.presenterTrack?.assetId).toBe(hex('b'))
    expect(p.presenterTrack?.sync).toEqual({ screenAssetId: hex('a'), offsetSeconds: 0.25 })
    expect(p.audioTracks[0]?.segments[0]?.label).toBe(`sync:${hex('a')}@-0.044`)
    expect(p.assets.find((a) => a.id === hex('c'))?.waveform).toEqual([0.1, 0.4, 0.2])
    expect(p.transcripts[0]?.words.map((w) => w.text)).toEqual(['Hello', 'there', 'everyone'])
    // Where its files play from: made from this run's key when it opens, never part of the draft or its record.
    expect(hrefsFor(draft.assets, SESSION, KEY)).toEqual({
      [`assets/${hex('a')}.mp4`]: localTakeHref(KEY, SESSION, 'screen'),
      [`assets/${hex('b')}.mp4`]: localTakeHref(KEY, SESSION, 'camera'),
      [`assets/${hex('c')}.m4a`]: localTakeHref(KEY, SESSION, 'microphone'),
    })
    expect(localTakeHref(KEY, SESSION, 'screen')).toBe(`studio-take://localhost/${KEY}/${SESSION}/screen`)
    expect(JSON.stringify(provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files, take }))).not.toContain('studio-take:')
    // Without a frame count from the recorder the take waits for the Studio as before.
    expect(provisionalDraft({ take: { ...take, files: take.files.map((f) => (f.role === 'screen' ? { ...f, frames: undefined } : f)) }, media, projectId: PROJECT, title: 't' })).toBeNull()
  })
})

describe('carried on from the Studio’s copies', () => {
  it('filed before any edit: the Studio’s own edit is taken as it is (nothing to save), and kept files play on from the computer', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles()
    const adopted = adoptFiled(record, draft.project, studio.project, hrefsFor(draft.assets, SESSION, KEY))
    expect(adopted.edited).toBe(false)
    expect(adopted.project).toEqual(studio.project)
    expect(adopted.local).toEqual({
      [studio.finals.screen.file]: localTakeHref(KEY, SESSION, 'screen'),
      [studio.finals.camera!.file]: localTakeHref(KEY, SESSION, 'camera'),
      [studio.finals.microphone.file]: localTakeHref(KEY, SESSION, 'microphone'),
    })
  })

  it('filed after edits (and during them: every step of the history moves over): the edits land once, on the Studio’s assets, and the Studio’s save takes them', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const edited = edit(draft.project)
    const studio = await studioFiles()
    const adopted = adoptFiled(record, edited, studio.project)
    expect(adopted.edited).toBe(true)
    const p = adopted.project
    expect(p.assets.map((a) => a.id).sort()).toEqual([hex('d'), hex('e'), hex('f')].sort())
    // No reference to a provisional asset is left (the Studio's assets remember the recorded hash as `rawSha256`).
    expect(JSON.stringify({ ...p, assets: [] })).not.toMatch(new RegExp(`${hex('a')}|${hex('b')}|${hex('c')}`))
    expect(p.clips[0]).toMatchObject({ assetId: hex('d'), trimStartSourceFrame: 30, trimEndSourceFrame: 570 })
    expect(p.title).toBe('Launch walkthrough')
    expect(p.presenterTrack?.sync?.screenAssetId).toBe(hex('d'))
    expect(p.audioTracks[0]?.segments.every((s) => s.label === `sync:${hex('d')}@-0.044` && s.assetId === hex('f'))).toBe(true)
    // The Studio's own transcript, the correction carried onto its word.
    expect(p.transcripts).toEqual(studio.project.transcripts)
    expect(p.captionCorrections).toEqual({ [studio.project.transcripts[0]!.words[1]!.id]: 'there,' })
    // The undo history: the step as built becomes the Studio's edit, an edited step is moved over.
    expect(adoptFiled(record, draft.project, studio.project).project).toEqual(studio.project)
    // The Studio takes the save (every asset and word registered), once.
    const saved = await saveVideo(env.ctx, p, studio.digest)
    const stored = (await openVideo(env.ctx, PROJECT)).project
    expect(stored).toEqual(p)
    expect(stored.clips).toHaveLength(1)
    // The same save again (a retry, a second window) is refused by the digest: nothing lands twice.
    await expect(saveVideo(env.ctx, p, studio.digest)).rejects.toMatchObject({ code: 'DIGEST_CONFLICT' })
    expect(saved.projectDigest).not.toBe(studio.digest)
    // And a provisional asset never gets through the Studio's save.
    await expect(saveVideo(env.ctx, edited, saved.projectDigest)).rejects.toMatchObject({ code: 'UNREGISTERED_ASSET' })
  })

  it('after the app was quit and opened again: the edit and its mapping come back from beside the take and are carried on the same', async () => {
    const draft = draftOf()
    // The app's draft files, as studio_recorder_draft_put / draft_get / drafts keep them (one per take folder).
    const disk = new Map<string, string>()
    const app = {
      draftGet: async (sessionId: string) => ({ draft: disk.get(sessionId) ?? null }),
      draftPut: async (sessionId: string, text: string) => void disk.set(sessionId, text),
      drafts: async () => ({ drafts: [...disk].map(([sessionId, text]) => ({ sessionId, draft: text })) }),
    }
    await nativeDraftStore(app).put({ ...provisionalRecord(draft, { sessionId: SESSION, takeId: 'take-1', title: 't', files: take.files, take }), draft: edit(draft.project), recordingId: 'r-1' })
    // A restart: nothing in memory, a new store over the same folder.
    const back = await nativeDraftStore(app).list()
    expect(back.map((r) => [r.projectId, r.recordingId, r.sessionId])).toEqual([[PROJECT, 'r-1', SESSION]])
    expect(await nativeDraftStore(app).get(PROJECT)).toEqual(back[0])
    const studio = await studioFiles()
    const adopted = adoptFiled(back[0]!, back[0]!.draft, studio.project)
    expect(adopted.edited).toBe(true)
    expect(adopted.project.title).toBe('Launch walkthrough')
    await saveVideo(env.ctx, adopted.project, studio.digest)
    // A write the disk refuses is an error the page shows, never a silent success.
    const failing = memoryDraftStore()
    failing.failing = true
    await expect(failing.put(back[0]!)).rejects.toThrow('The disk is full.')
    await expect(nativeDraftStore({ ...app, draftPut: async () => { throw new Error('the edit is too large to keep on this computer') } }).put(back[0]!)).rejects.toThrow('too large')
  })

  it('a second device saved the video meanwhile: the save over it is refused, the edit stays on this computer, nothing is applied twice', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles()
    // The other device opens the Studio's edit and saves a change to it.
    const theirs = { ...studio.project, title: 'Their title' }
    await saveVideo(env.ctx, theirs, studio.digest)
    const adopted = adoptFiled(record, edit(draft.project), studio.project)
    await expect(saveVideo(env.ctx, adopted.project, studio.digest)).rejects.toMatchObject({ code: 'DIGEST_CONFLICT' })
    const stored = (await openVideo(env.ctx, PROJECT)).project
    expect(stored.title).toBe('Their title')
    expect(stored.clips[0]).toMatchObject({ trimStartSourceFrame: 0, trimEndSourceFrame: 600 })
    // Our edit is whole, ready to be offered back.
    expect(adopted.project.clips[0]).toMatchObject({ trimStartSourceFrame: 30, trimEndSourceFrame: 570 })
  })

  it('a filed take whose draft is not open, saved over by a second device: the record keeps the edit, the take is kept, offered back', async () => {
    const draft = draftOf()
    const store = memoryDraftStore()
    await store.put({ ...provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files }), draft: edit(draft.project), recordingId: 'r-1', state: 'filed' })
    const studio = await studioFiles()
    await saveVideo(env.ctx, { ...studio.project, title: 'Their title' }, studio.digest)
    const release = vi.fn(async () => ({ safe: true }))
    const records = { update: async (id: string, fn: (r: NonNullable<Awaited<ReturnType<typeof store.get>>>) => unknown) => { const r = await store.get(id); const next = r && (fn(r) as typeof r); if (next) await store.put(next); return next } }
    // Read when the video was still the Studio's own edit; saved after the other device changed it.
    const deps = { store, records, read: async () => ({ project: studio.project, projectDigest: studio.digest }), save: (id: string, p: EditorProject, digest: string) => saveVideo(env.ctx, p, digest), release }
    const result = await adoptKept(deps, PROJECT)
    expect(result.outcome).toBe('conflict')
    const kept = (await store.get(PROJECT))!
    expect(kept.state).toBe('filed')
    expect(kept.draft.title).toBe('Launch walkthrough')
    expect(release).not.toHaveBeenCalled()
    expect((await openVideo(env.ctx, PROJECT)).project.title).toBe('Their title')
    // No connection: the same, said as such.
    const offline = await adoptKept({ ...deps, save: async () => { throw new TypeError('Failed to fetch') } }, PROJECT)
    expect(offline.outcome).toBe('network')
    expect((await store.get(PROJECT))!.state).toBe('filed')
    // Tried again on the video as it is now: still never written over (it is not the edit the Studio filed).
    const now = await openVideo(env.ctx, PROJECT)
    expect((await adoptKept({ ...deps, read: async () => now }, PROJECT)).outcome).toBe('conflict')
    expect((await openVideo(env.ctx, PROJECT)).project.title).toBe('Their title')
    expect(release).not.toHaveBeenCalled()
  })

  it('a filed take whose draft is not open, nobody else saved: the edit lands once, the record is done, the files may go', async () => {
    const draft = draftOf()
    const store = memoryDraftStore()
    await store.put({ ...provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files }), draft: edit(draft.project), recordingId: 'r-1', state: 'filed' })
    const studio = await studioFiles()
    const release = vi.fn(async () => ({ safe: true }))
    const records = { update: async (id: string, fn: (r: NonNullable<Awaited<ReturnType<typeof store.get>>>) => unknown) => { const r = await store.get(id); const next = r && (fn(r) as typeof r); if (next) await store.put(next); return next } }
    const deps = { store, records, read: () => openVideo(env.ctx, PROJECT), save: (id: string, p: EditorProject, digest: string) => saveVideo(env.ctx, p, digest), release }
    // The first try never reached the Studio; the second lands.
    expect((await adoptKept({ ...deps, save: async () => { throw new TypeError('Failed to fetch') } }, PROJECT)).outcome).toBe('network')
    expect(release).not.toHaveBeenCalled()
    expect((await adoptKept(deps, PROJECT)).outcome).toBe('saved')
    expect((await store.get(PROJECT))!.state).toBe('adopted')
    expect(release).toHaveBeenCalledWith(PROJECT)
    expect((await openVideo(env.ctx, PROJECT)).project.title).toBe('Launch walkthrough')
    void studio
  })

  it('the Studio conformed the screen instead of keeping it: trims are kept inside its frames, and it plays from the Studio', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles({ conformed: true })
    const touched = EditorProjectSchema.parse({ ...draft.project, clips: [{ ...draft.project.clips[0]!, trimStartSourceFrame: 100, trimEndSourceFrame: 600 }] })
    const adopted = adoptFiled(record, touched, studio.project, hrefsFor(draft.assets, SESSION, KEY))
    expect(adopted.project.clips[0]).toMatchObject({ assetId: hex('d'), trimStartSourceFrame: 100, trimEndSourceFrame: 598 })
    expect(adopted.local[studio.finals.screen.file]).toBeUndefined()
    expect(adoptFiled(record, touched, studio.project, hrefsFor(draft.assets, SESSION, KEY)).local[studio.finals.microphone.file]).toBe(localTakeHref(KEY, SESSION, 'microphone'))
    await saveVideo(env.ctx, adopted.project, studio.digest)
    // Another rate (a recording conformed to 30): trims move by time.
    const thirty = swapAssets(touched, [{ provisional: draft.assets[0]!, final: { ...studio.finals.screen, sourceFps: 30, sourceFrames: 299 } }])
    expect(thirty.clips[0]).toMatchObject({ trimStartSourceFrame: 50, trimEndSourceFrame: 299 })
  })

  it('a track the Studio could not import is taken out of the edit, never left pointing at nothing', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles({ noCamera: true })
    const { missing } = filedAssets(record.assets, studio.project)
    expect(missing.map((a) => a.id)).toEqual([hex('b')])
    const adopted = adoptFiled(record, edit(draft.project), studio.project)
    expect(adopted.project.presenterTrack).toBeNull()
    expect(adopted.project.assets.some((a) => a.id === hex('b'))).toBe(false)
    await saveVideo(env.ctx, adopted.project, studio.digest)
  })

  it('the Studio heard one word more than the Mac (a word clipped at the end): corrections stay on their own words, matched by time', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles()
    // The Studio's transcript has an extra first word ("So"), shifting every position by one.
    const theirs = studio.project.transcripts[0]!
    const shifted = { ...theirs, words: [{ id: 'w-extra-0', text: 'So', startMs: 100, endMs: 300 }, ...theirs.words.map((w, i) => ({ ...w, id: `w-studio-${i}`, startMs: w.startMs + 30, endMs: w.endMs + 30 }))] }
    const ours = draft.project.transcripts[0]!
    // "there," on our second word: by position it would land on the Studio's "Hello".
    const edited = EditorProjectSchema.parse({ ...draft.project, captionCorrections: { [ours.words[1]!.id]: 'there,', [ours.words[2]!.id]: 'everyone!' } })
    const { filed } = filedAssets(record.assets, studio.project)
    const moved = swapAssets(edited, filed, { transcripts: [shifted] })
    expect(moved.captionCorrections).toEqual({ 'w-studio-1': 'there,', 'w-studio-2': 'everyone!' })
    // Same text further than WORD_MATCH_MS away is another word; a word the Studio did not hear loses its correction.
    expect([...matchWords([{ id: 'a', text: 'there', startMs: 1000 }], [{ id: 'b', text: 'there', startMs: 1500 }])]).toEqual([])
    expect([...matchWords([{ id: 'a', text: 'There,', startMs: 1000 }], [{ id: 'b', text: 'there', startMs: 1060 }])]).toEqual([['a', 'b']])
  })
})

describe('words that arrive after Stop', () => {
  const silent: FinishedTake = { ...take, transcript: null }
  const late = [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1400 }]
  it('the draft opens with no words; they are added to the edit (and its base) when they come, as the Studio would build them', () => {
    const draft = provisionalDraft({ take: silent, media, projectId: PROJECT, title: 't' })!
    expect(draft.project.transcripts).toEqual([])
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: silent.files })
    const withHeard = withWords(record.base, record.assets, record, late)
    expect(withHeard.transcripts[0]!.words.map((w) => w.text)).toEqual(['Hello', 'there'])
    expect(withHeard.transcripts[0]!.assetId).toBe(hex('c'))
    // Exactly what the draft would have been, had the words come before Stop.
    expect(withHeard.transcripts).toEqual(provisionalDraft({ take: { ...silent, transcript: { words: late } }, media, projectId: PROJECT, title: 't' })!.project.transcripts)
    // Applied to an edited step too (undo keeps them), never twice.
    const edited = EditorProjectSchema.parse({ ...draft.project, title: 'Edited' })
    const both = withWords(withWords(edited, record.assets, record, late), record.assets, record, late)
    expect(both.transcripts).toHaveLength(1)
    expect(both.title).toBe('Edited')
    // An untouched draft whose base took the words too is still not edited: the Studio's own edit is taken.
    expect(JSON.stringify(withWords(record.draft, record.assets, record, late))).toBe(JSON.stringify(withHeard))
  })
})

describe('the second review', () => {
  const recordsOf = (store: ReturnType<typeof memoryDraftStore>) => ({ update: async (id: string, fn: (r: NonNullable<Awaited<ReturnType<typeof store.get>>>) => unknown) => { const r = await store.get(id); const next = r && (fn(r) as typeof r); if (next) await store.put(next); return next } })

  it('carried on in the editor, then the other version loaded and nothing saved: a later launch never saves the old draft over the video', async () => {
    const draft = draftOf()
    const store = memoryDraftStore()
    await store.put({ ...provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files }), draft: edit(draft.project), recordingId: 'r-1', state: 'filed' })
    const studio = await studioFiles()
    const records = recordsOf(store)
    // The editor carries it on: noted beside the take before it goes on.
    await markEditorAdopted(records, PROJECT, studio.digest)
    expect((await store.get(PROJECT))!).toMatchObject({ state: 'adopted', studioDigest: studio.digest })
    // The person then loads the other version (words added by the Studio, another device) and saves nothing.
    await saveVideo(env.ctx, { ...studio.project, title: 'Their title' }, studio.digest)
    const save = vi.fn(async () => undefined)
    const release = vi.fn(async () => ({ safe: true }))
    const result = await adoptKept({ store, records, read: () => openVideo(env.ctx, PROJECT), save, release }, PROJECT)
    expect(result.outcome).toBe('already')
    expect(save).not.toHaveBeenCalled()
    expect((await openVideo(env.ctx, PROJECT)).project.title).toBe('Their title')
    // A record that could not be noted stops the editor from carrying on (it says so, with Try again).
    const failing = memoryDraftStore()
    failing.failing = true
    await expect(markEditorAdopted(recordsOf(failing), PROJECT, studio.digest)).rejects.toThrow('could not keep a note of it')
  })

  it('the Studio has no words of the voice yet: the draft keeps its own (and its corrections), said as not yet registered', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles({ noWords: true })
    const adopted = adoptFiled(record, edit(draft.project), studio.project)
    const word = draft.project.transcripts[0]!.words[1]!
    expect(adopted.project.transcripts).toHaveLength(1)
    expect(adopted.project.transcripts[0]!.assetId).toBe(hex('f'))
    expect(adopted.project.captionCorrections).toEqual({ [word.id]: 'there,' })
    expect(adopted.unregistered).toEqual([adopted.project.transcripts[0]!.id])
    // Saved without them only past the wait (the words follow to the Studio): what is saved is what it takes.
    await saveVideo(env.ctx, withoutTranscripts(adopted.project, adopted.unregistered), studio.digest)
  })

  it('the draft has no words but the Studio has (they came after the draft opened): the Studio’s are kept', async () => {
    const silent = { ...take, transcript: null }
    const draft = provisionalDraft({ take: silent, media, projectId: PROJECT, title: 't' })!
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles()
    const edited = EditorProjectSchema.parse({ ...draft.project, title: 'Edited' })
    const adopted = adoptFiled(record, edited, studio.project)
    expect(adopted.project.transcripts).toEqual(studio.project.transcripts)
    expect(adopted.unregistered).toEqual([])
    await saveVideo(env.ctx, adopted.project, studio.digest)
  })

  it('made into another video than the draft’s (brought back elsewhere): adopted under the Studio’s id', async () => {
    const draft = draftOf()
    const record = provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files })
    const studio = await studioFiles()
    const other = { ...studio.project, id: '9e9e9e9e-1111-4222-8333-444444444444' }
    expect(adoptFiled(record, edit(draft.project), other).project.id).toBe(other.id)
    expect(adoptFiled(record, draft.project, other).project.id).toBe(other.id)
  })
})

describe('the fourth review: a filed take is never stuck', () => {
  const recordsOf = (store: ReturnType<typeof memoryDraftStore>, refuseAdopted = { on: false }) => ({ update: async (id: string, fn: (r: NonNullable<Awaited<ReturnType<typeof store.get>>>) => unknown) => {
    const r = await store.get(id); const next = r && (fn(r) as typeof r)
    if (next?.state === 'adopted' && refuseAdopted.on) throw new Error('The disk is full.')
    if (next) await store.put(next); return next
  } })
  const filedRecord = async (store: ReturnType<typeof memoryDraftStore>) => {
    const draft = draftOf()
    await store.put({ ...provisionalRecord(draft, { sessionId: SESSION, takeId: null, title: 't', files: take.files }), draft: edit(draft.project), recordingId: 'r-1', state: 'filed' })
  }
  const real = { read: () => openVideo(env.ctx, PROJECT), save: (_id: string, p: EditorProject, digest: string) => saveVideo(env.ctx, p, digest) }

  it('the save landed but its answer was lost: the next try sees the edit on the video and is done (never a conflict)', async () => {
    const store = memoryDraftStore()
    await filedRecord(store)
    await studioFiles()
    const release = vi.fn(async () => ({ safe: true }))
    const lost = async (_id: string, p: EditorProject, digest: string) => { await saveVideo(env.ctx, p, digest); throw new TypeError('Failed to fetch') }
    expect((await adoptKept({ store, records: recordsOf(store), ...real, save: lost, release }, PROJECT)).outcome).toBe('network')
    const save = vi.fn(real.save)
    const again = await adoptKept({ store, records: recordsOf(store), ...real, save, release }, PROJECT)
    expect(again.outcome).toBe('saved')
    expect(save).not.toHaveBeenCalled()
    expect((await store.get(PROJECT))!.state).toBe('adopted')
    expect(release).toHaveBeenCalledWith(PROJECT)
  })

  it('the save landed but the note after it could not be written: the next try is done, not a conflict', async () => {
    const store = memoryDraftStore()
    await filedRecord(store)
    await studioFiles()
    const release = vi.fn(async () => ({ safe: true }))
    const refuse = { on: true }
    expect((await adoptKept({ store, records: recordsOf(store, refuse), ...real, release }, PROJECT)).outcome).toBe('saved')
    expect((await store.get(PROJECT))!.state).toBe('filed')
    refuse.on = false
    expect((await adoptKept({ store, records: recordsOf(store), ...real, release }, PROJECT)).outcome).toBe('saved')
    expect((await store.get(PROJECT))!.state).toBe('adopted')
  })

  it('the save never reached the Studio, then the Mac’s late words moved the video: they go into the edit, which is saved', async () => {
    const store = memoryDraftStore()
    await filedRecord(store)
    const studio = await studioFiles({ noWords: true })
    const release = vi.fn(async () => ({ safe: true }))
    expect((await adoptKept({ store, records: recordsOf(store), ...real, save: async () => { throw new TypeError('Failed to fetch') }, release }, PROJECT)).outcome).toBe('network')
    // The Studio registers the words and adds them to the video (recordings.ts addRecordingWords).
    const voice = studio.finals.microphone
    const words = wordsOnVoiceClock(take.transcript!.words, { asset: voice, offsetSeconds: -0.044 })
    const late = await registerTranscript(env.ctx, toTranscript(voice, { words, text: words.map((w) => w.text).join(' ') }, 'imported', hex('8'), 'Microphone imported transcript'))
    const opened = await openVideo(env.ctx, PROJECT)
    await saveVideo(env.ctx, { ...opened.project, transcripts: [...opened.project.transcripts, late] }, opened.projectDigest)
    const result = await adoptKept({ store, records: recordsOf(store), ...real, release }, PROJECT)
    expect(result.outcome).toBe('saved')
    const now = (await openVideo(env.ctx, PROJECT)).project
    expect(now.title).toBe('Launch walkthrough')
    expect(now.transcripts.map((t) => t.id)).toContain(late.id)
    // A real change made there since is still the person's choice: the row then names it.
    await store.put({ ...(await store.get(PROJECT))!, state: 'filed' })
    const latest = await openVideo(env.ctx, PROJECT)
    await saveVideo(env.ctx, { ...latest.project, title: 'Their title' }, latest.projectDigest)
    expect((await adoptKept({ store, records: recordsOf(store), ...real, release }, PROJECT)).outcome).toBe('conflict')
    expect((await store.get(PROJECT))!.failed).toBe(CHANGED_ELSEWHERE)
  })

  it('adopted in the editor with its last edits owed: Put my edits on it saves them (and clears what was owed)', async () => {
    const store = memoryDraftStore()
    await filedRecord(store)
    const studio = await studioFiles()
    await markEditorAdopted(recordsOf(store), PROJECT, studio.digest, true, studio.project)
    expect((await store.get(PROJECT))!.saveOwed).toBe(true)
    const release = vi.fn(async () => ({ safe: true }))
    expect((await adoptKept({ store, records: recordsOf(store), ...real, release }, PROJECT)).outcome).toBe('saved')
    expect((await openVideo(env.ctx, PROJECT)).project.title).toBe('Launch walkthrough')
    expect((await store.get(PROJECT))!).toMatchObject({ state: 'adopted' })
    expect((await store.get(PROJECT))!.saveOwed).toBeUndefined()
    expect((await adoptKept({ store, records: recordsOf(store), ...real, release }, PROJECT)).outcome).toBe('already')
  })
})
