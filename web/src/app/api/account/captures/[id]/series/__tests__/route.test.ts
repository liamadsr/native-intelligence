/**
 * Tests for GET /api/account/captures/[id]/series — the recurring-meeting
 * history thread. Visibility is enforced by RLS on the user-scoped client
 * (mig 223); these tests cover the endpoint's own logic:
 *   - dedupe across the series_key / ical_uid / calendar_event_id lookups
 *   - grouping captures of the SAME occurrence (N teammates, one call)
 *   - newest-first ordering, owner attribution, is_own flags
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

interface Row {
  id: string
  title: string
  user_id: string
  started_at: string | null
  ended_at: string | null
  created_at: string
  duration_seconds: number | null
  visibility: string | null
  occurrence_start: string | null
  calendar_event_id: string | null
  series_key: string | null
}

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  state: {
    anchor: null as Record<string, unknown> | null,
    siblings: [] as unknown[],
    members: [] as unknown[],
  },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

function makeSupabase() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: hoisted.state.anchor, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: table === 'member' ? hoisted.state.members : hoisted.state.siblings }),
      })
      return chain
    },
  }
}

const { GET } = await import('@/app/api/account/captures/[id]/series/route')

function call(id = 'cap-anchor') {
  const request = buildRequest({
    url: `https://nativeintelligence.dev/api/account/captures/${id}/series`,
    method: 'GET',
  }) as unknown as NextRequest
  return GET(request, { params: Promise.resolve({ id }) })
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    title: 'Weekly Standup',
    user_id: 'user-1',
    started_at: '2026-08-11T17:00:05.000Z',
    ended_at: '2026-08-11T17:30:00.000Z',
    created_at: '2026-08-11T17:00:00.000Z',
    duration_seconds: 1800,
    visibility: 'workspace',
    occurrence_start: '2026-08-11T17:00:00.000Z',
    calendar_event_id: 'evt-1',
    series_key: 'series-1',
    ...overrides,
  }
}

describe('GET captures/[id]/series', () => {
  beforeEach(() => {
    hoisted.state.anchor = {
      id: 'cap-anchor',
      series_key: 'series-1',
      ical_uid: 'uid-1',
      calendar_event_id: 'evt-1',
    }
    hoisted.state.members = [
      { user_id: 'user-1', display_name: 'Liam', avatar_url: null },
      { user_id: 'user-2', display_name: 'Sam', avatar_url: null },
    ]
    hoisted.state.siblings = []
    hoisted.requireWorkspace.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: 'user-1' },
      workspaceId: 'ws-1',
    })
  })

  it('groups same-occurrence captures from different teammates into one occurrence', async () => {
    hoisted.state.siblings = [
      row({ id: 'cap-anchor', user_id: 'user-1' }),
      row({ id: 'cap-sam', user_id: 'user-2' }),
      row({
        id: 'cap-lastweek',
        user_id: 'user-1',
        occurrence_start: '2026-08-04T17:00:00.000Z',
        started_at: '2026-08-04T17:00:05.000Z',
        created_at: '2026-08-04T17:00:00.000Z',
      }),
    ]
    const res = await call()
    expect(res.status).toBe(200)
    const json = await readJson<{
      series_key: string | null
      occurrences: Array<{ occurrence_start: string; captures: Array<Record<string, unknown>> }>
    }>(res)

    expect(json.series_key).toBe('series-1')
    expect(json.occurrences).toHaveLength(2)
    // newest occurrence first, with both teammates' captures grouped
    expect(json.occurrences[0].captures.map((c) => c.id).sort()).toEqual(['cap-anchor', 'cap-sam'])
    expect(json.occurrences[1].captures.map((c) => c.id)).toEqual(['cap-lastweek'])

    const own = json.occurrences[0].captures.find((c) => c.id === 'cap-anchor')
    const teammate = json.occurrences[0].captures.find((c) => c.id === 'cap-sam')
    expect(own?.is_own).toBe(true)
    expect(teammate?.is_own).toBe(false)
    expect(teammate?.owner_name).toBe('Sam')
  })

  it('excludes never-started placeholder rows (sync pending) but keeps the anchor', async () => {
    hoisted.state.siblings = [
      // the anchor itself is a pending row the user is looking at — kept
      row({ id: 'cap-anchor', started_at: null, ended_at: null }),
      // sync pre-created placeholder for NEXT week — not a session, excluded
      row({
        id: 'cap-placeholder',
        started_at: null,
        ended_at: null,
        occurrence_start: '2026-08-18T17:00:00.000Z',
        created_at: '2026-08-11T00:00:00.000Z',
      }),
      row({
        id: 'cap-lastweek',
        occurrence_start: '2026-08-04T17:00:00.000Z',
        started_at: '2026-08-04T17:00:05.000Z',
        created_at: '2026-08-04T17:00:00.000Z',
      }),
    ]
    const res = await call()
    const json = await readJson<{ occurrences: Array<{ captures: Array<{ id: string }> }> }>(res)
    const ids = json.occurrences.flatMap((o) => o.captures.map((c) => c.id))
    expect(ids).toContain('cap-anchor')
    expect(ids).toContain('cap-lastweek')
    expect(ids).not.toContain('cap-placeholder')
  })

  it('dedupes rows returned by multiple key lookups', async () => {
    // the same row comes back from the series_key, ical_uid, AND event-id queries
    hoisted.state.siblings = [row({ id: 'cap-anchor' })]
    const res = await call()
    const json = await readJson<{ occurrences: Array<{ captures: unknown[] }> }>(res)
    expect(json.occurrences).toHaveLength(1)
    expect(json.occurrences[0].captures).toHaveLength(1)
  })

  it('returns empty occurrences for a capture with no linkage keys', async () => {
    hoisted.state.anchor = {
      id: 'cap-anchor',
      series_key: null,
      ical_uid: null,
      calendar_event_id: null,
    }
    const res = await call()
    const json = await readJson<{ series_key: null; occurrences: unknown[] }>(res)
    expect(json.series_key).toBeNull()
    expect(json.occurrences).toEqual([])
  })

  it('404s when the anchor is not visible to the caller', async () => {
    hoisted.state.anchor = null
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('passes through auth failures', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await call()
    expect(res.status).toBe(401)
  })
})
