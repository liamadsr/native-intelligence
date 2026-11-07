/**
 * Abandoned recordings (src/lib/captures/abandoned.ts): which open captures the
 * server may finish, and the close that never beats a live recorder.
 *
 * Pinned:
 *   - found: open, quiet past the hour, inside the lookback, with a meeting in
 *     it; never an eval / demo / archived / ownerless / empty one, never one
 *     written within the hour, never an old stray; oldest quiet first;
 *   - the per-capture re-read applies every rule again, and refuses an owner
 *     no longer in the workspace;
 *   - the close is Stop's (ended_at, duration, ai_processed) with ended_at at
 *     the LAST WRITE, metadata kept and marked, and it is a CAS: a write since
 *     the read, or an end already stamped, makes it a no-op;
 *   - the batch decision matches Stop's where the server can see the inputs,
 *     and runs the batch when a live capture has no record;
 *   - retired: an open, started capture quiet past the lookback, whatever is
 *     in it (owner or not), oldest first; never an eval / demo / archived /
 *     never-started one, never one inside the lookback (the finish's), and the
 *     rows it skips never take its window; the retire stamps only ended_at (the
 *     last write) and metadata.finalized, under the same CAS.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'
import {
  ABANDONED_LOOKBACK_MS,
  ABANDONED_QUIET_MS,
  MIN_ABANDONED_TRANSCRIPT_CHARS,
  RETIRE_SWEEP_CAP,
  closeAbandonedCapture,
  declineRecovery,
  findAbandonedCaptures,
  findStaleCaptures,
  isAbandonedCandidate,
  loadAbandonedCapture,
  loadDeclinedCapture,
  needsBatchPass,
  retireStaleCapture,
  retireStaleCaptures,
  type AbandonedCaptureRow,
  type StaleCaptureRow,
} from '../abandoned'

const NOW = Date.parse('2026-09-28T20:30:00.000Z')
const WS = 'f6000000-0000-4000-8000-000000000001'
const OWNER = 'u0000000-0000-4000-8000-000000000001'
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN
const MEETING = '[local_1] so the UAT build goes out Thursday\n'.repeat(12)

let fake: FakeSupabase

function capture(over: Row = {}): Row {
  return {
    id: `c${Math.random().toString(16).slice(2, 10)}`,
    workspace_id: WS,
    user_id: OWNER,
    started_at: ago(120 * MIN),
    updated_at: ago(90 * MIN),
    ended_at: null,
    duration_seconds: null,
    live_mode: false,
    ai_summary: null,
    transcript: MEETING,
    metadata: { capture_mode: 'desktop_dual' },
    is_eval: false,
    status: 'active',
    ...over,
  }
}

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm-1', user_id: OWNER, workspace_id: WS }])
})

describe('findAbandonedCaptures', () => {
  it('finds open captures quiet past the hour, with a meeting in them, oldest quiet first', async () => {
    fake.seed('captures', [
      capture({ id: 'late', updated_at: ago(65 * MIN) }),
      capture({ id: 'early', updated_at: ago(5 * 60 * MIN) }),
      capture({ id: 'still-writing', updated_at: ago(ABANDONED_QUIET_MS - MIN) }),
      capture({ id: 'old-stray', updated_at: ago(ABANDONED_LOOKBACK_MS + MIN) }),
      capture({ id: 'stopped', ended_at: ago(80 * MIN) }),
      capture({ id: 'eval', is_eval: true }),
      capture({ id: 'demo', metadata: { demo: true } }),
      capture({ id: 'archived', status: 'archived' }),
      capture({ id: 'no-owner', user_id: null }),
      capture({ id: 'blank', transcript: ' \n'.repeat(400) }),
      capture({ id: 'blip', transcript: 'x'.repeat(MIN_ABANDONED_TRANSCRIPT_CHARS - 1) }),
      capture({ id: 'status-null', status: null, updated_at: ago(70 * MIN) }),
    ])
    const found = await findAbandonedCaptures(fake as never, NOW)
    expect(found.map((r) => r.id)).toEqual(['early', 'status-null', 'late'])
  })

  it('empty open rows never take the scan window from a real abandoned recording', async () => {
    fake.seed('captures', [
      ...Array.from({ length: 60 }, (_, i) =>
        capture({ id: `empty-${i}`, transcript: i % 2 ? null : '', updated_at: ago(70 * 60 * MIN - i * MIN) }),
      ),
      capture({ id: 'real', updated_at: ago(2 * 60 * MIN) }),
    ])
    const found = await findAbandonedCaptures(fake as never, NOW)
    expect(found.map((r) => r.id)).toEqual(['real'])
  })

  it('a blip at exactly the floor counts; whitespace never does', () => {
    const at = capture({ transcript: `${'x'.repeat(MIN_ABANDONED_TRANSCRIPT_CHARS)}\n\n  ` }) as unknown as AbandonedCaptureRow
    expect(isAbandonedCandidate(at)).toBe(true)
  })
})

describe('loadAbandonedCapture — every rule again, at finalize time', () => {
  it('returns the row while it is still abandoned and its owner is a member', async () => {
    fake.seed('captures', [capture({ id: 'c1' })])
    expect((await loadAbandonedCapture(fake as never, { captureId: 'c1', workspaceId: WS }, NOW))?.id).toBe('c1')
  })

  it('null once the recorder wrote again, or the capture ended, or is in another workspace', async () => {
    fake.seed('captures', [
      capture({ id: 'wrote', updated_at: ago(2 * MIN) }),
      capture({ id: 'ended', ended_at: ago(80 * MIN) }),
      capture({ id: 'elsewhere', workspace_id: 'other-ws' }),
    ])
    for (const id of ['wrote', 'ended', 'elsewhere']) {
      expect(await loadAbandonedCapture(fake as never, { captureId: id, workspaceId: WS }, NOW)).toBeNull()
    }
  })

  it('null when the owner is no longer a member of the workspace', async () => {
    fake = makeFakeSupabase()
    fake.seed('captures', [capture({ id: 'c1' })])
    expect(await loadAbandonedCapture(fake as never, { captureId: 'c1', workspaceId: WS }, NOW)).toBeNull()
  })
})

describe('closeAbandonedCapture — Stop’s close, CAS on the last write', () => {
  it('ends it at the last write, with the span as duration, ai_processed, and metadata kept + marked', async () => {
    const row = capture({ id: 'c1', started_at: ago(120 * MIN), updated_at: ago(90 * MIN) })
    fake.seed('captures', [row])
    expect(await closeAbandonedCapture(fake as never, row as unknown as AbandonedCaptureRow, NOW)).toBe(true)
    const [after] = fake.rows('captures')
    expect(after).toMatchObject({
      ended_at: ago(90 * MIN),
      duration_seconds: 30 * 60,
      ai_processed: true,
      metadata: {
        capture_mode: 'desktop_dual',
        finalized: { by: 'server', reason: 'recorder_quiet', at: new Date(NOW).toISOString() },
      },
    })
  })

  it('keeps a duration the client already set', async () => {
    const row = capture({ id: 'c1', duration_seconds: 1234 })
    fake.seed('captures', [row])
    await closeAbandonedCapture(fake as never, row as unknown as AbandonedCaptureRow, NOW)
    expect(fake.rows('captures')[0].duration_seconds).toBe(1234)
  })

  it('a write since the read wins: nothing is closed', async () => {
    const read = capture({ id: 'c1', updated_at: ago(90 * MIN) })
    fake.seed('captures', [{ ...read, updated_at: ago(1 * MIN) }])
    expect(await closeAbandonedCapture(fake as never, read as unknown as AbandonedCaptureRow, NOW)).toBe(false)
    const [after] = fake.rows('captures')
    expect(after.ended_at).toBeNull()
    expect(after.ai_processed).toBeUndefined()
    expect(after.metadata).toEqual({ capture_mode: 'desktop_dual' })
  })

  it('an end already stamped (Stop landed first) is never overwritten', async () => {
    const read = capture({ id: 'c1' })
    fake.seed('captures', [{ ...read, ended_at: ago(85 * MIN) }])
    expect(await closeAbandonedCapture(fake as never, read as unknown as AbandonedCaptureRow, NOW)).toBe(false)
    expect(fake.rows('captures')[0].ended_at).toBe(ago(85 * MIN))
  })
})

describe('findStaleCaptures — the open captures the finish never reaches', () => {
  const STALE = ABANDONED_LOOKBACK_MS + MIN
  // Started long before its last write, as a real stale capture was.
  const old = (over: Row = {}) => capture({ started_at: ago(400 * DAY), ...over })

  it('every open, started capture quiet past the lookback, whatever is in it, oldest quiet first', async () => {
    fake.seed('captures', [
      old({ id: 'meeting', updated_at: ago(STALE + 2 * MIN) }),
      old({ id: 'blip', transcript: 'x'.repeat(10), updated_at: ago(STALE + 5 * MIN) }),
      old({ id: 'blank', transcript: null, updated_at: ago(180 * DAY) }),
      old({ id: 'ownerless', user_id: null, updated_at: ago(STALE + MIN) }),
      old({ id: 'status-null', status: null, updated_at: ago(STALE) }),
      old({ id: 'not-demo', metadata: { demo: false }, updated_at: ago(STALE + 3 * MIN) }),
      old({ id: 'no-metadata', metadata: null, updated_at: ago(STALE + 4 * MIN) }),
      // Never: inside the lookback (the finish's, or not quiet yet), ended,
      // eval, demo, archived, never started (a pending row for a meeting
      // ahead), or with no workspace.
      old({ id: 'finish-window', updated_at: ago(ABANDONED_LOOKBACK_MS - MIN) }),
      old({ id: 'blank-in-window', transcript: null, updated_at: ago(2 * 60 * MIN) }),
      old({ id: 'ended', ended_at: ago(STALE), updated_at: ago(STALE) }),
      old({ id: 'eval', is_eval: true, updated_at: ago(STALE) }),
      old({ id: 'demo', metadata: { demo: true }, updated_at: ago(STALE) }),
      old({ id: 'archived', status: 'archived', updated_at: ago(STALE) }),
      old({ id: 'pending', started_at: null, transcript: null, updated_at: ago(STALE) }),
      old({ id: 'no-workspace', workspace_id: null, updated_at: ago(STALE) }),
    ])
    const found = await findStaleCaptures(fake as never, NOW)
    expect(found.map((r) => r.id)).toEqual(['blank', 'blip', 'no-metadata', 'not-demo', 'meeting', 'ownerless', 'status-null'])
  })

  it('the lookback is one line: a meeting is the finish’s up to it and the retire’s past it, never both', async () => {
    fake.seed('captures', [
      old({ id: 'at-edge', updated_at: ago(ABANDONED_LOOKBACK_MS) }),
      old({ id: 'past-edge', updated_at: ago(ABANDONED_LOOKBACK_MS + 1) }),
    ])
    expect((await findAbandonedCaptures(fake as never, NOW)).map((r) => r.id)).toEqual(['at-edge'])
    expect((await findStaleCaptures(fake as never, NOW)).map((r) => r.id)).toEqual(['past-edge'])
  })

  it('archived, demo, eval and unstarted rows never take the window from one that can be retired', async () => {
    fake.seed('captures', [
      ...Array.from({ length: RETIRE_SWEEP_CAP + 10 }, (_, i) => {
        const skipped = [{ status: 'archived' }, { metadata: { demo: true } }, { is_eval: true }, { started_at: null }][i % 4]
        return old({ id: `skip-${i}`, updated_at: ago(399 * DAY - i * MIN), ...skipped })
      }),
      old({ id: 'real', updated_at: ago(ABANDONED_LOOKBACK_MS + 60 * MIN) }),
    ])
    expect((await findStaleCaptures(fake as never, NOW)).map((r) => r.id)).toEqual(['real'])
  })
})

describe('retireStaleCapture — closed with no pass, CAS on the last write', () => {
  const stale = (over: Row = {}) =>
    capture({
      id: 'c1',
      started_at: ago(40 * DAY),
      updated_at: ago(30 * DAY),
      ai_processed: false,
      ...over,
    })

  it('ends it at the last write and marks it, leaving duration and ai_processed as they were', async () => {
    const row = stale()
    fake.seed('captures', [row])
    expect(await retireStaleCapture(fake as never, row as unknown as StaleCaptureRow, NOW)).toBe(true)
    const [after] = fake.rows('captures')
    expect(after).toMatchObject({
      ended_at: ago(30 * DAY),
      duration_seconds: null,
      ai_processed: false,
      metadata: {
        capture_mode: 'desktop_dual',
        finalized: { by: 'server', reason: 'stale', at: new Date(NOW).toISOString() },
      },
    })
  })

  it('a row with no metadata gets just the mark', async () => {
    const row = stale({ metadata: null })
    fake.seed('captures', [row])
    await retireStaleCapture(fake as never, row as unknown as StaleCaptureRow, NOW)
    expect(fake.rows('captures')[0].metadata).toEqual({ finalized: { by: 'server', reason: 'stale', at: new Date(NOW).toISOString() } })
  })

  it('a write since the read wins, and an end already stamped is never overwritten', async () => {
    const read = stale()
    fake.seed('captures', [
      { ...read, updated_at: ago(MIN) },
      { ...stale({ id: 'c2' }), ended_at: ago(29 * DAY) },
    ])
    expect(await retireStaleCapture(fake as never, read as unknown as StaleCaptureRow, NOW)).toBe(false)
    expect(await retireStaleCapture(fake as never, stale({ id: 'c2' }) as unknown as StaleCaptureRow, NOW)).toBe(false)
    const [wrote, ended] = fake.rows('captures')
    expect(wrote.ended_at).toBeNull()
    expect(wrote.metadata).toEqual({ capture_mode: 'desktop_dual' })
    expect(ended.ended_at).toBe(ago(29 * DAY))
  })

  it('retireStaleCaptures closes up to the cap per call, each at its own last write, and a closed one is not found again', async () => {
    // Only the columns the scan selects come back, as from PostgREST: the close
    // must need nothing else.
    fake = makeFakeSupabase({ project: true })
    const rows = Array.from({ length: RETIRE_SWEEP_CAP + 3 }, (_, i) => stale({ id: `c${i}`, updated_at: ago(4 * DAY + i * MIN) }))
    const lastWrite = new Map(rows.map((r) => [r.id, r.updated_at]))
    fake.seed('captures', rows)
    expect(await retireStaleCaptures(fake as never, NOW)).toBe(RETIRE_SWEEP_CAP)
    expect(await retireStaleCaptures(fake as never, NOW)).toBe(3)
    expect(await retireStaleCaptures(fake as never, NOW)).toBe(0)
    for (const r of fake.rows('captures')) {
      expect(r.ended_at).toBe(lastWrite.get(r.id))
      expect(r.metadata).toEqual({ capture_mode: 'desktop_dual', finalized: { by: 'server', reason: 'stale', at: new Date(NOW).toISOString() } })
    }
  })
})

describe('needsBatchPass', () => {
  it('live mode off: always the batch, as Stop', () => {
    expect(needsBatchPass({ live_mode: false, ai_summary: 'written' }, false)).toBe(true)
  })

  it('live mode on with a record written live: no batch, unless the edition names a batch persona', () => {
    expect(needsBatchPass({ live_mode: true, ai_summary: '## Summary\nShipped.' }, false)).toBe(false)
    expect(needsBatchPass({ live_mode: true, ai_summary: '## Summary\nShipped.' }, true)).toBe(true)
  })

  it('live mode on with NO record (assist-only, or the live agent died too): the batch writes it', () => {
    expect(needsBatchPass({ live_mode: true, ai_summary: null }, false)).toBe(true)
    expect(needsBatchPass({ live_mode: true, ai_summary: '  \n' }, false)).toBe(true)
  })

  it('an unset live_mode reads as the column default (live)', () => {
    expect(needsBatchPass({ live_mode: null, ai_summary: 'written' }, false)).toBe(false)
  })
})

describe('declineRecovery — the owner declined to resume', () => {
  const args = { captureId: 'c1', workspaceId: WS, userId: OWNER }

  it('closes it as Stop does, at the last write, marked as the owner’s decline, and asks for the pass', async () => {
    // The recorder died two minutes ago: no quiet window applies.
    fake.seed('captures', [capture({ id: 'c1', started_at: ago(32 * MIN), updated_at: ago(2 * MIN) })])
    expect(await declineRecovery(fake as never, args, NOW)).toEqual({ status: 'ended', finish: true, endedAt: ago(2 * MIN) })
    expect(fake.rows('captures')[0]).toMatchObject({
      ended_at: ago(2 * MIN),
      duration_seconds: 30 * 60,
      ai_processed: true,
      metadata: {
        capture_mode: 'desktop_dual',
        finalized: { by: 'owner', reason: 'recovery_declined', at: new Date(NOW).toISOString() },
      },
    })
  })

  it('a blank or a blip is closed but not written up; an eval capture likewise', async () => {
    fake.seed('captures', [
      capture({ id: 'blip', transcript: 'x'.repeat(MIN_ABANDONED_TRANSCRIPT_CHARS - 1), updated_at: ago(MIN) }),
      capture({ id: 'eval', is_eval: true, updated_at: ago(MIN) }),
    ])
    for (const id of ['blip', 'eval']) {
      expect(await declineRecovery(fake as never, { ...args, captureId: id }, NOW)).toEqual({ status: 'ended', finish: false, endedAt: ago(MIN) })
    }
    expect(fake.rows('captures').every((r) => r.ended_at === ago(MIN))).toBe(true)
  })

  it('a write between the read and the close wins: the capture stays open, "changed"', async () => {
    fake.seed('captures', [capture({ id: 'c1', updated_at: ago(2 * MIN) })])
    let raced = false
    const racing = {
      from: (table: string) => {
        const q = fake.from(table) as unknown as { maybeSingle: () => Promise<unknown> }
        if (table !== 'captures' || raced) return q
        const read = q.maybeSingle
        q.maybeSingle = async () => {
          const r = await read()
          raced = true
          fake.rows('captures')[0].updated_at = ago(0) // the recorder wrote
          return r
        }
        return q
      },
    }
    expect(await declineRecovery(racing as never, args, NOW)).toEqual({ status: 'changed' })
    expect(fake.rows('captures')[0].ended_at).toBeNull()
    expect(fake.rows('captures')[0].metadata).toEqual({ capture_mode: 'desktop_dual' })
  })

  it('an ended capture is left as it is; someone else’s is not found', async () => {
    fake.seed('captures', [
      capture({ id: 'c1', ended_at: ago(5 * MIN) }),
      capture({ id: 'theirs', user_id: 'u0000000-0000-4000-8000-000000000002' }),
    ])
    expect(await declineRecovery(fake as never, args, NOW)).toEqual({ status: 'already_ended' })
    expect(fake.rows('captures')[0].ended_at).toBe(ago(5 * MIN))
    expect(await declineRecovery(fake as never, { ...args, captureId: 'theirs' }, NOW)).toEqual({ status: 'not_found' })
    expect(fake.rows('captures')[1].ended_at).toBeNull()
  })
})

describe('loadDeclinedCapture — what the finalizer finishes after a decline', () => {
  const declined = (over: Row = {}) =>
    capture({
      id: 'c1',
      ended_at: ago(2 * MIN),
      batch_processed_at: null,
      metadata: { finalized: { by: 'owner', reason: 'recovery_declined', at: ago(MIN) } },
      ...over,
    })

  it('a declined, unprocessed capture with a meeting in it, whose owner is a member', async () => {
    fake.seed('captures', [declined()])
    expect((await loadDeclinedCapture(fake as never, { captureId: 'c1', workspaceId: WS }))?.id).toBe('c1')
  })

  it('never one Stop or the sweep closed, one already processed, one still open, or a blip', async () => {
    fake.seed('captures', [
      declined({ id: 'stop', metadata: {} }),
      declined({ id: 'sweep', metadata: { finalized: { by: 'server', reason: 'recorder_quiet' } } }),
      declined({ id: 'done', batch_processed_at: ago(MIN) }),
      declined({ id: 'open', ended_at: null }),
      declined({ id: 'blip', transcript: 'x'.repeat(10) }),
    ])
    for (const id of ['stop', 'sweep', 'done', 'open', 'blip']) {
      expect(await loadDeclinedCapture(fake as never, { captureId: id, workspaceId: WS })).toBeNull()
    }
  })

  it('never when the owner has left the workspace', async () => {
    fake = makeFakeSupabase()
    fake.seed('captures', [declined()])
    expect(await loadDeclinedCapture(fake as never, { captureId: 'c1', workspaceId: WS })).toBeNull()
  })
})
