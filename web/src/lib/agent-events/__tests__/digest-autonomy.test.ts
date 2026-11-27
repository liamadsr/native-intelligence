/**
 * The daily digest's "Done on its own" group (earned autonomy, phase 4): one
 * line per action of a handed-over kind that ran, newest first, in the
 * person's zone, counted, before doc updates; no group when there were none;
 * read only while EARNED_AUTONOMY=graduate, and a failed read never fails the
 * digest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { autonomyLines, digestBody, gatherDigest, DIGEST_MAX_AUTONOMY_LINES } from '../digest'

const WS = 'ws-1'
const USER = 'user-1'
const NOW = Date.parse('2026-10-14T13:00:00Z')

afterEach(() => vi.unstubAllEnvs())

describe('digestBody — done on its own', () => {
  it('a group of its own, newest first, in the person\'s zone, counted, before doc updates', () => {
    const body = digestBody(
      {
        events: [],
        logLines: [{ at: '2026-10-14T09:00:00Z', line: 'Native Intelligence updated Voice in Product', ref_type: 'document', ref_id: 'd1', kind: 'doc_updated' }],
        autonomy: [
          { at: '2026-10-14T08:05:00Z', title: 'Invite Dana to Sync' },
          { at: '2026-10-14T12:30:00Z', title: 'Offer Lee times by text' },
        ],
      },
      { date: '2026-10-14', timeZone: 'America/Chicago' },
    )!
    expect(body.counts).toEqual(['2 done on its own', '1 doc update'])
    const i = body.lines.findIndex((l) => l.startsWith('Done on its own'))
    expect(body.lines.slice(i + 1, i + 3)).toEqual(['- 7:30 AM Offer Lee times by text', '- 3:05 AM Invite Dana to Sync'])
    expect(body.lines.findIndex((l) => l.startsWith('Doc updates'))).toBeGreaterThan(i)
  })

  it('alone it is enough for a digest; none and nothing else is no digest; no group when none', () => {
    expect(digestBody({ events: [], logLines: [], autonomy: [{ at: '2026-10-14T08:05:00Z', title: 'x' }] }, { date: '2026-10-14', timeZone: 'UTC' })).not.toBeNull()
    expect(digestBody({ events: [], logLines: [], autonomy: [] }, { date: '2026-10-14', timeZone: 'UTC' })).toBeNull()
    const body = digestBody({ events: [], logLines: [{ at: '2026-10-14T09:00:00Z', line: 'Finished: x', ref_type: null, ref_id: null, kind: 'work_finished' }] }, { date: '2026-10-14', timeZone: 'UTC' })!
    expect(body.lines.some((l) => l.startsWith('Done on its own'))).toBe(false)
  })

  it('names at most six, then how many more', () => {
    const many = Array.from({ length: DIGEST_MAX_AUTONOMY_LINES + 2 }, (_, i) => ({ at: new Date(NOW - i * 60_000).toISOString(), title: `Action ${i}` }))
    const lines = autonomyLines(many, 'UTC')
    expect(lines).toHaveLength(1 + DIGEST_MAX_AUTONOMY_LINES + 1)
    expect(lines.at(-1)).toBe('- …and 2 more')
  })
})

describe('gatherDigest — done on its own', () => {
  const seed = () => {
    const db = makeFakeSupabase()
    db.seed('autonomy_action', [
      { workspace_id: WS, user_id: USER, status: 'ran', title: 'Invite Dana to Sync', ran_at: new Date(NOW - 3_600_000).toISOString() },
      { workspace_id: WS, user_id: USER, status: 'undone', title: 'Stopped one', ran_at: null },
      { workspace_id: WS, user_id: USER, status: 'ran', title: 'Too old', ran_at: new Date(NOW - 3 * 86_400_000).toISOString() },
      { workspace_id: WS, user_id: 'someone-else', status: 'ran', title: 'Not mine', ran_at: new Date(NOW - 3_600_000).toISOString() },
    ])
    return db
  }

  it('graduate: the person\'s own actions that ran since the last digest', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    const g = await gatherDigest(seed() as never, { workspaceId: WS, userId: USER, conversationId: 'conv-1', date: '2026-10-14', nowMs: NOW })
    expect(g.autonomy).toEqual([{ at: new Date(NOW - 3_600_000).toISOString(), title: 'Invite Dana to Sync' }])
  })

  it('off or record: not read at all', async () => {
    for (const mode of ['', 'record']) {
      vi.stubEnv('EARNED_AUTONOMY', mode)
      const db = seed()
      const g = await gatherDigest(db as never, { workspaceId: WS, userId: USER, conversationId: 'conv-1', date: '2026-10-14', nowMs: NOW })
      expect(g.autonomy).toEqual([])
      expect(db.calls.some((c) => c.table === 'autonomy_action')).toBe(false)
    }
  })

  it('a read that throws (726 not applied) is none, and the digest still gathers', async () => {
    vi.stubEnv('EARNED_AUTONOMY', 'graduate')
    const db = seed()
    const realFrom = db.from.bind(db)
    ;(db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'autonomy_action') throw new Error('relation "autonomy_action" does not exist')
      return realFrom(t)
    }
    const g = await gatherDigest(db as never, { workspaceId: WS, userId: USER, conversationId: 'conv-1', date: '2026-10-14', nowMs: NOW })
    expect(g.autonomy).toEqual([])
  })
})
