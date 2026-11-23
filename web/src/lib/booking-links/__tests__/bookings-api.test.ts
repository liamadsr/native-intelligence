import { memoryDb } from '@/test/memory-db'
import { describe, expect, it } from 'vitest'
import {
  handleExport,
  handleInsights,
  handleListBookings,
  handleMarkAttendance,
} from '../bookings-api'

// Made-up people: Ava hosts; Cy hosts nothing.
const WS = '11111111-1111-4111-8111-111111111111'
const AVA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LINK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const B1 = '00000001-0000-4000-8000-000000000000'
const NOW = Date.parse('2026-11-20T15:00:00Z')

function db() {
  const base = {
    workspace_id: WS,
    host_user_id: AVA,
    host_name: 'Ava Lin',
    source: 'link',
    link_id: LINK,
    guest_email: 'dana@example.com',
    guest_phone: null,
    guest_time_zone: null,
    title: 'Intro call',
    video: true,
    location: null,
    conference_url: null,
    answers: [],
    other_host_ids: [],
    cancelled_by: null,
    attendance: null,
    created_at: '2026-11-01T00:00:00Z',
  }
  return memoryDb({
    booking_link: [
      {
        id: LINK,
        workspace_id: WS,
        owner_user_id: AVA,
        profile_id: null,
        slug: 'intro',
        purpose: 'meeting',
        title: 'Intro call',
        duration_minutes: 30,
        window_days: 30,
        questions: [],
        video: true,
        host_mode: 'one',
        active: true,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    booking_link_host: [
      { link_id: LINK, user_id: AVA, workspace_id: WS, position: 0 },
    ],
    booking_profile: [],
    meeting_booking: [
      {
        ...base,
        id: B1,
        guest_name: '=cmd()',
        starts_at: '2026-11-19T15:00:00Z',
        ends_at: '2026-11-19T15:30:00Z',
        state: 'confirmed',
      },
      {
        ...base,
        id: '00000002-0000-4000-8000-000000000000',
        guest_name: 'Eli Park',
        starts_at: '2026-11-20T16:00:00Z',
        ends_at: '2026-11-20T16:30:00Z',
        state: 'confirmed',
      },
    ],
  })
}

const req = (path: string, init?: RequestInit) =>
  new Request(`https://app.test${path}`, init)
const deps = () => ({ supabase: db(), now: () => NOW })

describe('link bookings API', () => {
  it("lists the reader's bookings with the filter's links, and nothing for a teammate", async () => {
    const d = deps()
    const res = await handleListBookings(
      req('/api/account/link-bookings?view=upcoming'),
      { workspaceId: WS, userId: AVA },
      d,
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(
      body.bookings.map((b: { guest_name: string }) => b.guest_name),
    ).toEqual(['Eli Park'])
    expect(body.bookings[0].link_title).toBe('Intro call')
    expect(body.links).toEqual([
      { id: LINK, title: 'Intro call', active: true },
    ])
    const cy = await (
      await handleListBookings(
        req('/api/account/link-bookings?view=past'),
        { workspaceId: WS, userId: CY },
        d,
      )
    ).json()
    expect(cy.bookings).toEqual([])
    expect(cy.links).toEqual([])
    expect(
      (
        await handleListBookings(
          req('/api/account/link-bookings?view=all'),
          { workspaceId: WS, userId: AVA },
          d,
        )
      ).status,
    ).toBe(400)
  })

  it('marks attendance, and refuses a bad body or another person', async () => {
    const d = deps()
    const ok = await handleMarkAttendance(
      req('/x', {
        method: 'PATCH',
        body: JSON.stringify({ attendance: 'attended' }),
      }),
      B1,
      { workspaceId: WS, userId: AVA },
      d,
    )
    expect(ok.status).toBe(200)
    expect((await ok.json()).booking.attendance).toBe('attended')
    expect(
      (
        await handleMarkAttendance(
          req('/x', {
            method: 'PATCH',
            body: JSON.stringify({ attendance: 'maybe' }),
          }),
          B1,
          { workspaceId: WS, userId: AVA },
          d,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await handleMarkAttendance(
          req('/x', {
            method: 'PATCH',
            body: JSON.stringify({ attendance: 'no_show' }),
          }),
          B1,
          { workspaceId: WS, userId: CY },
          d,
        )
      ).status,
    ).toBe(404)
  })

  it('insights over a range, and a bad range refused', async () => {
    const d = deps()
    const body = await (
      await handleInsights(
        req('/x?days=7&tz=UTC'),
        { workspaceId: WS, userId: AVA },
        d,
      )
    ).json()
    expect(body.insights.totals.booked).toBe(2)
    expect(body.insights.series).toHaveLength(7)
    expect(
      (
        await handleInsights(
          req('/x?days=8'),
          { workspaceId: WS, userId: AVA },
          d,
        )
      ).status,
    ).toBe(400)
  })

  it('exports CSV, formulas defused', async () => {
    const res = await handleExport(
      req('/x?days=7&tz=UTC'),
      { workspaceId: WS, userId: AVA },
      deps(),
    )
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const text = await res.text()
    expect(text).toContain("'=cmd()")
    expect(text.trim().split('\r\n')).toHaveLength(3)
  })
})
