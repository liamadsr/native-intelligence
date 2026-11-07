/**
 * Getting started (docs/plans/getting-started-skill.md;
 * src/lib/onboarding/getting-started.ts), over a fake client.
 *
 * Pinned: who is getting started (through the wizard, onboarded under a
 * week ago, not finished), what the section says (who, the background-update
 * rule, where they are, the skill's steps), its reads (the person's own
 * captures since onboarding, real and not archived; their calendar; the skill
 * by its id), which turns hold it or have none, a failed read held, the
 * first-capture turn's test, and finishing (one merge for the token's own
 * member, a no-op once over).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import {
  GETTING_STARTED_SECTION_KEY,
  GETTING_STARTED_SKILL_ID,
  GETTING_STARTED_WINDOW_MS,
  finishGettingStarted,
  gettingStartedForChatSpec,
  gettingStartedFrom,
  isFirstRunCapture,
  renderGettingStartedSection,
  renderGettingStartedStatus,
} from '../getting-started'

const NOW = Date.parse('2026-10-27T18:00:00.000Z')
const COMPLETED = '2026-10-27T15:00:00.000Z'
const SEEDED = { research: { status: 'done', seededSummary: { projectName: 'Dial8 Launch', actionCount: 3 } } }

const db = {
  member: null as Record<string, unknown> | null,
  memberError: null as string | null,
  captures: [] as Array<Record<string, unknown>>,
  capturesError: null as string | null,
  calendars: 0,
  skill: 'You walk a person through Dial8 for the first time.' as string | null,
  rpcError: null as string | null,
  firstRunRefs: [] as string[],
}

const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
  if (q.table === 'member') return db.memberError ? { data: null, error: { message: db.memberError } } : { data: db.member, error: null }
  if (q.table === 'captures') {
    if (db.capturesError) return { data: null, error: { message: db.capturesError } }
    return { data: db.captures.slice(0, 1), error: null, count: db.captures.length } as FakeResult
  }
  if (q.table === 'connected_account') return { data: null, error: null, count: db.calendars } as FakeResult
  if (q.table === 'recipe') return { data: db.skill === null ? null : { system_prompt: db.skill }, error: null }
  if (q.table === 'rpc:merge_onboarding_progress') return db.rpcError ? { data: null, error: { message: db.rpcError } } : { data: {}, error: null }
  if (q.table === 'agent_event') return { data: db.firstRunRefs.map((ref_id) => ({ ref_id })), error: null }
  return { data: null, error: null }
})

const reads = (table: string) => fake.log.filter((q) => q.table === table)

beforeEach(() => {
  // Only Date: the reads still settle on real promises.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fake.log.length = 0
  db.member = { display_name: 'Liam', onboarding_completed_at: COMPLETED, onboarding_progress: SEEDED }
  db.memberError = null
  db.captures = []
  db.capturesError = null
  db.calendars = 0
  db.skill = 'You walk a person through Dial8 for the first time.'
  db.rpcError = null
  db.firstRunRefs = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('gettingStartedFrom', () => {
  it('is on from onboarding until a week later, with the starter project the researcher seeded', () => {
    expect(gettingStartedFrom(db.member, NOW)).toEqual({
      completedAt: COMPLETED,
      name: 'Liam',
      starter: { projectName: 'Dial8 Launch', actionCount: 3 },
    })
    const lastMoment = Date.parse(COMPLETED) + GETTING_STARTED_WINDOW_MS
    expect(gettingStartedFrom(db.member, lastMoment)).not.toBeNull()
    expect(gettingStartedFrom(db.member, lastMoment + 1)).toBeNull()
  })

  it('is off for someone who never went through the wizard: an invited teammate, another workspace', () => {
    expect(gettingStartedFrom({ ...db.member, onboarding_progress: {} }, NOW)).toBeNull()
    expect(gettingStartedFrom({ ...db.member, onboarding_progress: null }, NOW)).toBeNull()
  })

  it('is off once finished, before onboarding, and for no member', () => {
    expect(gettingStartedFrom({ ...db.member, onboarding_progress: { ...SEEDED, getting_started: { finished_at: COMPLETED, finished_by: 'done' } } }, NOW)).toBeNull()
    expect(gettingStartedFrom({ ...db.member, onboarding_completed_at: null }, NOW)).toBeNull()
    expect(gettingStartedFrom({ ...db.member, onboarding_completed_at: 'not a date' }, NOW)).toBeNull()
    expect(gettingStartedFrom(null, NOW)).toBeNull()
  })

  it('has no starter project when research seeded none, and cleans the name it shows', () => {
    const state = gettingStartedFrom({ display_name: 'Li​am <b>', onboarding_completed_at: COMPLETED, onboarding_progress: { research: { status: 'skipped' } } }, NOW)
    expect(state?.starter).toBeNull()
    expect(state?.name).toBe('Li am ‹b›')
  })
})

describe('the section', () => {
  const state = gettingStartedFrom({ display_name: 'Liam', onboarding_completed_at: COMPLETED, onboarding_progress: SEEDED }, NOW)!

  it('says where they are: the starter project, their captures, the calendar', () => {
    expect(renderGettingStartedStatus(state, { captures: { count: 0, latest: null }, calendarConnected: false })).toBe(
      'Where they are: starter project “Dial8 Launch” (3 first actions). Captures since signing up: none. Calendar: not connected.',
    )
    expect(renderGettingStartedStatus(state, { captures: { count: 1, latest: { id: 'cap-1', title: 'Talking to myself', recording: true } }, calendarConnected: true })).toBe(
      'Where they are: starter project “Dial8 Launch” (3 first actions). Captures since signing up: 1, “Talking to myself” [capture cap-1], recording now. Calendar: connected.',
    )
    expect(
      renderGettingStartedStatus({ ...state, starter: null }, { captures: { count: 2, latest: { id: 'cap-2', title: null, recording: false } }, calendarConnected: false }),
    ).toBe('Where they are: no starter project. Captures since signing up: 2, the latest “Untitled” [capture cap-2], recorded. Calendar: not connected.')
  })

  it('opens with who, names the finishing tool, keeps background updates to step 3, then carries the skill; no date', () => {
    const text = renderGettingStartedSection(state, { captures: { count: 0, latest: null }, calendarConnected: false }, { skillText: 'STEPS' })
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^Getting started: Liam is new to Dial8\. /)
    expect(lines[0]).toContain('call finish_getting_started')
    expect(lines[0]).toContain('On a background update only step 3 applies')
    expect(lines[0]).not.toMatch(/Oct \d/)
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^Where they are: /), '', 'STEPS'])
  })

  it('without the skill (migration 453 not applied) carries the status alone', () => {
    const text = renderGettingStartedSection(state, { captures: { count: 0, latest: null }, calendarConnected: false }, { skillText: null })
    expect(text.split('\n')).toHaveLength(2)
  })
})

describe('gettingStartedForChatSpec', () => {
  const args = { workspaceId: 'ws-1', userId: 'user-1' }

  it("sends the section for the token's own member, its captures since onboarding (real, not archived), its calendar and the skill by id", async () => {
    db.captures = [{ id: 'cap-1', title: 'Hello', ended_at: '2026-10-27T16:00:00Z' }]
    db.calendars = 1
    const out = await gettingStartedForChatSpec(fake.client, args)
    expect(out.held).toBe(false)
    expect(out.section?.key).toBe(GETTING_STARTED_SECTION_KEY)
    expect(out.section?.markdown).toContain('Captures since signing up: 1, “Hello” [capture cap-1], recorded. Calendar: connected.')
    expect(out.section?.markdown).toContain('You walk a person through Dial8 for the first time.')

    const [member] = reads('member')
    expect([eqValue(member, 'workspace_id'), eqValue(member, 'user_id')]).toEqual(['ws-1', 'user-1'])
    const [captures] = reads('captures')
    expect([eqValue(captures, 'workspace_id'), eqValue(captures, 'user_id'), eqValue(captures, 'is_eval')]).toEqual(['ws-1', 'user-1', false])
    expect(captures.filters).toEqual(
      expect.arrayContaining([
        ['gte', 'created_at', COMPLETED],
        ['is', 'metadata->>demo', null],
        ['neq', 'status', 'archived'],
      ]),
    )
    const [calendar] = reads('connected_account')
    expect([eqValue(calendar, 'user_id'), eqValue(calendar, 'capability'), eqValue(calendar, 'is_enabled')]).toEqual(['user-1', 'calendar', true])
    const [skill] = reads('recipe')
    expect([eqValue(skill, 'id'), eqValue(skill, 'category')]).toEqual([GETTING_STARTED_SKILL_ID, 'skill'])
  })

  it('no section and nothing else read when they are not getting started (an earlier one is cleared)', async () => {
    db.member = { ...db.member, onboarding_progress: { getting_started: { finished_at: COMPLETED } } }
    expect(await gettingStartedForChatSpec(fake.client, args)).toEqual({ section: null, held: false })
    expect(reads('captures')).toEqual([])
  })

  it('a guest has none, and a channel turn (a text, a Slack message) holds it, reading nothing', async () => {
    expect(await gettingStartedForChatSpec(fake.client, { ...args, guestId: 'g-1' })).toEqual({ section: null, held: false })
    expect(await gettingStartedForChatSpec(fake.client, { ...args, server: 'channel_turn' })).toEqual({ section: null, held: true })
    expect(fake.log).toEqual([])
  })

  it('a failed read holds the key rather than clearing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.memberError = 'timeout'
    expect(await gettingStartedForChatSpec(fake.client, args)).toEqual({ section: null, held: true })
    db.memberError = null
    db.capturesError = 'timeout'
    expect(await gettingStartedForChatSpec(fake.client, args)).toEqual({ section: null, held: true })
    warn.mockRestore()
  })
})

describe('isFirstRunCapture', () => {
  const args = { workspaceId: 'ws-1', userId: 'user-1', captureId: 'cap-1' }

  it("is the first capture while getting started: no other capture's firstRun event since onboarding", async () => {
    expect(await isFirstRunCapture(fake.client, args)).toBe(true)
    const [read] = reads('agent_event')
    expect([eqValue(read, 'workspace_id'), eqValue(read, 'user_id'), eqValue(read, 'kind'), eqValue(read, 'facts->>firstRun')]).toEqual(['ws-1', 'user-1', 'capture.processed', 'true'])
    expect(read.filters).toEqual(expect.arrayContaining([['gte', 'created_at', COMPLETED]]))
    // A re-fire of the same capture is still its first.
    db.firstRunRefs = ['cap-1']
    expect(await isFirstRunCapture(fake.client, args)).toBe(true)
  })

  it('is not once another capture had that turn, nor when not getting started, nor on a failed read', async () => {
    db.firstRunRefs = ['cap-0']
    expect(await isFirstRunCapture(fake.client, args)).toBe(false)
    db.firstRunRefs = []
    db.member = { ...db.member, onboarding_progress: { ...SEEDED, getting_started: { finished_at: COMPLETED } } }
    expect(await isFirstRunCapture(fake.client, args)).toBe(false)
    db.memberError = 'down'
    expect(await isFirstRunCapture(fake.client, args)).toBe(false)
  })
})

describe('finishGettingStarted', () => {
  it("merges getting_started into the token's own member's progress, naming the requester", async () => {
    const out = await finishGettingStarted(fake.client, { workspaceId: 'ws-1', userId: 'user-1', by: 'skipped', nowMs: NOW })
    expect(out).toEqual({ success: true, ended: true })
    const [rpc] = reads('rpc:merge_onboarding_progress')
    expect(rpc.payload).toEqual({
      p_workspace_id: 'ws-1',
      p_patch: { getting_started: { finished_at: '2026-10-27T18:00:00.000Z', finished_by: 'skipped' } },
      p_user_id: 'user-1',
    })
  })

  it('is a no-op once it is over, and says so when the write fails', async () => {
    db.member = { ...db.member, onboarding_completed_at: '2026-01-01T00:00:00Z' }
    expect(await finishGettingStarted(fake.client, { workspaceId: 'ws-1', userId: 'user-1', by: 'done' })).toEqual({ success: true, ended: false })
    expect(reads('rpc:merge_onboarding_progress')).toEqual([])
    db.member = { display_name: 'Liam', onboarding_completed_at: COMPLETED, onboarding_progress: SEEDED }
    db.rpcError = 'denied'
    expect(await finishGettingStarted(fake.client, { workspaceId: 'ws-1', userId: 'user-1', by: 'done' })).toEqual({ success: false, error: 'progress write failed: denied' })
  })
})
