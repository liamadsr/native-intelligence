import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for attendee mapping in the Google + Microsoft calendar readers.
 *
 * The bug this locks down: both mappers used to flatten attendees to bare
 * email strings, throwing away Google's `displayName` / Microsoft's
 * `emailAddress.name`. Downstream, seedCaptureParticipants then had nothing
 * but the address to use as a name — and a contact whose name IS its email is
 * exactly what the CRM noise filter refuses to create. So a real external
 * attendee (nikhil.rao@pagetrail.ai) got a participant row and no contact.
 *
 * `attendees: string[]` must stay byte-identical — it has many consumers —
 * while the new `attendeeDetails` carries the names.
 */

const hoisted = vi.hoisted(() => ({
  getValidToken: vi.fn(),
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: hoisted.getValidToken,
  getValidTokenForAccount: vi.fn(),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({}),
}))

const { listCalendarEvents } = await import('@/lib/integrations/calendar')

const originalFetch = globalThis.fetch

function mockFetchOnce(payload: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch
}

beforeEach(() => {
  hoisted.getValidToken.mockReset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Google attendee mapping', () => {
  beforeEach(() => {
    // google token present, microsoft never consulted
    hoisted.getValidToken.mockImplementation(async (_u: string, provider: string) =>
      provider === 'google' ? { token: 'gtok' } : null,
    )
  })

  it('preserves displayName, organizer and responseStatus in attendeeDetails', async () => {
    mockFetchOnce({
      summary: 'Primary',
      items: [
        {
          id: 'evt-1',
          summary: 'Nikhil & Liam',
          start: { dateTime: '2026-09-03T10:00:00Z' },
          end: { dateTime: '2026-09-03T10:30:00Z' },
          organizer: { email: 'me@dial8.ai' },
          attendees: [
            { email: 'me@dial8.ai', displayName: 'Liam A', organizer: true, responseStatus: 'accepted' },
            { email: 'nikhil.rao@pagetrail.ai', displayName: 'Nikhil Rao', responseStatus: 'needsAction' },
          ],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendeeDetails).toEqual([
      { email: 'me@dial8.ai', name: 'Liam A', isOrganizer: true, responseStatus: 'accepted' },
      {
        email: 'nikhil.rao@pagetrail.ai',
        name: 'Nikhil Rao',
        isOrganizer: undefined,
        responseStatus: 'needsAction',
      },
    ])
  })

  it('leaves the bare attendees array untouched', async () => {
    mockFetchOnce({
      summary: 'Primary',
      items: [
        {
          id: 'evt-1',
          summary: 'Nikhil & Liam',
          start: { dateTime: '2026-09-03T10:00:00Z' },
          end: { dateTime: '2026-09-03T10:30:00Z' },
          attendees: [
            { email: 'me@dial8.ai', displayName: 'Liam A' },
            { email: 'nikhil.rao@pagetrail.ai' },
          ],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendees).toEqual(['me@dial8.ai', 'nikhil.rao@pagetrail.ai'])
  })

  it('omits the name when Google sends no displayName (the Nikhil case)', async () => {
    mockFetchOnce({
      summary: 'Primary',
      items: [
        {
          id: 'evt-1',
          summary: 'Nikhil & Liam',
          start: { dateTime: '2026-09-03T10:00:00Z' },
          end: { dateTime: '2026-09-03T10:30:00Z' },
          attendees: [{ email: 'nikhil.rao@pagetrail.ai' }],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendeeDetails?.[0]).toMatchObject({
      email: 'nikhil.rao@pagetrail.ai',
      name: undefined,
    })
  })

  it('drops attendee entries with no real address', async () => {
    mockFetchOnce({
      summary: 'Primary',
      items: [
        {
          id: 'evt-1',
          summary: 'Room booking',
          start: { dateTime: '2026-09-03T10:00:00Z' },
          end: { dateTime: '2026-09-03T10:30:00Z' },
          attendees: [{ displayName: 'Big Conference Room' }, { email: 'nikhil.rao@pagetrail.ai' }],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendeeDetails).toHaveLength(1)
    expect(event.attendeeDetails?.[0].email).toBe('nikhil.rao@pagetrail.ai')
  })
})

describe('Microsoft attendee mapping', () => {
  beforeEach(() => {
    hoisted.getValidToken.mockImplementation(async (_u: string, provider: string) =>
      provider === 'microsoft' ? { token: 'mtok' } : null,
    )
  })

  it('preserves emailAddress.name and derives isOrganizer from the event organizer', async () => {
    mockFetchOnce({
      value: [
        {
          id: 'evt-1',
          subject: 'Nikhil & Liam',
          start: { dateTime: '2026-09-03T10:00:00' },
          end: { dateTime: '2026-09-03T10:30:00' },
          organizer: { emailAddress: { address: 'me@dial8.ai', name: 'Liam A' } },
          attendees: [
            {
              emailAddress: { address: 'me@dial8.ai', name: 'Liam A' },
              type: 'required',
              status: { response: 'organizer' },
            },
            {
              emailAddress: { address: 'nikhil.rao@pagetrail.ai', name: 'Nikhil Rao' },
              type: 'required',
              status: { response: 'none' },
            },
          ],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendeeDetails).toEqual([
      { email: 'me@dial8.ai', name: 'Liam A', isOrganizer: true, responseStatus: 'organizer' },
      {
        email: 'nikhil.rao@pagetrail.ai',
        name: 'Nikhil Rao',
        isOrganizer: undefined,
        responseStatus: 'none',
      },
    ])
    // The flat array is unchanged.
    expect(event.attendees).toEqual(['me@dial8.ai', 'nikhil.rao@pagetrail.ai'])
  })

  it('drops a Graph name that just mirrors the address', async () => {
    // Graph echoes the address into `name` when there is no display name.
    // Storing that as a contact name is the exact pollution we are avoiding.
    mockFetchOnce({
      value: [
        {
          id: 'evt-1',
          subject: 'Sync',
          start: { dateTime: '2026-09-03T10:00:00' },
          end: { dateTime: '2026-09-03T10:30:00' },
          attendees: [
            {
              emailAddress: {
                address: 'nikhil.rao@pagetrail.ai',
                name: 'Nikhil.Rao@pagetrail.ai',
              },
            },
          ],
        },
      ],
    })

    const [event] = await listCalendarEvents('user-1')

    expect(event.attendeeDetails?.[0].name).toBeUndefined()
  })
})
