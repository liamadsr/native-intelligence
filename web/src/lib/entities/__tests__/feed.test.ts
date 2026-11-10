/**
 * The cross-kind feed (src/lib/entities/feed.ts) over the activity log. The
 * fake database is the viewer's RLS view, as the session client sees it: the
 * log's own RLS (workspace member) lets every row of the workspace through,
 * and a record RLS hides (another member's private document or capture) is
 * simply not in its table. Team chat is in the view whole, so the private-
 * kind fence (hiddenPrivateRefs) is what has to hide a DM the viewer isn't in.
 *
 * The property under test: a row about a record the viewer can't read never
 * comes back, nor its label or id, whatever the filter. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { loadFeed, otherRef } from '../feed'
import { EMPTY_FEED_FILTER, describeFeedEvent, mergeFeedEntries, parseFeedQuery, type FeedFilter, type FeedResponse } from '../feed-model'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const U_ANA = 'aaaaaaaa-0000-4000-8000-000000000001'
const U_MAYA = 'aaaaaaaa-0000-4000-8000-000000000002'
const ANA = 'bbbbbbbb-0000-4000-8000-000000000001'
const MAYA = 'bbbbbbbb-0000-4000-8000-000000000002'
const OMAR = 'bbbbbbbb-0000-4000-8000-000000000003'

const TASK = 'a0000000-0000-4000-8000-000000000001'
const OWN_TASK = 'a0000000-0000-4000-8000-000000000002'
const DOC = 'c0000000-0000-4000-8000-000000000001'
const PRIVATE_DOC = 'c0000000-0000-4000-8000-0000000000ff'
const PRIVATE_CAPTURE = 'e0000000-0000-4000-8000-0000000000ff'
const MSG = 'f1000000-0000-4000-8000-000000000001'
const DM_MSG = 'f1000000-0000-4000-8000-0000000000ff'
const CH = 'f0000000-0000-4000-8000-000000000001'
const DM = 'f0000000-0000-4000-8000-0000000000ff'
const TEAM = '99999999-0000-4000-8000-000000000001'
const IN_PROGRESS = '77777777-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
let seq = 0
/** A log row; ids grow with time so the fake's one sort key (id) is time order too. */
function act(at: string, entity_type: string, entity_id: string, action: string, extra: Row = {}): Row {
  seq += 1
  return {
    id: `0000${String(seq).padStart(4, '0')}-0000-4000-8000-${at.replace(/\D/g, '').slice(0, 12)}`,
    workspace_id: WS,
    entity_type,
    entity_id,
    action,
    actor_kind: 'member',
    actor_member_id: MAYA,
    subject_member_id: null,
    detail: {},
    created_at: at,
    ...extra,
  }
}

function db(): SupabaseClient {
  seq = 0
  return memoryDb({
    member: [
      { id: ANA, user_id: U_ANA, workspace_id: WS, display_name: 'Ana Reyes' },
      { id: MAYA, user_id: U_MAYA, workspace_id: WS, display_name: 'Maya Chen' },
      { id: OMAR, user_id: 'aaaaaaaa-0000-4000-8000-000000000003', workspace_id: WS, display_name: 'Omar Haddad' },
    ],
    actions: [
      { id: TASK, workspace_id: WS, title: 'Send the Fernhill quote' },
      { id: OWN_TASK, workspace_id: WS, title: 'Water the plants' },
    ],
    document: [{ id: DOC, workspace_id: WS, title: 'Q4 renewals plan' }],
    // PRIVATE_DOC and PRIVATE_CAPTURE are another member's: RLS keeps them out of this view.
    captures: [],
    team_chat_channel: [
      { id: CH, workspace_id: WS, team_id: TEAM, kind: 'channel', name: 'launch' },
      { id: DM, workspace_id: WS, team_id: null, kind: 'dm', name: null },
    ],
    team_member: [{ team_id: TEAM, member_id: ANA }],
    team_chat_member: [
      { channel_id: DM, member_id: MAYA },
      { channel_id: DM, member_id: OMAR },
    ],
    team_chat_message: [
      { id: MSG, workspace_id: WS, channel_id: CH, body: 'Ana, can you take the Fernhill quote?' },
      { id: DM_MSG, workspace_id: WS, channel_id: DM, body: 'Between us: the budget is tight' },
    ],
    workflow_state: [{ id: IN_PROGRESS, name: 'In progress' }],
    entity_link: [
      { id: 'l1', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'action', target_id: TASK, relation: 'related_to' },
    ],
    entity_activity: [
      act('2026-11-09T08:00:00.000000+00:00', 'document', DOC, 'created', { actor_member_id: ANA }),
      act('2026-11-09T08:30:00.000000+00:00', 'capture', PRIVATE_CAPTURE, 'created'),
      act('2026-11-09T09:00:00.000000+00:00', 'document', PRIVATE_DOC, 'renamed'),
      act('2026-11-09T09:30:00.000000+00:00', 'action', TASK, 'mentioned', { detail: { source_type: 'document', source_id: PRIVATE_DOC } }),
      act('2026-11-09T10:00:00.000000+00:00', 'action', TASK, 'status_changed', { actor_member_id: ANA, detail: { from: null, to: IN_PROGRESS } }),
      act('2026-11-09T10:30:00.000000+00:00', 'team_chat_message', DM_MSG, 'mentioned', { actor_member_id: OMAR, subject_member_id: MAYA, detail: { channel_id: DM } }),
      act('2026-11-09T11:00:00.000000+00:00', 'action', OWN_TASK, 'assigned', { actor_member_id: ANA, subject_member_id: ANA, detail: { to: ANA } }),
      act('2026-11-09T11:30:00.000000+00:00', 'team_chat_message', MSG, 'mentioned', { subject_member_id: ANA, detail: { channel_id: CH } }),
      act('2026-11-09T12:00:00.000000+00:00', 'action', TASK, 'assigned', { subject_member_id: ANA, detail: { from: null, to: ANA } }),
      act('2026-11-09T12:30:00.000000+00:00', 'action', TASK, 'commented', { workspace_id: OTHER_WS }),
    ],
  })
}

const viewer = { workspaceId: WS, userId: U_ANA, memberId: ANA }
const run = (supabase: SupabaseClient, f: Partial<FeedFilter>) => loadFeed(supabase, viewer, { ...EMPTY_FEED_FILTER, ...f }) as Promise<FeedResponse>
const NEVER = [PRIVATE_DOC, PRIVATE_CAPTURE, DM_MSG, 'Between us', OTHER_WS]
const expectNothingPrivate = (body: unknown) => {
  const raw = JSON.stringify(body)
  for (const s of NEVER) expect(raw).not.toContain(s)
}

describe('the Inbox (mentioned / assigned to me)', () => {
  it('lists what was assigned to the viewer and where they were mentioned, newest first, never their own doing', async () => {
    const feed = await run(db(), { assignedToMe: true, mentionedMe: true })
    expect(feed.entries?.map((e) => [e.type, e.id, e.label, describeFeedEvent(e.last), e.context])).toEqual([
      ['action', TASK, 'Send the Fernhill quote', 'Assigned to you', null],
      ['team_chat_message', MSG, 'Ana, can you take the Fernhill quote?', 'Mentioned you', '#launch'],
    ])
    expect(feed.entries?.[0].last.actor).toEqual({ kind: 'member', member_id: MAYA, name: 'Maya Chen', me: false })
    expectNothingPrivate(feed)
  })

  it('narrows to one filter', async () => {
    const assigned = await run(db(), { assignedToMe: true })
    expect(assigned.entries?.map((e) => e.id)).toEqual([TASK])
    const mentioned = await run(db(), { mentionedMe: true })
    expect(mentioned.entries?.map((e) => e.id)).toEqual([MSG])
  })
})

describe('Recent (what I touched)', () => {
  it('is the viewer’s own doing, one row per record, its newest event', async () => {
    const feed = await run(db(), { actor: 'me' })
    expect(feed.entries?.map((e) => [e.id, describeFeedEvent(e.last), e.last.actor.me])).toEqual([
      [OWN_TASK, 'Assigned to you', true],
      [TASK, 'Moved to In progress', true],
      [DOC, 'Created', true],
    ])
  })
})

describe('the workspace feed', () => {
  it('drops every row about a record the viewer can’t read, and a mention from one', async () => {
    const feed = await run(db(), { group: 'none', limit: 50 })
    const shown = feed.events!.map((e) => `${e.type}:${e.action}`)
    expect(shown).toEqual([
      'action:assigned',
      'team_chat_message:mentioned',
      'action:assigned',
      'action:status_changed',
      'document:created',
    ])
    expectNothingPrivate(feed)
  })

  it('keeps to the workspace asked for', async () => {
    const feed = await run(db(), { group: 'none', limit: 50 })
    expect(feed.events!.some((e) => e.action === 'commented')).toBe(false)
  })

  it('narrows by kind', async () => {
    const feed = await run(db(), { kinds: ['document'] })
    expect(feed.entries?.map((e) => e.id)).toEqual([DOC])
  })
})

describe('a record’s History (entity=type:id)', () => {
  it('is that record’s events, newest first, without the mention from a private doc', async () => {
    const feed = await run(db(), { entity: { type: 'action', id: TASK }, group: 'none' })
    expect(feed.events!.map((e) => describeFeedEvent(e))).toEqual(['Assigned to you', 'Moved to In progress'])
    expectNothingPrivate(feed)
  })

  it('shows nothing of a record the viewer can’t read', async () => {
    const feed = await run(db(), { entity: { type: 'document', id: PRIVATE_DOC }, group: 'none' })
    expect(feed.events).toEqual([])
    const dm = await run(db(), { entity: { type: 'team_chat_message', id: DM_MSG }, group: 'none' })
    expect(dm.events).toEqual([])
  })

  it('pages with the cursor, never repeating or skipping a row', async () => {
    const supabase = db()
    const first = await run(supabase, { entity: { type: 'action', id: TASK }, group: 'none', limit: 1 })
    expect(first.events!.map((e) => e.action)).toEqual(['assigned'])
    expect(first.next_cursor).toBeTruthy()
    const cursor = parseFeedQuery(new URLSearchParams({ cursor: first.next_cursor! }))
    if ('error' in cursor) throw new Error(cursor.error)
    const second = await run(supabase, { entity: { type: 'action', id: TASK }, group: 'none', limit: 1, cursor: cursor.cursor })
    // The hidden mention between them is skipped, not shown.
    expect(second.events!.map((e) => e.action)).toEqual(['status_changed'])
  })
})

describe('linked_to', () => {
  it('is the activity on the records linked to one', async () => {
    const feed = await run(db(), { linkedTo: { type: 'document', id: DOC } })
    expect(feed.entries?.map((e) => [e.id, describeFeedEvent(e.last)])).toEqual([[TASK, 'Assigned to you']])
  })
})

describe('a member’s mention names no second record', () => {
  it('otherRef is null when the source is the row’s own record', () => {
    expect(otherRef({ action: 'mentioned', entity_type: 'document', entity_id: DOC, detail: { source_type: 'document', source_id: DOC } })).toBeNull()
    expect(otherRef({ action: 'mentioned', entity_type: 'action', entity_id: TASK, detail: { source_type: 'document', source_id: DOC } })).toEqual({ type: 'document', id: DOC })
    expect(otherRef({ action: 'renamed', entity_type: 'action', entity_id: TASK, detail: {} })).toBeNull()
  })
})

describe('parseFeedQuery', () => {
  const parse = (q: Record<string, string>) => parseFeedQuery(new URLSearchParams(q))

  it('reads the shared filter shape', () => {
    expect(parse({ kinds: 'action,document', assigned_to: 'me', mentioned: 'me', actor: 'agent', group: 'none', limit: '80', linked_to: `document:${DOC}` })).toMatchObject({
      kinds: ['action', 'document'],
      assignedToMe: true,
      mentionedMe: true,
      actor: 'agent',
      group: 'none',
      limit: 50,
      linkedTo: { type: 'document', id: DOC },
    })
  })

  it('refuses what it can’t read', () => {
    for (const q of <Array<Record<string, string>>>[
      { kinds: 'email' },
      { kinds: 'claim' },
      { assigned_to: 'maya' },
      { linked_to: 'document' },
      { entity: `email_draft:${DOC}` },
      { actor: 'someone' },
      { cursor: 'nope' },
      { group: 'kind' },
      { limit: '0' },
      { since: 'yesterday' },
    ]) {
      expect('error' in (parse(q) as object), JSON.stringify(q)).toBe(true)
    }
  })
})

describe('mergeFeedEntries', () => {
  it('keeps a record already shown where it is', async () => {
    const feed = await run(db(), { actor: 'me' })
    const [a, b, c] = feed.entries!
    expect(mergeFeedEntries([a, b], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id])
  })
})
