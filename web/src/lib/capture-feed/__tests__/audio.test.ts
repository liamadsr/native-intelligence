/**
 * A fed capture's sound files as its page sees them (src/lib/capture-feed/audio.ts):
 * the capture is read as the person first, and someone who may not read it
 * gets nothing (not even whether it has a file); a kept file plays and says
 * the day it will be deleted; a deleted one says the day it was, and is never
 * linked; one that never arrived is nothing; a link is signed as the person,
 * an hour long, and a download link names the file.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { CAPTURE_AUDIO_LINK_TTL_SECONDS, audioDownloadName, audioViewOf, captureAudioFor, captureAudioLink, missingFromDatabase } from '../audio'

const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const NOW = Date.parse('2026-11-20T12:00:00.000Z')

let person: SupabaseClient
let svc: SupabaseClient
let signed: Array<{ path: string; ttl: number; opts: unknown }>
let svcTables: Record<string, Array<Record<string, unknown>>>

type Row = Parameters<typeof audioViewOf>[0] & Record<string, unknown>
const row = (id: string, over: Record<string, unknown>): Row => ({
  id,
  capture_id: CAPTURE,
  part: 0,
  path: `ch/call/audio/${id}.m4a`,
  content_type: 'audio/mp4',
  state: 'stored',
  duration_ms: 2_520_000,
  expires_at: '2026-12-13T10:00:00.000Z',
  stored_at: '2026-11-13T11:00:00.000Z',
  deleted_at: null,
  created_at: '2026-11-13T10:59:00.000Z',
  ...over,
}) as Row

beforeEach(() => {
  signed = []
  // The person's own client: only the captures their RLS lets them read.
  person = Object.assign(memoryDb({ captures: [{ id: CAPTURE }] }), {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe('team-call-recordings')
        return {
          createSignedUrl: async (path: string, ttl: number, opts?: unknown) => {
            signed.push({ path, ttl, opts })
            return { data: { signedUrl: `https://sb.example.test/storage/v1/object/sign/${bucket}/${path}?token=t` }, error: null }
          },
        }
      },
    },
  }) as unknown as SupabaseClient
  svcTables = { capture_audio: [] }
  svc = memoryDb(svcTables) as unknown as SupabaseClient
})

describe('what the page shows of a file', () => {
  it('kept: it plays, with the day it will be deleted', () => {
    expect(audioViewOf(row('a', {}), NOW)).toEqual({ id: 'a', part: 0, state: 'ready', durationMs: 2_520_000, expiresAt: '2026-12-13T10:00:00.000Z', deletedAt: null })
  })
  it('deleted after it was kept: the day it was; never kept: nothing', () => {
    expect(audioViewOf(row('a', { state: 'deleted', deleted_at: '2026-12-14T04:17:00.000Z' }), NOW)).toMatchObject({ state: 'deleted', deletedAt: '2026-12-14T04:17:00.000Z' })
    expect(audioViewOf(row('a', { state: 'deleted', stored_at: null, deleted_at: '2026-12-14T04:17:00.000Z' }), NOW)).toBeNull()
  })
  it('kept but past its day, before the sweep: deleted on that day (what the person was shown)', () => {
    expect(audioViewOf(row('a', {}), Date.parse('2026-12-13T10:00:01.000Z'))).toMatchObject({ state: 'deleted', deletedAt: '2026-12-13T10:00:00.000Z' })
  })
  it('pending: being saved for a day, then nothing', () => {
    expect(audioViewOf(row('a', { state: 'pending', stored_at: null, created_at: new Date(NOW - 60_000).toISOString() }), NOW)?.state).toBe('saving')
    expect(audioViewOf(row('a', { state: 'pending', stored_at: null, created_at: new Date(NOW - 25 * 3600_000).toISOString() }), NOW)).toBeNull()
  })
})

describe('a capture’s files', () => {
  it('for someone who may read the capture, in part order', async () => {
    svcTables.capture_audio.push(row('b', { part: 1 }), row('a', { part: 0 }), row('x', { capture_id: OTHER }))
    const files = await captureAudioFor(person, svc, CAPTURE, NOW)
    expect(files?.map((f) => f.id)).toEqual(['a', 'b'])
  })
  it('null for someone who may not read the capture: its files are not even read', async () => {
    svcTables.capture_audio.push(row('x', { capture_id: OTHER }))
    let read = false
    const watching = Object.assign(Object.create(svc), { from: (t: string) => ((read = true), svc.from(t)) }) as SupabaseClient
    expect(await captureAudioFor(person, watching, OTHER, NOW)).toBeNull()
    expect(read).toBe(false)
  })
})

describe('a link to one file', () => {
  it('to play: signed as the person, an hour long, no download name', async () => {
    svcTables.capture_audio.push(row('a', {}))
    const url = await captureAudioLink(person, svc, CAPTURE, 'a', 'play')
    expect(url).toMatch(/^https:\/\/sb\.example\.test\/storage\/v1\/object\/sign\/team-call-recordings\/ch\/call\/audio\/a\.m4a\?token=/)
    expect(signed).toEqual([{ path: 'ch/call/audio/a.m4a', ttl: CAPTURE_AUDIO_LINK_TTL_SECONDS, opts: undefined }])
  })
  it('to download: the file is named for its day (and its part when there are several)', async () => {
    svcTables.capture_audio.push(row('a', {}), row('b', { part: 1 }))
    await captureAudioLink(person, svc, CAPTURE, 'b', 'download')
    expect(signed[0].opts).toEqual({ download: 'Call audio 2026-11-13 part 2.m4a' })
    expect(audioDownloadName('2026-11-13T10:59:00Z', 0, false, 'audio/mp4')).toBe('Call audio 2026-11-13.m4a')
    expect(audioDownloadName(null, 0, false, 'audio/ogg')).toBe('Call audio.ogg')
  })
  it('never once its day has passed, even before the sweep removed it', async () => {
    svcTables.capture_audio.push(row('a', {}))
    expect(await captureAudioLink(person, svc, CAPTURE, 'a', 'play', Date.parse('2026-12-13T10:00:00.000Z'))).toBeNull()
    expect(await captureAudioLink(person, svc, CAPTURE, 'a', 'play', Date.parse('2026-12-13T09:59:00.000Z'))).not.toBeNull()
  })
  it('never for a file deleted or not yet kept, another capture’s, or a capture the person may not read', async () => {
    svcTables.capture_audio.push(row('d', { state: 'deleted', deleted_at: '2026-12-14T04:17:00Z' }), row('p', { state: 'pending', stored_at: null }), row('x', { capture_id: OTHER }))
    expect(await captureAudioLink(person, svc, CAPTURE, 'd', 'play')).toBeNull()
    expect(await captureAudioLink(person, svc, CAPTURE, 'p', 'download')).toBeNull()
    expect(await captureAudioLink(person, svc, CAPTURE, 'x', 'play')).toBeNull()
    expect(await captureAudioLink(person, svc, OTHER, 'x', 'play')).toBeNull()
    expect(signed).toEqual([])
  })
})

describe('a database without migration 650', () => {
  it('reads Postgres’s and PostgREST’s "not there" as missing, and nothing else', () => {
    expect(missingFromDatabase({ code: '42883', message: 'function public.capture_audio_settle(integer) does not exist' })).toBe(true)
    expect(missingFromDatabase({ code: 'PGRST202', message: 'Could not find the function public.capture_audio_due' })).toBe(true)
    expect(missingFromDatabase({ code: 'PGRST205', message: "Could not find the table 'public.capture_audio'" })).toBe(true)
    expect(missingFromDatabase({ code: '42P01', message: 'relation "public.capture_audio" does not exist' })).toBe(true)
    expect(missingFromDatabase({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false)
    expect(missingFromDatabase(null)).toBe(false)
  })
})
