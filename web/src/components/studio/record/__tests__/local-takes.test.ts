// Takes kept on this computer that are not settled, as the Record dialog lists them (local-takes.ts): each with its
// size, what is wrong in plain words, and what Try again does. Nothing such a take holds is removed by its age
// (studio_recorder.rs sweep), so every one of them must show here. Made-up takes.
import { describe, expect, it } from 'vitest'
import { listedTakes, localTakeActions, localTakeRows, sizeWords, type LocalTakeDeps, type LocalTakeRow } from '../local-takes'
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

describe('the third review: Try again and Discard never lose an edit', () => {
  const one = (extra: Record<string, unknown>, rec?: Partial<ProvisionalRecord>, skip?: Set<string>) =>
    localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true, ...extra })] }), rec ? [record(1, rec)] : [], skip)[0]

  it('a filed take whose edit is not on the video yet is carried on, never let go of (its record is the edit)', () => {
    const row = one({}, { state: 'filed', recordingId: 'r-1' })!
    expect(row.action).toEqual({ kind: 'adopt', projectId: 'p-1' })
    expect(row.problem).toBe('Filed. Your edits are not on the video yet. Try again puts them on it.')
  })

  it('an adopted take whose last save may not have landed says to check the video before letting go', () => {
    const row = one({}, { state: 'adopted', recordingId: 'r-1', saveOwed: true })!
    expect(row.action).toEqual({ kind: 'release', projectId: 'p-1', anyway: true })
    expect(row.problem).toMatch(/your last edits may not have reached it. Open the video to check them/)
    expect(one({}, { state: 'adopted', recordingId: 'r-1' })!.action).toEqual({ kind: 'release', projectId: 'p-1' })
  })

  it('a draft beside the take that is no record this page can read says its edits are lost', () => {
    const row = one({ takeId: 'take-1' })! // hasDraft, but no record parsed from it (an older version, say)
    expect(row.problem).toMatch(/could not be read. Try again makes the recording a new video \(the edits made to it before it was filed are lost\)/)
    expect(row.action).toEqual({ kind: 'recover', takeId: 'take-1' })
    expect(row.edits).toBe(true)
  })

  it('an unreadable draft with nothing to try again never mentions Try again', () => {
    const row = one({ hasDraft: false, draftUnreadable: true })!
    expect(row.action).toEqual({ kind: 'none' })
    expect(row.problem).not.toMatch(/Try again/)
  })

  it('another account’s take is listed by its size, with Discard only', () => {
    const row = one({ otherAccount: true, hasDraft: false }, { state: 'failed' })!
    expect(row.action).toEqual({ kind: 'none' })
    expect(row.problem).toMatch(/another account was signed in/)
    expect(row.bytes).toBe(42_000_000)
  })

  it('says when Discard deletes the edits too, and leaves out a take the editor has open', () => {
    expect(one({}, { state: 'failed' })!.edits).toBe(true)
    expect(localTakeRows(listedTakes({ takes: [take(2, { stop: { files: [] } })] }), [])[0]!.edits).toBe(false)
    expect(one({}, { state: 'failed' }, new Set(['p-1']))).toBeUndefined()
  })
})

describe('Try again and Discard on a listed take', () => {
  const deps = (extra: Partial<LocalTakeDeps> = {}) => {
    const calls: string[] = []
    const d: LocalTakeDeps = {
      refile: async (id) => void calls.push(`refile ${id}`),
      adopt: async (id) => void calls.push(`adopt ${id}`),
      release: async (id, anyway) => { calls.push(`release ${id}${anyway ? ' anyway' : ''}`); return { safe: true } },
      recover: async (id) => void calls.push(`recover ${id}`),
      fileWhole: async (row) => { calls.push(`file ${row.sessionId.slice(0, 2)}`); await new Promise((resolve) => setTimeout(resolve, 20)) },
      records: async () => [],
      discard: async (id) => void calls.push(`discard ${id.slice(0, 2)}`),
      inUse: async () => null,
      notify: (text) => void calls.push(`said ${text}`),
      refresh: () => undefined,
      ...extra,
    }
    return { d, calls }
  }
  const whole: LocalTakeRow = { sessionId: S(1), bytes: 1, at: null, problem: '', action: { kind: 'file-whole' }, edits: false }

  it('two presses of Try again on a take filed whole make one filing', async () => {
    const { d, calls } = deps()
    const actions = localTakeActions(d)
    const first = actions.retry(whole)
    const second = actions.retry(whole)
    expect(actions.busy(S(1))).toBe(true)
    await Promise.all([first, second])
    expect(calls.filter((c) => c.startsWith('file'))).toEqual(['file 1f'])
    expect(actions.busy(S(1))).toBe(false)
  })

  it('a take that has a record already is never filed whole again (it is on its way)', async () => {
    const { d, calls } = deps({ records: async () => [record(1, { state: 'filing' })] })
    await localTakeActions(d).retry(whole)
    expect(calls).toEqual(['said This recording is being made into a video already.'])
  })

  it('a filed take is carried on, an adopted one let go of (anyway only when the row says so)', async () => {
    const { d, calls } = deps()
    const actions = localTakeActions(d)
    await actions.retry({ ...whole, action: { kind: 'adopt', projectId: 'p-1' } })
    await actions.retry({ ...whole, action: { kind: 'release', projectId: 'p-1' } })
    await actions.retry({ ...whole, action: { kind: 'release', projectId: 'p-1', anyway: true } })
    expect(calls).toEqual(['adopt p-1', 'release p-1', 'release p-1 anyway'])
  })

  it('Discard refuses a take that is in use, and says why', async () => {
    const { d, calls } = deps({ inUse: async () => 'This recording is open in the editor. Leave its video first, then discard it.' })
    await localTakeActions(d).discard(S(1))
    expect(calls).toEqual(['said This recording is open in the editor. Leave its video first, then discard it.'])
  })
})
