// Takes kept on this computer that are not settled, as the Record dialog lists them (local-takes.ts): each with its
// size, what is wrong in plain words, and what Try again does. Nothing such a take holds is removed by its age
// (studio_recorder.rs sweep), so every one of them must show here. Made-up takes.
import { describe, expect, it } from 'vitest'
import { listedTakes, localTakeRows, sizeWords } from '../local-takes'
import type { ProvisionalRecord } from '../provisional'

const S = (n: number) => `${n}f0f0f0f-1111-4222-8333-444444444444`
const take = (n: number, extra: Record<string, unknown> = {}) => ({ sessionId: S(n), takeId: null, state: 'recording', tracks: [{ role: 'screen', bytes: 40_000_000 }, { role: 'microphone', bytes: 2_000_000 }], hasDraft: false, draftUnreadable: false, stop: null, modifiedMs: Date.UTC(2026, 10, 14, 9, 41), ...extra })
const record = (n: number, extra: Partial<ProvisionalRecord>) => ({ sessionId: S(n), projectId: `p-${n}`, state: 'filing', ...extra }) as ProvisionalRecord

describe('takes kept on this computer', () => {
  const listed = listedTakes({ takes: [
    take(1, { stop: { files: [] } }), // never reached the Studio (offline punch-in), stopped cleanly
    take(2), // never reached the Studio, never stopped cleanly
    take(3, { takeId: 'take-3' }), // in part on the Studio
    take(4, { hasDraft: true }), // a draft that failed
    take(5, { hasDraft: true }), // a draft filed, files kept (the Studio short of bytes)
    take(6, { draftUnreadable: true, takeId: 'take-6' }), // a torn draft
    take(7, { hasDraft: true }), // being filed by this page now
  ] })
  const rows = localTakeRows(listed, [record(4, { state: 'failed', failed: 'This recording is kept on this computer, but it could not be filed: the Studio could not make it.' }), record(5, { state: 'adopted', recordingId: 'r-5' }), record(7, { state: 'filing' })], new Set(['p-7']))

  it('lists every one that is not on its way by itself, with its size and what is wrong', () => {
    expect(rows.map((r) => r.sessionId)).toEqual([S(1), S(2), S(3), S(4), S(5), S(6)])
    expect(rows.every((r) => r.bytes === 42_000_000)).toBe(true)
    expect(sizeWords(42_000_000)).toBe('42 MB')
    expect(rows.find((r) => r.sessionId === S(1))!.problem).toMatch(/never reached the Studio/)
    expect(rows.find((r) => r.sessionId === S(4))!.problem).toMatch(/could not be filed: the Studio could not make it/)
    expect(rows.find((r) => r.sessionId === S(5))!.problem).toMatch(/does not hold every byte/)
    expect(rows.find((r) => r.sessionId === S(6))!.problem).toMatch(/edit kept for this recording could not be read/)
  })

  it('says what Try again does for each (none when nothing can be made of it: only Discard)', () => {
    expect(Object.fromEntries(rows.map((r) => [r.sessionId, r.action]))).toEqual({
      [S(1)]: { kind: 'file-whole' },
      [S(2)]: { kind: 'none' },
      [S(3)]: { kind: 'recover', takeId: 'take-3' },
      [S(4)]: { kind: 'refile', projectId: 'p-4' },
      [S(5)]: { kind: 'release', projectId: 'p-5' },
      [S(6)]: { kind: 'recover', takeId: 'take-6' },
    })
  })

  it('reads only what the app says (a row it cannot read is left out)', () => {
    expect(listedTakes({ takes: [{ nope: true }, null] })).toEqual([])
    expect(listedTakes(null)).toEqual([])
  })
})
