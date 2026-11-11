/**
 * LiveKit's webhooks for a meeting guest (phase 7, src/lib/team-calls/
 * webhook.ts): a guest identity (`guest-<id>`) is never handed to 565's
 * member rules (whose "refuse a join without access" would eject every
 * guest); its joins and leaves go to 574's meeting_guest_event, a refused
 * one is taken out at once, and its microphone's notes file is claimed for
 * the guest. A member's events are as they were.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { applyTeamCallWebhook } from '../webhook'
import type { TeamCallEgressPort } from '../egress'

const CALL = '33333333-3333-4333-8333-333333333333'
const ROOM = `tc-${CALL}`
const GUEST = '55555555-5555-4555-8555-555555555555'
const MEMBER = '44444444-4444-4444-8444-444444444444'

let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let answers: Record<string, { data: unknown; error: unknown }>
let svc: SupabaseClient

beforeEach(() => {
  tables = { team_call_webhook_event: [], team_call: [{ id: CALL, room: ROOM, status: 'live', notes: true }] }
  rpcs = []
  answers = {}
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      return answers[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
})

const joined = (identity: string, id = 'EV1') => ({ id, event: 'participant_joined', createdAt: 1762850000, room: { name: ROOM }, participant: { identity, sid: 'PA_1', joinedAtMs: 1762850000123 } })

describe('a guest’s join and leave', () => {
  it('go to 574’s meeting_guest_event, never 565’s member event', async () => {
    answers.meeting_guest_event = { data: 'joined', error: null }
    expect(await applyTeamCallWebhook(svc, joined(`guest-${GUEST}`))).toBe('joined')
    expect(rpcs.map((r) => r[0])).toEqual(['meeting_guest_event'])
    expect(rpcs[0][1]).toMatchObject({ room_name: ROOM, guest_ref: GUEST, session_ref: 'PA_1', is_join: true, session_joined_at: new Date(1762850000123).toISOString() })
    answers.meeting_guest_event = { data: 'left', error: null }
    expect(await applyTeamCallWebhook(svc, { ...joined(`guest-${GUEST}`, 'EV2'), event: 'participant_left' })).toBe('left')
    expect(rpcs[1][1]).toMatchObject({ is_join: false })
  })

  it('one not let in (removed, declined, an old token) is refused and taken out at once', async () => {
    answers.meeting_guest_event = { data: 'ejected', error: null }
    const drainEjections = vi.fn(async () => undefined)
    expect(await applyTeamCallWebhook(svc, joined(`guest-${GUEST}`), { drainEjections })).toBe('ejected')
    expect(drainEjections).toHaveBeenCalledTimes(1)
  })

  it('a member’s join is 565’s as ever; an identity that is neither is ignored', async () => {
    answers.team_call_participant_event = { data: 'joined', error: null }
    expect(await applyTeamCallWebhook(svc, joined(MEMBER))).toBe('joined')
    expect(rpcs.map((r) => r[0])).toEqual(['team_call_participant_event'])
    expect(await applyTeamCallWebhook(svc, joined('guest-nope', 'EV3'))).toBe('ignored')
    expect(await applyTeamCallWebhook(svc, joined('agent-bot', 'EV4'))).toBe('ignored')
    expect(rpcs).toHaveLength(1)
  })
})

describe('a guest’s microphone while notes are on', () => {
  it('starts a notes file claimed for the guest', async () => {
    answers.meeting_guest_egress_claim = { data: [{ egress_row: 'row-g', file_path: 'a/b/notes/row-g.ogg' }], error: null }
    const egress: TeamCallEgressPort = {
      startTrack: async () => ({ egressId: 'EG_g' }),
      startRecording: async () => ({ egressId: 'x' }),
      stop: async () => undefined,
      list: async () => [],
      microphones: async () => [],
    }
    const outcome = await applyTeamCallWebhook(
      svc,
      { id: 'EV5', event: 'track_published', room: { name: ROOM }, participant: { identity: `guest-${GUEST}` }, track: { sid: 'TR_g', type: 0, source: 2 } },
      { egress },
    )
    expect(outcome).toBe('notes_started')
    expect(rpcs.find((r) => r[0] === 'meeting_guest_egress_claim')?.[1]).toEqual({ target_call: CALL, guest_ref: GUEST, track_ref: 'TR_g' })
    expect(rpcs.some((r) => r[0] === 'team_call_egress_claim')).toBe(false)
  })
})
