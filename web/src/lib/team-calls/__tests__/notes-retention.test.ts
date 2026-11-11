/**
 * Call audio's retention (src/lib/team-calls/notes-retention.ts): raw notes
 * audio whose words are in goes (a recorded call's too), audio whose words
 * could not be read goes after a week, the files of calls that are gone go,
 * each kind bounded per run.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { FAILED_AUDIO_DAYS, RETENTION_BATCH, sweepCallAudio } from '../notes-retention'

const NOW = new Date('2026-11-20T04:17:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60_000).toISOString()

let tables: Record<string, Array<Record<string, unknown>>>
let removed: string[][]
let orphans: string[]
let svc: SupabaseClient

beforeEach(() => {
  tables = { team_call_egress: [] }
  removed = []
  orphans = []
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('team_call_recordings_orphans')
      expect(args).toEqual({ max_rows: RETENTION_BATCH })
      return { data: orphans.map((n) => ({ name: n })), error: null }
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe('team-call-recordings')
        return {
          remove: async (paths: string[]) => {
            removed.push(paths)
            return { data: [], error: null }
          },
        }
      },
    },
  }) as unknown as SupabaseClient
})

const row = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: 'notes',
  file_path: `ch/call/notes/${id}.ogg`,
  audio_deleted_at: null,
  transcript_status: 'done',
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  ...over,
})

describe('sweepCallAudio', () => {
  it("removes audio whose words are in (done or empty), and marks the rows; a recording's file is never touched here", async () => {
    tables.team_call_egress.push(
      row('a', {}),
      row('b', { transcript_status: 'empty' }),
      row('c', { transcript_status: 'pending' }),
      row('d', { audio_deleted_at: daysAgo(2) }),
      row('r', { kind: 'recording', transcript_status: 'none', file_path: 'ch/call/recording/r.mp4' }),
    )
    const result = await sweepCallAudio(svc, { now: () => NOW })
    expect(result).toEqual({ settled: 2, failedExpired: 0, orphans: 0 })
    expect(removed).toEqual([['ch/call/notes/a.ogg', 'ch/call/notes/b.ogg']])
    expect(tables.team_call_egress.filter((r) => r.audio_deleted_at && r.id !== 'd').map((r) => r.id)).toEqual(['a', 'b'])
  })

  it(`keeps audio whose words could not be read for ${FAILED_AUDIO_DAYS} days, then removes it`, async () => {
    tables.team_call_egress.push(row('young', { transcript_status: 'failed', updated_at: daysAgo(3) }), row('old', { transcript_status: 'failed', updated_at: daysAgo(8) }))
    const result = await sweepCallAudio(svc, { now: () => NOW })
    expect(result.failedExpired).toBe(1)
    expect(removed).toEqual([['ch/call/notes/old.ogg']])
  })

  it('removes the files of calls that are gone (recordings too)', async () => {
    orphans = ['gone-ch/gone-call/recording/x.mp4', 'gone-ch/gone-call/notes/y.ogg']
    const result = await sweepCallAudio(svc, { now: () => NOW })
    expect(result.orphans).toBe(2)
    expect(removed).toEqual([orphans])
  })

  it('bounded: at most one batch of each kind per run', async () => {
    for (let i = 0; i < RETENTION_BATCH + 5; i++) tables.team_call_egress.push(row(`r${i}`, { created_at: new Date(NOW.getTime() - (1000 - i) * 1000).toISOString() }))
    const result = await sweepCallAudio(svc, { now: () => NOW })
    expect(result.settled).toBe(RETENTION_BATCH)
  })
})
