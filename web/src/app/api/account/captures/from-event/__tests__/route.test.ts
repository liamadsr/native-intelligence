/**
 * Tests for POST /api/account/captures/from-event.
 *
 * The route is the single event→capture decision point. The invariants:
 *   - A live (un-ended) row with no transcript is reused, with its event
 *     metadata refreshed and started_at set (pending sync rows) — WITHOUT
 *     null-overwriting series identity the sync already stamped.
 *   - An ENDED capture is never reused — a new capture is created carrying the
 *     same series identity (recurring EventKit occurrences share one event id;
 *     the old behavior recorded into last week's locked row and lost the audio).
 *   - A live row holding ANOTHER occurrence's transcript is closed out only
 *     when STALE; a recently-active one (another window/device recording right
 *     now) is refused with a 409 instead of being ended under the recorder.
 *   - The unique-index race resolves to the winner only when the winner passes
 *     the same reuse rules — and the winner gets the same metadata restamp.
 *   - Retro captures (past meetings) are created already CLOSED so they never
 *     occupy the live slot.
 *   - The same sitting is handed back to be RESUMED instead of split into a
 *     second capture: this occurrence's capture, with text, closed within the
 *     last 15 minutes (a mid-call restart whose resume was declined or lost)
 *     comes back as `resume: true`, and the route writes nothing (the resume
 *     route unlocks it once the client can record).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

interface LiveRow {
  id: string
  transcript: string | null
  occurrence_start: string | null
  started_at: string | null
  recorded_at: string | null
  updated_at: string | null
  metadata: Record<string, unknown> | null
  series_key: string | null
  ical_uid: string | null
  calendar_provider: string | null
  organizer_email: string | null
  meeting_url: string | null
}

function liveRow(overrides: Partial<LiveRow> & { id: string }): LiveRow {
  return {
    transcript: null,
    occurrence_start: null,
    started_at: null,
    recorded_at: null,
    updated_at: null,
    metadata: null,
    series_key: null,
    ical_uid: null,
    calendar_provider: null,
    organizer_email: null,
    meeting_url: null,
    ...overrides,
  }
}

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateSpy: vi.fn(),
  insertSpy: vi.fn(),
  seedParticipants: vi.fn(),
  seedSelf: vi.fn(),
  // Every filter of the recently-ended lookup, as [method, column, value].
  recentFilters: [] as [string, string, unknown][],
  state: {
    live: null as unknown,
    // The recently-ended lookup (the same-sitting reopen). Null = none.
    recent: null as unknown,
    localEvent: null as { has_recurrence: boolean } | null,
    insertError: null as { code: string; message: string } | null,
    raceWinner: null as unknown,
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: hoisted.getUser } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/crm/contacts', () => ({
  seedCaptureParticipants: hoisted.seedParticipants,
  seedSelfParticipant: hoisted.seedSelf,
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    let liveSelects = 0
    return {
      from: (table: string) => {
        if (table === 'local_calendar_event') {
          const chain: Record<string, unknown> = {}
          Object.assign(chain, {
            select: () => chain,
            eq: () => chain,
            limit: () => chain,
            maybeSingle: async () => ({ data: hoisted.state.localEvent, error: null }),
          })
          return chain
        }
        // A `.gte('ended_at', …)` lookup is the recently-ended (same sitting)
        // query; every other capture lookup is the live one (`is ended_at
        // null`): the first returns state.live, a repeat the race winner.
        let recentQuery = false
        const filters: [string, string, unknown][] = []
        const filter = (method: string) => (col: string, value: unknown) => {
          filters.push([method, col, value])
          if (method === 'gte') {
            recentQuery = true
            hoisted.recentFilters.push(...filters)
          } else if (recentQuery) {
            hoisted.recentFilters.push([method, col, value])
          }
          return chain
        }
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          eq: filter('eq'),
          neq: filter('neq'),
          is: filter('is'),
          gte: filter('gte'),
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            if (recentQuery) return { data: hoisted.state.recent, error: null }
            liveSelects += 1
            return liveSelects === 1
              ? { data: hoisted.state.live, error: null }
              : { data: hoisted.state.raceWinner, error: null }
          },
          update: (fields: Record<string, unknown>) => {
            hoisted.updateSpy(fields)
            return { eq: () => Promise.resolve({ error: null }) }
          },
          insert: (fields: Record<string, unknown>) => {
            hoisted.insertSpy(fields)
            return {
              select: () => ({
                single: async () =>
                  hoisted.state.insertError
                    ? { data: null, error: hoisted.state.insertError }
                    : { data: { id: 'new-cap' }, error: null },
              }),
            }
          },
        })
        return chain
      },
    }
  },
}))

const { POST } = await import('@/app/api/account/captures/from-event/route')

function req(body: Record<string, unknown>): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/captures/from-event',
    method: 'POST',
    body: {
      title: 'Weekly Standup',
      start: '2026-08-11T17:00:00.000Z',
      end: '2026-08-11T17:30:00.000Z',
      ...body,
    },
  }) as unknown as NextRequest
}

describe('POST from-event', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.insertSpy.mockClear()
    hoisted.seedParticipants.mockClear()
    hoisted.seedSelf.mockClear()
    hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    hoisted.recentFilters.length = 0
    hoisted.state.live = null
    hoisted.state.recent = null
    hoisted.state.localEvent = null
    hoisted.state.insertError = null
    hoisted.state.raceWinner = null
  })

  it('reuses a pending sync row, refreshing metadata and setting started_at', async () => {
    hoisted.state.live = liveRow({ id: 'cap-pending', metadata: { some_flag: true } })
    const res = await POST(req({ calendar_event_id: 'evt-1', series_master_id: 'master-1' }))
    const json = await readJson<{ capture_id: string; created: boolean }>(res)
    expect(json).toEqual({ capture_id: 'cap-pending', created: false })
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
    const update = hoisted.updateSpy.mock.calls[0][0]
    expect(update.started_at).toBeTruthy()
    expect(update.series_key).toBe('master-1')
    expect(update.occurrence_start).toBe('2026-08-11T17:00:00.000Z')
    expect(update.auto_capture_status).toBe('ready')
    // metadata merge keeps existing keys and stamps the event title
    expect(update.metadata).toMatchObject({ some_flag: true, linked_event_title: 'Weekly Standup' })
  })

  it('never null-overwrites series identity the sync already stamped', async () => {
    // Tray callers can't send seriesMasterId/icalUid — the reused row's stored
    // identity (stamped by calendar sync) must survive the refresh.
    hoisted.state.live = liveRow({
      id: 'cap-pending',
      series_key: 'ms-series-master',
      ical_uid: 'uid@outlook.com',
      calendar_provider: 'microsoft',
      organizer_email: 'pm@acme.com',
    })
    const res = await POST(req({ calendar_event_id: 'AAMkAOpaqueMsId' }))
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(false)
    const update = hoisted.updateSpy.mock.calls[0][0]
    expect(update.series_key).toBe('ms-series-master')
    expect(update.ical_uid).toBe('uid@outlook.com')
    expect(update.calendar_provider).toBe('microsoft')
    expect(update.organizer_email).toBe('pm@acme.com')
  })

  it('creates a NEW capture when only an ended capture exists (never records into history)', async () => {
    // ended rows never come back from the live lookup — live: null models that
    const res = await POST(req({ calendar_event_id: 'evt-1', series_master_id: 'master-1' }))
    const json = await readJson<{ capture_id: string; created: boolean }>(res)
    expect(json).toEqual({ capture_id: 'new-cap', created: true })
    const insert = hoisted.insertSpy.mock.calls[0][0]
    expect(insert.series_key).toBe('master-1')
    expect(insert.occurrence_start).toBe('2026-08-11T17:00:00.000Z')
    expect(insert.started_at).toBeTruthy()
    expect(insert.ended_at).toBeUndefined()
    expect(hoisted.seedSelf).toHaveBeenCalled()
  })

  it('derives the series key from a Google instance id when no explicit fields are sent', async () => {
    const res = await POST(req({ calendar_event_id: 'gmaster_20260811T170000Z' }))
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(true)
    expect(hoisted.insertSpy.mock.calls[0][0].series_key).toBe('gmaster')
  })

  it('threads recurring EventKit events by their shared event id', async () => {
    const res = await POST(
      req({ calendar_event_id: 'EK-SHARED', source: 'local_exchange', has_recurrence: true }),
    )
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(true)
    const insert = hoisted.insertSpy.mock.calls[0][0]
    expect(insert.series_key).toBe('EK-SHARED')
    expect(insert.calendar_provider).toBe('local_exchange')
  })

  it('recovers EventKit recurrence from the local-event cache for legacy callers', async () => {
    hoisted.state.localEvent = { has_recurrence: true }
    const res = await POST(req({ calendar_event_id: 'EK-SHARED' }))
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(true)
    expect(hoisted.insertSpy.mock.calls[0][0].series_key).toBe('EK-SHARED')
  })

  it('refuses (409) when a different-occurrence live row is ACTIVELY recording', async () => {
    // Recently updated = another window/device is saving transcript right now.
    // Ending it would fire the lock trigger under the running recorder.
    hoisted.state.live = liveRow({
      id: 'cap-live-now',
      transcript: '[remote_1] tonight, still going',
      occurrence_start: '2026-08-04T17:00:00.000Z',
      started_at: '2026-08-04T17:00:01.000Z',
      updated_at: new Date().toISOString(),
    })
    const res = await POST(
      req({ calendar_event_id: 'EK-SHARED', source: 'local_exchange', has_recurrence: true }),
    )
    expect(res.status).toBe(409)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('closes out a STALE live crash-orphan from a different occurrence and creates fresh', async () => {
    hoisted.state.live = liveRow({
      id: 'cap-orphan',
      transcript: '[remote_1] last week content',
      occurrence_start: '2020-01-07T17:00:00.000Z',
      started_at: '2020-01-07T17:00:01.000Z',
      updated_at: '2020-01-07T17:45:00.000Z',
    })
    const res = await POST(
      req({ calendar_event_id: 'EK-SHARED', source: 'local_exchange', has_recurrence: true }),
    )
    const json = await readJson<{ capture_id: string; created: boolean }>(res)
    expect(json).toEqual({ capture_id: 'new-cap', created: true })
    // the orphan was retired at its LAST ACTIVITY (truthful duration), not zero
    expect(hoisted.updateSpy.mock.calls[0][0].ended_at).toBe('2020-01-07T17:45:00.000Z')
  })

  it('reuses a live row for the SAME occurrence even when it holds text', async () => {
    hoisted.state.live = liveRow({
      id: 'cap-same',
      transcript: '[remote_1] earlier this meeting',
      occurrence_start: '2026-08-11T17:00:00.000Z',
      started_at: '2026-08-11T17:00:01.000Z',
      recorded_at: '2026-08-11T17:00:01.000Z',
      updated_at: new Date().toISOString(),
    })
    const res = await POST(req({ calendar_event_id: 'evt-1' }))
    const json = await readJson<{ capture_id: string; created: boolean }>(res)
    expect(json).toEqual({ capture_id: 'cap-same', created: false })
  })

  it('resolves the unique-index race by restamping a reusable winner', async () => {
    hoisted.state.insertError = { code: '23505', message: 'duplicate key' }
    hoisted.state.raceWinner = liveRow({ id: 'cap-winner' })
    const res = await POST(req({ calendar_event_id: 'evt-1' }))
    const json = await readJson<{ capture_id: string; created: boolean }>(res)
    expect(json).toEqual({ capture_id: 'cap-winner', created: false })
    // the winner may be a bare sync row — it gets the same refresh as any reuse
    const update = hoisted.updateSpy.mock.calls[0][0]
    expect(update.started_at).toBeTruthy()
    expect(update.auto_capture_status).toBe('ready')
  })

  it('409s the unique-index race when the winner holds another occurrence\'s content', async () => {
    hoisted.state.insertError = { code: '23505', message: 'duplicate key' }
    hoisted.state.raceWinner = liveRow({
      id: 'cap-winner',
      transcript: '[remote_1] other content',
      occurrence_start: '2020-01-07T17:00:00.000Z',
    })
    const res = await POST(req({ calendar_event_id: 'evt-1' }))
    expect(res.status).toBe(409)
  })

  it('creates retro captures for past meetings already CLOSED', async () => {
    const res = await POST(
      req({
        calendar_event_id: 'evt-old',
        start: '2020-01-07T17:00:00.000Z',
        end: '2020-01-07T17:30:00.000Z',
        retro: true,
      }),
    )
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(true)
    const insert = hoisted.insertSpy.mock.calls[0][0]
    expect(insert.ended_at).toBe('2020-01-07T17:30:00.000Z')
    expect(insert.auto_capture_status).toBe('completed')
    expect(insert.started_at).toBe('2020-01-07T17:00:00.000Z')
  })

  it('a retro capture leaves a transcript-less live row alone and inserts a closed one', async () => {
    hoisted.state.live = liveRow({ id: 'cap-pending', occurrence_start: '2020-01-14T17:00:00.000Z' })
    const res = await POST(
      req({
        calendar_event_id: 'evt-1',
        start: '2020-01-07T17:00:00.000Z',
        end: '2020-01-07T17:30:00.000Z',
        retro: true,
      }),
    )
    const json = await readJson<{ created: boolean }>(res)
    expect(json.created).toBe(true)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    expect(hoisted.insertSpy.mock.calls[0][0].ended_at).toBe('2020-01-07T17:30:00.000Z')
  })

  describe('the same sitting, interrupted (a mid-call restart)', () => {
    // The 2026-10-19 Owen call: the 20:52 restart's capture was closed (its
    // recovery prompt answered End capture) and the 20:55 Start made a second
    // capture. This occurrence's capture, closed minutes ago, is handed back to
    // be resumed instead.
    const closedMoments = (over: Record<string, unknown> = {}) => ({
      id: 'cap-interrupted',
      transcript: '[local_1] so the round is a million pre-seed',
      occurrence_start: '2026-08-11T17:00:00.000Z',
      ended_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      metadata: null,
      ...over,
    })

    it('hands back this occurrence\'s capture, closed minutes ago, to be resumed (and writes nothing)', async () => {
      hoisted.state.recent = closedMoments()
      const before = Date.now()
      const res = await POST(req({ calendar_event_id: 'evt-1' }))
      const json = await readJson<{ capture_id: string; created: boolean; resume?: boolean }>(res)
      expect(json).toEqual({ capture_id: 'cap-interrupted', created: false, resume: true })
      expect(hoisted.insertSpy).not.toHaveBeenCalled()
      expect(hoisted.updateSpy).not.toHaveBeenCalled()
      // scoped to the caller's own, unarchived captures of this event
      expect(hoisted.recentFilters).toEqual(expect.arrayContaining([
        ['eq', 'calendar_event_id', 'evt-1'],
        ['eq', 'user_id', 'user-1'],
        ['eq', 'workspace_id', 'ws-1'],
        ['neq', 'status', 'archived'],
      ]))
      // ended_at is searched 25 minutes back (a declined recovery backdates it)
      const gte = hoisted.recentFilters.find(([m]) => m === 'gte')!
      expect(gte[1]).toBe('ended_at')
      const lookback = before - new Date(gte[2] as string).getTime()
      expect(lookback).toBeGreaterThanOrEqual(25 * 60_000 - 1_000)
      expect(lookback).toBeLessThanOrEqual(25 * 60_000 + 1_000)
    })

    it('hands it back even past a transcript-less placeholder (the resume route absorbs it)', async () => {
      hoisted.state.live = liveRow({ id: 'cap-pending' })
      hoisted.state.recent = closedMoments()
      const res = await POST(req({ calendar_event_id: 'evt-1' }))
      const json = await readJson<{ capture_id: string; resume?: boolean }>(res)
      expect(json).toEqual({ capture_id: 'cap-interrupted', created: false, resume: true })
      expect(hoisted.updateSpy).not.toHaveBeenCalled()
    })

    it('times a declined recovery from its close, not its backdated ended_at', async () => {
      // ended_at is the recorder's last write, 20 minutes ago; the prompt was
      // answered (finalized.at) 6 minutes ago: still the same sitting.
      hoisted.state.recent = closedMoments({
        ended_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        metadata: { finalized: { by: 'owner', reason: 'recovery_declined', at: new Date(Date.now() - 6 * 60_000).toISOString() } },
      })
      const json = await readJson<{ resume?: boolean }>(await POST(req({ calendar_event_id: 'evt-1' })))
      expect(json.resume).toBe(true)
    })

    it('a capture closed more than 15 minutes ago is history: a new capture', async () => {
      hoisted.state.recent = closedMoments({ ended_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      const json = await readJson<{ capture_id: string; created: boolean }>(await POST(req({ calendar_event_id: 'evt-1' })))
      expect(json).toEqual({ capture_id: 'new-cap', created: true })
    })

    it('never hands back ANOTHER occurrence (recurring events share one id)', async () => {
      hoisted.state.recent = closedMoments({ occurrence_start: '2026-08-11T16:00:00.000Z' })
      const res = await POST(
        req({ calendar_event_id: 'EK-SHARED', source: 'local_exchange', has_recurrence: true }),
      )
      const json = await readJson<{ capture_id: string; created: boolean }>(res)
      expect(json).toEqual({ capture_id: 'new-cap', created: true })
    })

    it('does not hand back a closed capture with no transcript', async () => {
      hoisted.state.recent = closedMoments({ transcript: '  ' })
      const json = await readJson<{ created: boolean }>(await POST(req({ calendar_event_id: 'evt-1' })))
      expect(json.created).toBe(true)
    })

    it('a live row with text for this occurrence still wins (nothing closed is looked up)', async () => {
      hoisted.state.live = liveRow({
        id: 'cap-same',
        transcript: '[remote_1] earlier this meeting',
        occurrence_start: '2026-08-11T17:00:00.000Z',
      })
      hoisted.state.recent = closedMoments()
      const json = await readJson<{ capture_id: string; created: boolean }>(await POST(req({ calendar_event_id: 'evt-1' })))
      expect(json).toEqual({ capture_id: 'cap-same', created: false })
      expect(hoisted.recentFilters).toEqual([])
    })

    it('never for a retro capture', async () => {
      hoisted.state.recent = closedMoments()
      const res = await POST(
        req({
          calendar_event_id: 'evt-1',
          start: '2020-01-07T17:00:00.000Z',
          end: '2020-01-07T17:30:00.000Z',
          retro: true,
        }),
      )
      const json = await readJson<{ created: boolean }>(res)
      expect(json.created).toBe(true)
      expect(hoisted.recentFilters).toEqual([])
    })
  })

  it('a meeting whose call capture holds the event (656): the call is taking notes, and no device records into it', async () => {
    hoisted.state.live = { ...liveRow({ id: 'cap-call', transcript: '[Dana Ortiz] Welcome.', occurrence_start: '2026-08-11T17:00:00.000Z' }), notes_channel_id: 'chan-call' }
    const res = await POST(req({ calendar_event_id: 'evt-call' }))
    expect(res.status).toBe(409)
    expect(await readJson<{ code: string; capture_id: string }>(res)).toMatchObject({ code: 'CALL_CAPTURES_MEETING', capture_id: 'cap-call' })
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('a call capture that ended moments ago is never resumed by a device', async () => {
    hoisted.state.recent = {
      id: 'cap-call',
      transcript: '[Dana Ortiz] Welcome.',
      occurrence_start: '2026-08-11T17:00:00.000Z',
      ended_at: new Date(Date.now() - 60_000).toISOString(),
      metadata: null,
      notes_channel_id: 'chan-call',
    }
    const res = await POST(req({ calendar_event_id: 'evt-call' }))
    const json = await readJson<{ resume?: boolean; created: boolean }>(res)
    expect(json.resume).toBeUndefined()
    expect(json.created).toBe(true)
  })

  it('401s when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(req({ calendar_event_id: 'evt-1' }))
    expect(res.status).toBe(401)
  })

  it('400s on missing required fields', async () => {
    const res = await POST(req({ calendar_event_id: '' }))
    expect(res.status).toBe(400)
  })

  it('400s on an unparseable start date instead of 500ing', async () => {
    const res = await POST(req({ calendar_event_id: 'evt-1', start: 'tomorrow 5pm' }))
    expect(res.status).toBe(400)
  })
})
