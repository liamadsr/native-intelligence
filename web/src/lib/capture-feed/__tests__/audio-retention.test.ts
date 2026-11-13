/**
 * Call audio files go after 30 days (src/lib/capture-feed/audio-retention.ts):
 * a pending take whose file landed is settled; a take past its time has its
 * object removed first and only then its row marked deleted with the day (a
 * removal that fails leaves the row for the next run); files no row keeps
 * are removed; each part bounded per run, and a second run changes nothing.
 * The bucket's other files are not this sweep's: it removes only what 650's
 * functions name. And 569's sweep of files whose call is gone marks a call's
 * audio file deleted when it removes it (src/lib/team-calls/notes-retention.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { vi } from 'vitest'
import { AUDIO_RETENTION_BATCH, __forgetSaidMissing, expireCallAudio } from '../audio-retention'
import { sweepCallAudio } from '@/lib/team-calls/notes-retention'

const NOW = new Date('2026-12-14T04:17:00.000Z')
let tables: Record<string, Array<Record<string, unknown>>>
let removed: string[][]
let rpcs: Array<[string, Record<string, unknown>]>
let answers: Record<string, unknown>
let removeFails: boolean
let svc: SupabaseClient

const audio = (id: string, over: Record<string, unknown> = {}) => ({ id, path: `ch/call/audio/${id}.m4a`, state: 'stored', deleted_at: null, updated_at: '2026-11-13T11:00:00Z', ...over })

beforeEach(() => {
  tables = { capture_audio: [], team_call_egress: [] }
  removed = []
  rpcs = []
  answers = {}
  removeFails = false
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      return { data: answers[name] ?? (name === 'capture_audio_settle' ? 0 : []), error: null }
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe('team-call-recordings')
        return {
          remove: async (paths: string[]) => {
            if (removeFails) return { data: null, error: { message: 'storage down' } }
            removed.push(paths)
            return { data: [], error: null }
          },
        }
      },
    },
  }) as unknown as SupabaseClient
})

describe('expireCallAudio', () => {
  it('past 30 days: the object removed, then the row deleted with the day; a kept one untouched', async () => {
    tables.capture_audio.push(audio('old'), audio('kept'))
    answers.capture_audio_due = [{ id: 'old', path: 'ch/call/audio/old.m4a' }]
    answers.capture_audio_settle = 1
    const r = await expireCallAudio(svc, { now: () => NOW })
    expect(r).toEqual({ settled: 1, deleted: 1, orphans: 0 })
    expect(removed).toEqual([['ch/call/audio/old.m4a']])
    expect(tables.capture_audio.find((a) => a.id === 'old')).toMatchObject({ state: 'deleted', deleted_at: NOW.toISOString() })
    expect(tables.capture_audio.find((a) => a.id === 'kept')).toMatchObject({ state: 'stored', deleted_at: null })
    expect(rpcs.map(([n, a]) => [n, a.max_rows])).toEqual([
      ['capture_audio_settle', AUDIO_RETENTION_BATCH],
      ['capture_audio_due', AUDIO_RETENTION_BATCH],
      ['capture_audio_orphans', AUDIO_RETENTION_BATCH],
    ])
  })

  it('a removal that fails leaves the row as it is (the next run tries again), and says so', async () => {
    tables.capture_audio.push(audio('old'))
    answers.capture_audio_due = [{ id: 'old', path: 'ch/call/audio/old.m4a' }]
    removeFails = true
    await expect(expireCallAudio(svc, { now: () => NOW })).rejects.toThrow('files not removed')
    expect(tables.capture_audio[0]).toMatchObject({ state: 'stored', deleted_at: null })
  })

  it('a row deleted already keeps its day; nothing due, nothing removed', async () => {
    tables.capture_audio.push(audio('gone', { state: 'deleted', deleted_at: '2026-12-13T04:17:00.000Z' }))
    answers.capture_audio_orphans = [{ name: 'ch/call/audio/gone.m4a' }]
    const r = await expireCallAudio(svc, { now: () => NOW })
    expect(r.orphans).toBe(1)
    expect(removed).toEqual([['ch/call/audio/gone.m4a']])
    expect(tables.capture_audio[0].deleted_at).toBe('2026-12-13T04:17:00.000Z')
  })

  it('an empty run asks, removes nothing', async () => {
    expect(await expireCallAudio(svc, { now: () => NOW })).toEqual({ settled: 0, deleted: 0, orphans: 0 })
    expect(removed).toEqual([])
  })
})

describe('569’s sweep of files whose call is gone', () => {
  it('marks a call audio file it removed deleted; a recording it removed is not 650’s', async () => {
    tables.capture_audio.push(audio('a1'))
    const svc569 = Object.assign(Object.create(svc), {
      rpc: async () => ({ data: [{ name: 'ch/call/audio/a1.m4a' }, { name: 'ch/call/recording/r.mp4' }], error: null }),
    }) as SupabaseClient
    await sweepCallAudio(svc569, { now: () => NOW })
    expect(removed).toEqual([['ch/call/audio/a1.m4a', 'ch/call/recording/r.mp4']])
    expect(tables.capture_audio[0]).toMatchObject({ state: 'deleted', deleted_at: NOW.toISOString() })
  })
})

describe('before migration 650 (code rolled out first)', () => {
  it('skips, says so once, and the daily job does not fail', async () => {
    __forgetSaidMissing()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const noAudio = Object.assign(Object.create(svc), {
      rpc: async (name: string) => {
        rpcs.push([name, {}])
        if (name === 'team_call_recordings_orphans') return { data: [{ name: 'ch/call/notes/n.ogg' }], error: null }
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}(max_rows) in the schema cache` } }
      },
    }) as SupabaseClient
    expect(await expireCallAudio(noAudio, { now: () => NOW })).toEqual({ settled: 0, deleted: 0, orphans: 0, skipped: true })
    expect(await expireCallAudio(noAudio, { now: () => NOW })).toMatchObject({ skipped: true })
    expect(info.mock.calls.filter((c) => String(c[0]).includes('migration 650')).length).toBe(1)
    expect(rpcs.map(([n]) => n)).toEqual(['capture_audio_settle', 'capture_audio_settle'])
    expect(removed).toEqual([])
    info.mockRestore()
  })
})
