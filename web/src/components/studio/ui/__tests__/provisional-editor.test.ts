// The editor's steps for a Mac take opened before it was filed (provisional-editor.ts), as App.tsx runs them: the
// history moved onto the Studio's copies without holes, never in the middle of a gesture, words that arrive later in
// every step, reading a filed video again after a failure, and what the header says when the draft cannot be kept.
import { describe, expect, it, vi } from 'vitest'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { historyWithWords, notSavedHere, rewriteHistory, saveRefusal, whenIdle, withRetries, type History } from '../provisional-editor'

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
