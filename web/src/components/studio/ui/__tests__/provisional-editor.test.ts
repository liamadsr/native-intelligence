// The editor's steps for a Mac take opened before it was filed (provisional-editor.ts), as App.tsx runs them: the
// history moved onto the Studio's copies without holes, never in the middle of a gesture, words that arrive later in
// every step, reading a filed video again after a failure, and what the header says when the draft cannot be kept.
import { describe, expect, it, vi } from 'vitest'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { carriedDigest, historyWithWords, lateTranscripts, markEditorAdopted, notSavedHere, OwedSaves, remoteAddedTranscripts, rewriteHistory, saveOwedAfter, saveRefusal, whenIdle, withRetries, withTranscripts, type History } from '../provisional-editor'

const step = (title: string) => ({ id: 'p', title }) as unknown as EditorProject
const titles = (h: History) => ({ past: h.past.map((p) => p.title), current: h.current.title, future: h.future.map((p) => p.title) })

describe('the history moved onto the Studio’s copies', () => {
  const history: History = { past: [step('1'), step('2 cannot move'), step('3'), step('4')], current: step('5'), future: [step('6'), step('7 cannot move'), step('8')], group: null }
  const swap = (p: EditorProject) => (p.title.includes('cannot') ? null : { ...p, title: `${p.title}′` })
  it('never leaves a hole: undo ends before a step that cannot be moved, redo stops before one', () => {
    expect(titles(rewriteHistory(history, swap, step('studio')))).toEqual({ past: ['3′', '4′'], current: '5′', future: ['6′'] })
  })
  it('the step shown cannot be moved: the Studio’s edit, with nothing to undo or redo', () => {
    expect(titles(rewriteHistory({ ...history, current: step('5 cannot move') }, swap, step('studio')))).toEqual({ past: [], current: 'studio', future: [] })
  })
  it('words that came later are in every step: undo never takes them away', () => {
    const added = historyWithWords(history, (p) => ({ ...p, title: `${p.title}+words` }))
    expect([...added.past, added.current, ...added.future].every((p) => p.title.endsWith('+words'))).toBe(true)
  })
})

describe('waiting for the editor to be idle', () => {
  it('never goes ahead in the middle of a gesture, however long it lasts', async () => {
    let busyFor = 5_000
    const sleep = vi.fn(async () => { busyFor-- })
    expect(await whenIdle(() => busyFor > 0, () => true, sleep)).toBe(true)
    expect(busyFor).toBeLessThanOrEqual(0)
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(5_000)
  })
  it('the person left the video meanwhile: it says so (the kept draft is used)', async () => {
    let open = 3
    expect(await whenIdle(() => true, () => open-- > 0, async () => undefined)).toBe(false)
  })
})

describe('reading a filed video again', () => {
  it('tries again with growing waits, and answers once it can', async () => {
    const waits: number[] = []
    let fails = 3
    expect(await withRetries(async () => { if (fails-- > 0) throw new Error('no connection'); return 'read' }, async (ms) => void waits.push(ms))).toBe('read')
    expect(waits).toEqual([2_000, 4_000, 8_000])
  })
  it('gives the last error once every wait is spent', async () => {
    await expect(withRetries(async () => { throw new Error('down') }, async () => undefined, () => true, [1, 1])).rejects.toThrow('down')
  })
})

describe('what a failure says', () => {
  it('a refused save is told apart from one that never reached the Studio', () => {
    expect(saveRefusal(Object.assign(new Error('This video changed somewhere else since you opened it.'), { code: 'DIGEST_CONFLICT' }))).toBe('conflict')
    expect(saveRefusal(new TypeError('Failed to fetch'))).toBe('network')
    expect(saveRefusal(new Error('The video is too long.'))).toBe('other')
  })
  it('a draft that could not be kept on this computer says "Not saved" and why', () => {
    expect(notSavedHere(new Error('The disk is full.'))).toBe('Not saved: the edit could not be kept on this computer (The disk is full).')
  })
})

describe('the third review', () => {
  const transcript = (id: string, assetId: string) => ({ id, assetId, words: [{ id: `${id}-w0`, text: 'Hello', startMs: 0, endMs: 400 }] })
  const video = (extra: Record<string, unknown> = {}) => ({ id: 'v', title: 'Take', assets: [{ id: 'screen' }, { id: 'voice' }], transcripts: [], captionCorrections: {}, ...extra }) as unknown as EditorProject

  it('the Mac’s words added to the video meanwhile are folded in (whatever order its fields came in), never a conflict', () => {
    const saved = video()
    const remote = { transcripts: [transcript('t-voice', 'voice')], captionCorrections: {}, assets: [{ id: 'screen' }, { id: 'voice' }], title: 'Take', id: 'v' } as unknown as EditorProject
    expect(lateTranscripts(saved, remote)?.map((t) => t.id)).toEqual(['t-voice'])
    // Anything else changed too (a real edit elsewhere): the person chooses.
    expect(lateTranscripts(saved, { ...remote, title: 'Renamed by the agent' })).toBeNull()
    expect(lateTranscripts(saved, saved)).toBeNull()
  })

  it('the words go into each step that has the voice and no transcript of it yet', () => {
    const added = [transcript('t-voice', 'voice')] as unknown as EditorProject['transcripts']
    expect(withTranscripts(video(), added).transcripts.map((t) => t.id)).toEqual(['t-voice'])
    expect(withTranscripts(video({ transcripts: [transcript('mine', 'voice')] }), added).transcripts.map((t) => t.id)).toEqual(['mine'])
    expect(withTranscripts(video({ assets: [{ id: 'screen' }] }), added).transcripts).toEqual([])
  })

  it('a save is owed only when the edit carried on differs from the Studio’s (a dropped word correction owes none)', () => {
    expect(saveOwedAfter(true, video(), video())).toBe(false)
    expect(saveOwedAfter(true, video({ title: 'Edited' }), video())).toBe(true)
    expect(saveOwedAfter(false, video({ title: 'Edited' }), video())).toBe(false)
  })

  it('Keep mine carries over only the transcripts the other version added (never one this edit took away)', () => {
    const saved = video({ transcripts: [transcript('old', 'screen')] })
    const remote = video({ transcripts: [transcript('old', 'screen'), transcript('late', 'voice')] })
    expect(remoteAddedTranscripts(saved, remote).map((t) => t.id)).toEqual(['late'])
    expect(remoteAddedTranscripts(null, remote)).toEqual([])
    // This edit removed the screen's transcript: it is not brought back; the voice's late words are added.
    expect(withTranscripts(video(), remoteAddedTranscripts(saved, remote)).transcripts.map((t) => t.id)).toEqual(['late'])
  })

  it('an edited draft is saved over the Studio’s edit as first filed (a video changed since refuses it)', () => {
    expect(carriedDigest({ studioDigest: 'first' }, 'now', true)).toBe('first')
    expect(carriedDigest({ studioDigest: 'first' }, 'now', false)).toBe('now')
    expect(carriedDigest({}, 'now', true)).toBe('now')
  })

  it('carried on in the open editor with edits to save: the record says so, keeps the first digest, and says plainly when it could not be noted', async () => {
    let kept: Record<string, unknown> | null = { state: 'filed', studioDigest: 'first' }
    const records = { update: async (_id: string, fn: (r: never) => unknown) => (kept = kept ? (fn(kept as never) as Record<string, unknown>) : null) as never }
    expect(await markEditorAdopted(records, 'p', 'now', true)).toMatchObject({ state: 'adopted', studioDigest: 'first', saveOwed: true })
    expect((await markEditorAdopted(records, 'p', 'now', false)).saveOwed).toBeUndefined()
    kept = null
    await expect(markEditorAdopted(records, 'p', 'now')).rejects.toThrow('this computer could not keep a note of it')
  })
})

describe('the fifth review: only the editor that carried a take on clears what it owes', () => {
  const store = () => {
    let kept: Record<string, unknown> = { projectId: 'draft', state: 'adopted', saveOwed: true, owedEdit: { title: 'Owed' } }
    return { get: () => kept, records: { update: async (_id: string, fn: (r: never) => unknown) => (kept = fn(kept as never) as Record<string, unknown>) as never } }
  }
  it('a page that opened the video from the Studio’s copy and saved it never clears the owed edit', async () => {
    const s = store()
    const owed = new OwedSaves() // a new page after a reload: nothing carried on here
    expect(await owed.saved('video', s.records)).toBe(false)
    expect(s.get()).toMatchObject({ saveOwed: true, owedEdit: { title: 'Owed' } })
  })
  it('the editor that carried it on clears it when its save lands', async () => {
    const s = store()
    const owed = new OwedSaves()
    owed.carriedOn('video', 'draft')
    expect(await owed.saved('video', s.records)).toBe(true)
    expect(s.get().saveOwed).toBeUndefined()
    expect(s.get().owedEdit).toBeUndefined()
    expect(owed.has('video')).toBe(false)
  })
})
