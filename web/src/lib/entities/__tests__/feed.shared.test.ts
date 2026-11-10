/**
 * "Ana shared Q3 plan with you" in the Inbox (FU-E, migration 513). A new
 * grant is a 'shared' activity row on the record, its subject the member it
 * was shared with (a grant to one member). The Inbox (shared=me) lists it
 * for that member alone; a share to a team or channel (no subject) is in the
 * record's History only; a record the viewer can no longer read (the grant
 * was removed) never shows; their own sharing never lands in their Inbox.
 * Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { loadFeed } from '../feed'
import {
  EMPTY_FEED_FILTER,
  describeFeedEvent,
  feedQuery,
  isInboxFilter,
  parseFeedQuery,
  sharedWithYouLine,
  type FeedEvent,
  type FeedFilter,
  type FeedResponse,
} from '../feed-model'
import { paletteInboxUrl } from '@/app/account/(dashboard)/chat/use-palette-feed'

const WS = '11111111-1111-4111-8111-111111111111'
const U_BEN = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA = 'bbbbbbbb-0000-4000-8000-000000000001'
const BEN = 'bbbbbbbb-0000-4000-8000-000000000002'
const OMAR = 'bbbbbbbb-0000-4000-8000-000000000003'
const DOC = 'c0000000-0000-4000-8000-000000000001'
const CO = 'c0000000-0000-4000-8000-000000000002'
const GONE = 'c0000000-0000-4000-8000-0000000000ff'
const MINE = 'c0000000-0000-4000-8000-000000000003'

let seq = 0
function act(at: string, entity_type: string, entity_id: string, extra: Record<string, unknown> = {}) {
  seq += 1
  return {
    id: `0000${String(seq).padStart(4, '0')}-0000-4000-8000-${at.replace(/\D/g, '').slice(0, 12)}`,
    workspace_id: WS,
    entity_type,
    entity_id,
    action: 'shared',
    actor_kind: 'member',
    actor_member_id: ANA,
    subject_member_id: BEN,
    detail: { level: 'view', grantee_kind: 'member', source: 'manual' },
    backfilled: false,
    created_at: at,
    ...extra,
  }
}

/** Ben's RLS view: Ana's private doc and the company were shared with him; GONE's grant was removed. */
function db(): SupabaseClient {
  seq = 0
  return memoryDb({
    member: [
      { id: ANA, user_id: 'aaaaaaaa-0000-4000-8000-0000000000aa', workspace_id: WS, display_name: 'Ana Reyes' },
      { id: BEN, user_id: U_BEN, workspace_id: WS, display_name: 'Ben Ortiz' },
      { id: OMAR, user_id: 'aaaaaaaa-0000-4000-8000-0000000000cc', workspace_id: WS, display_name: 'Omar Haddad' },
    ],
    document: [
      { id: DOC, workspace_id: WS, title: 'Q3 pricing plan' },
      { id: MINE, workspace_id: WS, title: 'Ben’s notes' },
    ],
    company: [{ id: CO, workspace_id: WS, name: 'Northwind Traders' }],
    captures: [],
    entity_activity: [
      act('2026-11-10T08:00:00.000000+00:00', 'document', DOC),
      act('2026-11-10T09:00:00.000000+00:00', 'company', CO, { detail: { level: 'edit', grantee_kind: 'member', source: 'manual' } }),
      // Shared with Omar, not Ben: not Ben's Inbox.
      act('2026-11-10T09:30:00.000000+00:00', 'document', DOC, { subject_member_id: OMAR }),
      // Shared with a team: no subject, History only.
      act('2026-11-10T09:45:00.000000+00:00', 'document', DOC, { subject_member_id: null, detail: { level: 'view', grantee_kind: 'team', source: 'manual' } }),
      // Ben can no longer read it (the grant was removed): never shown.
      act('2026-11-10T10:00:00.000000+00:00', 'document', GONE),
      // Ben's own sharing never lands in his Inbox.
      act('2026-11-10T10:30:00.000000+00:00', 'document', MINE, { actor_member_id: BEN, subject_member_id: OMAR }),
    ],
  })
}

const viewer = { workspaceId: WS, userId: U_BEN, memberId: BEN }
const run = (f: Partial<FeedFilter>) => loadFeed(db(), viewer, { ...EMPTY_FEED_FILTER, ...f }) as Promise<FeedResponse>

describe('the Inbox: shared with you', () => {
  it('lists what was shared with the viewer alone, newest first, with who and how', async () => {
    const feed = await run({ sharedWithMe: true })
    expect(feed.entries?.map((e) => [e.type, e.id, e.label, describeFeedEvent(e.last), sharedWithYouLine(e.last)])).toEqual([
      ['company', CO, 'Northwind Traders', 'Shared with you to edit', 'Ana Reyes shared this with you to edit'],
      ['document', DOC, 'Q3 pricing plan', 'Shared with you', 'Ana Reyes shared this with you'],
    ])
    expect(JSON.stringify(feed)).not.toContain(GONE)
    expect(JSON.stringify(feed)).not.toContain(MINE)
  })

  it('rides with the rest of the Inbox, and not without asking for it', async () => {
    expect((await run({ assignedToMe: true, mentionedMe: true, sharedWithMe: true })).entries?.map((e) => e.id)).toEqual([CO, DOC])
    expect((await run({ assignedToMe: true, mentionedMe: true })).entries).toEqual([])
  })

  it('a record’s History says every share, to a person or a team', async () => {
    const feed = await run({ entity: { type: 'document', id: DOC }, group: 'none' })
    expect(feed.events?.map((e) => describeFeedEvent(e))).toEqual(['Shared', 'Shared with Omar Haddad', 'Shared with you'])
  })
})

describe('the filter and the words', () => {
  it('reads and writes shared=me, and it makes an Inbox', () => {
    const f = parseFeedQuery(new URLSearchParams({ shared: 'me' }))
    expect(f).toMatchObject({ sharedWithMe: true })
    expect('error' in parseFeedQuery(new URLSearchParams({ shared: 'ana' }))).toBe(true)
    expect(feedQuery({ sharedWithMe: true })).toBe('shared=me')
    expect(isInboxFilter({ ...EMPTY_FEED_FILTER, sharedWithMe: true })).toBe(true)
    expect(isInboxFilter(EMPTY_FEED_FILTER)).toBe(false)
  })

  it('the palette’s Inbox asks for shares too', () => {
    expect(paletteInboxUrl(new Date('2026-11-10T00:00:00Z'))).toContain('shared=me')
  })

  it('the line is only for a share to the viewer', () => {
    const e: FeedEvent = {
      id: 'e',
      action: 'shared',
      at: '2026-11-10T00:00:00Z',
      actor: { kind: 'agent', member_id: ANA, name: 'Ana Reyes', me: false },
      subject: { member_id: BEN, name: 'Ben Ortiz', me: true },
      from: null,
      to: 'view',
      relation: null,
      other: null,
    }
    expect(sharedWithYouLine(e)).toBe("Ana Reyes's agent shared this with you")
    expect(sharedWithYouLine({ ...e, subject: { member_id: OMAR, name: 'Omar Haddad', me: false } })).toBeNull()
    expect(sharedWithYouLine({ ...e, action: 'mentioned' })).toBeNull()
  })
})
