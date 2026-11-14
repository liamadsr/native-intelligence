// Takes kept on this computer that are not settled, as the Record dialog lists them (local-takes.ts): each with its
// size, what is wrong in plain words, and what Try again does. Nothing such a take holds is removed by its age
// (studio_recorder.rs sweep), so every one of them must show here. Made-up takes.
import { describe, expect, it } from 'vitest'
import { inUseReason, keptFor, listedTakes, localTakeActions, localTakeRows, OPEN_ELSEWHERE, sizeWords, takeOverFromSession, takesInFlight, type LocalTakeDeps, type LocalTakeRow } from '../local-takes'
import { CHANGED_ELSEWHERE, type ProvisionalRecord } from '../provisional'

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
  const one = (extra: Record<string, unknown>, rec?: Partial<ProvisionalRecord>, skip?: Set<string>, held?: (s: string) => boolean) =>
    localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true, ...extra })] }), rec ? [record(1, rec)] : [], skip, held)[0]

  it('a filed take whose edit is not on the video yet is carried on, never let go of (its record is the edit)', () => {
    const row = one({}, { state: 'filed', recordingId: 'r-1' })!
    expect(row.action).toEqual({ kind: 'adopt', projectId: 'p-1' })
    expect(row.problem).toBe('Filed. Your edits are not on the video yet. Try again puts them on it.')
  })

  it('an adopted take whose last save may not have landed offers to put the edits on it first, then to let go', () => {
    const row = one({}, { state: 'adopted', recordingId: 'r-1', saveOwed: true, owedEdit: {} as never })!
    expect(row.action).toEqual({ kind: 'adopt', projectId: 'p-1' })
    expect(row.label).toBe('Put my edits on it')
    expect(row.alt).toEqual({ action: { kind: 'release', projectId: 'p-1', anyway: true }, label: 'Let go of the files' })
    expect(row.problem).toMatch(/your last edits may not have reached it. Put my edits on it saves them onto the video, never over changes made there since/)
    expect(row.edits).toBe(true)
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
    const edited = { base: { title: 'Take' }, draft: { title: 'Launch walkthrough' } } as unknown as Partial<ProvisionalRecord>
    expect(one({}, { state: 'failed', ...edited })!.edits).toBe(true)
    // Not edited since it was built: Discard deletes no edits (none were made).
    expect(one({}, { state: 'filed', base: { title: 'Take' }, draft: { title: 'Take' } } as unknown as Partial<ProvisionalRecord>)!.edits).toBe(false)
    expect(localTakeRows(listedTakes({ takes: [take(2, { stop: { files: [] } })] }), [])[0]!.edits).toBe(false)
    expect(one({}, { state: 'failed' }, new Set(['p-1']))).toBeUndefined()
  })
})

describe('the fourth review: the rows say what is true', () => {
  const one = (extra: Record<string, unknown>, rec?: Partial<ProvisionalRecord>, skip?: Set<string>, held?: (s: string) => boolean) =>
    localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true, ...extra })] }), rec ? [record(1, rec)] : [], skip, held)[0]

  it('an adopted take whose edits are on the video: Discard deletes no edits', () => {
    expect(one({}, { state: 'adopted', recordingId: 'r-1' })!.edits).toBe(false)
  })

  it('a filed take whose video changed elsewhere names the conflict; one whose edits could not be moved says so', () => {
    const conflict = one({}, { state: 'filed', recordingId: 'r-1', failed: CHANGED_ELSEWHERE })!
    expect(conflict.problem).toBe(`${CHANGED_ELSEWHERE} Try again offers to open the video with them, so you can choose. Let go of the files removes this recording and those edits from this computer once the Studio holds every byte of it.`)
    // It can be settled without Discard: letting go (asked first) waits for the Studio to hold every byte.
    expect(conflict.alt).toEqual({ action: { kind: 'release', projectId: 'p-1', anyway: true }, label: 'Let go of the files' })
    expect(conflict.problem).not.toMatch(/puts them on it/)
    const moved = one({}, { state: 'filed', recordingId: 'r-1', failed: 'The recording is filed, but your edits could not be moved onto it (no picture). They are kept on this computer.' })!
    expect(moved.problem).toMatch(/could not be moved onto it .* Try again tries once more\.$/)
  })

  it('a take this page holds, whose record it has not read yet, is never shown as a lost edit', () => {
    expect(one({}, undefined, undefined, (s) => s === S(1))).toBeUndefined()
    expect(one({}, undefined, undefined, () => false)!.problem).toMatch(/could not be read/)
  })

  it('a take whose screen recording failed is listed with what is kept, Discard only', () => {
    const row = localTakeRows(listedTakes({ takes: [take(3, { screenMissing: true, tracks: [{ role: 'microphone', bytes: 2_000_000 }, { role: 'camera', bytes: 9_000_000 }] })] }), [])[0]!
    expect(row.action).toEqual({ kind: 'none' })
    expect(row.problem).toBe('The screen recording failed, so this cannot be made into a video. Its microphone and camera are kept on this computer.')
    expect(row.bytes).toBe(11_000_000)
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
      holdTake: async (id) => { calls.push(`hold ${id.slice(0, 2)}`); return true },
      letGoTake: async (id) => void calls.push(`let go ${id.slice(0, 2)}`),
      notify: (text) => void calls.push(`said ${text}`),
      refresh: () => undefined,
      ...extra,
    }
    return { d, calls }
  }
  const whole: LocalTakeRow = { sessionId: S(1), bytes: 1, at: null, problem: '', action: { kind: 'file-whole' }, edits: false }

  it('two presses of Try again on a take filed whole make one filing, the take held meanwhile', async () => {
    const { d, calls } = deps()
    const actions = localTakeActions(d)
    const first = actions.retry(whole)
    const second = actions.retry(whole)
    expect(actions.busy(S(1))).toBe(true)
    await Promise.all([first, second])
    expect(calls).toEqual(['hold 1f', 'file 1f', 'let go 1f'])
    expect(actions.busy(S(1))).toBe(false)
  })

  it('a take another window holds is never filed whole nor brought back here (two windows never make two videos)', async () => {
    const { d, calls } = deps({ holdTake: async () => false })
    const actions = localTakeActions(d)
    await actions.retry(whole)
    await actions.retry({ ...whole, action: { kind: 'recover', takeId: 'take-1' } })
    expect(calls).toEqual([`said ${OPEN_ELSEWHERE}`, `said ${OPEN_ELSEWHERE}`])
  })

  it('a take filed behind the editor keeps its hold (its filing has it); one brought back lets go', async () => {
    let filed = false
    const { d, calls } = deps({ fileWhole: async () => { filed = true }, records: async () => (filed ? [record(1, { state: 'filing' })] : []) })
    const actions = localTakeActions(d)
    await actions.retry(whole)
    await actions.retry({ ...whole, action: { kind: 'recover', takeId: 'take-1' } })
    expect(calls).toEqual(['hold 1f', 'hold 1f', 'recover take-1', 'let go 1f'])
  })

  it('a take that has a record already is never filed whole again (it is on its way)', async () => {
    const { d, calls } = deps({ records: async () => [record(1, { state: 'filing' })] })
    await localTakeActions(d).retry(whole)
    expect(calls.filter((c) => !c.startsWith('hold') && !c.startsWith('let go'))).toEqual(['said This recording is being made into a video already.'])
  })

  it('a filed take is carried on, an adopted one let go of (anyway only when the row says so), the second action on request', async () => {
    const { d, calls } = deps()
    const actions = localTakeActions(d)
    await actions.retry({ ...whole, action: { kind: 'adopt', projectId: 'p-1' } })
    await actions.retry({ ...whole, action: { kind: 'release', projectId: 'p-1' } })
    await actions.retry({ ...whole, action: { kind: 'adopt', projectId: 'p-1' }, alt: { action: { kind: 'release', projectId: 'p-1', anyway: true }, label: 'Let go of the files' } }, true)
    expect(calls).toEqual(['adopt p-1', 'release p-1', 'release p-1 anyway'])
  })

  it('Discard refuses a take that is in use, and says why', async () => {
    const { d, calls } = deps({ inUse: async () => 'This recording is open in the editor. Leave its video first, then discard it.' })
    await localTakeActions(d).discard(S(1))
    expect(calls).toEqual(['said This recording is open in the editor. Leave its video first, then discard it.'])
  })

  it('Discard holds the take, and lets go of it even when the discard fails (no hold left renewing)', async () => {
    const { d, calls } = deps({ discard: async () => { throw new Error('The folder could not be removed.') } })
    await localTakeActions(d).discard(S(1))
    expect(calls).toEqual(['hold 1f', 'let go 1f', 'said The folder could not be removed.'])
    const elsewhere = deps({ holdTake: async () => false })
    await localTakeActions(elsewhere.d).discard(S(1))
    expect(elsewhere.calls).toEqual([`said ${OPEN_ELSEWHERE}`])
  })
})

describe('why a listed take cannot be discarded now (what the hook hands Discard)', () => {
  const none = { sending: new Set<string>(), records: [] as ProvisionalRecord[], open: new Set<string>() }
  it('being sent, recording, or open in the editor', () => {
    expect(inUseReason(S(1), none)).toBeNull()
    expect(inUseReason(S(1), { ...none, sending: new Set([S(1)]) })).toMatch(/being sent to the Studio now/)
    expect(inUseReason(S(1), { ...none, records: [record(1, { state: 'failed' })], open: new Set(['p-1']) })).toMatch(/open in the editor/)
    expect(inUseReason(S(1), { ...none, records: [record(1, { state: 'failed' })], open: new Set(['p-2']) })).toBeNull()
  })
})

describe('the fifth review', () => {
  it('a take this page’s recorder still has (uploading, being made into a video the classic way) gets no row', () => {
    const listed = listedTakes({ takes: [take(1, { stop: { files: [] } }), take(2, { takeId: 'take-2' }), take(3, { hasDraft: true })] })
    const owned = new Set([S(1), S(2), S(3)])
    // Owned with a record: its filing is listed as before (a failed one, say).
    const rows = localTakeRows(listed, [record(3, { state: 'failed', failed: 'Could not be filed.' })], new Set(), () => true, owned)
    expect(rows.map((r) => r.sessionId)).toEqual([S(3)])
    expect(localTakeRows(listed, [], new Set(), () => false).map((r) => r.sessionId)).toEqual([S(1), S(2), S(3)]) // not owned: listed
  })

  it('an action never lets go of a hold this page had before it (its recorder’s, its filing’s)', async () => {
    const calls: string[] = []
    const actions = localTakeActions({
      refile: async () => undefined, adopt: async () => undefined, release: async () => ({ safe: true }), recover: async () => { throw new Error('Recover failed.') },
      fileWhole: async () => undefined, records: async () => [], discard: async () => void calls.push('discard'), inUse: async () => null,
      holdTake: async () => true, letGoTake: async (id) => void calls.push(`let go ${id.slice(0, 2)}`), holdsTake: () => true,
      notify: () => undefined, refresh: () => undefined,
    })
    const row: LocalTakeRow = { sessionId: S(1), bytes: 1, at: null, problem: '', action: { kind: 'recover', takeId: 'take-1' }, edits: false }
    await actions.retry(row)
    await actions.retry({ ...row, action: { kind: 'file-whole' } })
    await actions.discard(S(1))
    expect(calls).toEqual(['discard'])
  })

  it('owed but its edit was not kept beside the take: no "Put my edits on it", only letting go (asked first)', () => {
    const row = localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true })] }), [record(1, { state: 'adopted', recordingId: 'r-1', saveOwed: true })])[0]!
    expect(row.action).toEqual({ kind: 'none' })
    expect(row.problem).toMatch(/^The video is made, but your last edits may not have reached it, and this computer did not keep a copy of them beside the recording. Open the video to check them./)
    expect(row.alt?.label).toBe('Let go of the files')
  })
})

describe('the sixth review', () => {
  it('a take is hidden only while its upload runs: once it failed, it is listed again', async () => {
    const flights = takesInFlight()
    const listed = listedTakes({ takes: [take(1, { stop: { files: [] } })] })
    let during: string[] = []
    await flights.during(S(1), async () => { during = localTakeRows(listed, [], new Set(), () => true, flights.ids()).map((r) => r.sessionId); throw new Error('The upload failed.') }).catch(() => undefined)
    expect(during).toEqual([])
    expect(localTakeRows(listed, [], new Set(), () => true, flights.ids()).map((r) => r.sessionId)).toEqual([S(1)])
  })

  it('an adopted take held back only by the Mac’s words says so, not that the Studio lacks bytes', () => {
    const words = [{ text: 'Hello', startMs: 500, endMs: 900 }]
    const row = localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true })] }), [record(1, { state: 'adopted', recordingId: 'r-1', heard: words })])[0]!
    expect(row.problem).toBe('The video is made, but the words the Mac heard have not reached the Studio yet, so this recording is kept on this computer until they do.')
    const sent = localTakeRows(listedTakes({ takes: [take(1, { hasDraft: true })] }), [record(1, { state: 'adopted', recordingId: 'r-1', heard: words, wordsSent: true })])[0]!
    expect(sent.problem).toMatch(/does not hold every byte/)
  })

  it('Discard and Try again on a session act only on the take that session kept', () => {
    const kept = { id: 'session-a', take: 'take of a' }
    expect(keptFor(kept, 'session-a')).toBe(kept)
    expect(keptFor(kept, 'session-b')).toBeNull()
    expect(keptFor(null, 'session-a')).toBeNull()
  })

  it('a row action takes over a take its session kept after a failed upload: the session banner’s Discard then deletes nothing', async () => {
    const pending: { current: { id: string; take: { sessionId: string } } | null } = { current: { id: 'session-a', take: { sessionId: S(1) } } }
    const deleted: string[] = [], disarmed: string[] = []
    const actions = localTakeActions({
      refile: async () => undefined, adopt: async () => undefined, release: async () => ({ safe: true }), recover: async () => undefined,
      fileWhole: async () => undefined, records: async () => [], discard: async () => undefined, inUse: async () => null,
      holdTake: async () => true, letGoTake: async () => undefined, notify: () => undefined, refresh: () => undefined,
      takeOver: (sessionId) => { const id = takeOverFromSession(pending, sessionId); if (id) disarmed.push(id) },
    })
    // The row's Try again makes the take a new video (and it uploads from the Mac's files).
    await actions.retry({ sessionId: S(1), bytes: 1, at: null, problem: '', action: { kind: 'file-whole' }, edits: false })
    expect(disarmed).toEqual(['session-a'])
    // Later, Discard on the old session's banner (as useManualRecording cancel does): nothing is kept for it any more.
    const kept = keptFor(pending.current, 'session-a')
    if (kept) deleted.push(kept.take.sessionId)
    expect(deleted).toEqual([])
    // Another take's session keeps its own.
    pending.current = { id: 'session-b', take: { sessionId: S(2) } }
    expect(takeOverFromSession(pending, S(1))).toBeNull()
    expect(pending.current?.id).toBe('session-b')
  })

  it('bringing back and Discard on a row take the take over from its session too', async () => {
    const taken: string[] = []
    const actions = localTakeActions({
      refile: async () => undefined, adopt: async () => undefined, release: async () => ({ safe: true }), recover: async () => undefined,
      fileWhole: async () => undefined, records: async () => [], discard: async () => undefined, inUse: async () => null,
      holdTake: async () => true, letGoTake: async () => undefined, notify: () => undefined, refresh: () => undefined,
      takeOver: (sessionId) => void taken.push(sessionId),
    })
    await actions.retry({ sessionId: S(1), bytes: 1, at: null, problem: '', action: { kind: 'recover', takeId: 'take-1' }, edits: false })
    await actions.discard(S(2))
    expect(taken).toEqual([S(1), S(2)])
  })
})
