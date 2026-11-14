/**
 * A meeting's call capture, linked to the meeting's calendar event
 * (src/lib/team-calls/event-link.ts, migration 656): off unless
 * TEAM_CALL_EVENT_LINK=on with the recorder on, and then one call of 656 per
 * capture, whose answer it passes on; a failure is logged and never thrown.
 * What 656 links and refuses (no meeting, no event, someone else's
 * calendar, a capture whose owner is not the host, the owner's own capture
 * holding the event, a booking's confirmed event) is run on PGlite by
 * scripts/check-call-live-notes-sql.mjs.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LIVEKIT_ENV } from './signing'

vi.mock('server-only', () => ({}))

const { linkCallCaptureToEvent, teamCallEventLinkOn } = await import('../event-link')

const CAPTURE = '11111111-1111-4111-8111-111111111111'
/** An environment as process.env holds one. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv

const ON = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789', TEAM_CALL_EVENT_LINK: 'on' }

function svc(answer: { data: unknown; error: unknown }) {
  const rpcs: Array<[string, unknown]> = []
  return { rpcs, client: { rpc: async (n: string, a: unknown) => (rpcs.push([n, a]), answer) } as unknown as SupabaseClient }
}

describe('the calendar link', () => {
  it('is off unless TEAM_CALL_EVENT_LINK=on with the recorder on', async () => {
    expect(teamCallEventLinkOn(env({}))).toBe(false)
    expect(teamCallEventLinkOn(env({ TEAM_CALL_EVENT_LINK: 'on' }))).toBe(false)
    expect(teamCallEventLinkOn(env(ON))).toBe(true)
    const s = svc({ data: 'linked', error: null })
    expect(await linkCallCaptureToEvent(s.client, CAPTURE, env({ ...ON, TEAM_CALL_EVENT_LINK: '' }))).toBe('off')
    expect(s.rpcs).toEqual([])
  })

  it('asks 656 once for the capture and passes its answer on', async () => {
    for (const answer of ['linked', 'already', 'no_meeting', 'not_host', 'no_event', 'taken']) {
      const s = svc({ data: answer, error: null })
      expect(await linkCallCaptureToEvent(s.client, CAPTURE, env(ON))).toBe(answer)
      expect(s.rpcs).toEqual([['team_call_capture_link_event', { target_capture: CAPTURE }]])
    }
  })

  it('a failure is logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = svc({ data: null, error: { message: 'lock timeout' } })
    expect(await linkCallCaptureToEvent(s.client, CAPTURE, env(ON))).toBe('error')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
