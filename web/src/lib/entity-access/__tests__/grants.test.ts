/**
 * The TypeScript mirror of has_entity_grant (../grants.ts), arm by arm, on
 * the same cases the SQL was proven on DEV with (migration-492-493.test.ts
 * holds the SQL's shape): a member grant, a team grant (only a team of the
 * record's workspace that the reader is in), a channel grant (only a channel
 * of that workspace the reader can read: an open one, their team's, their
 * DM), and never a grant from another workspace. Then the fences that use
 * it: a granted private document or capture is mentionable, and a granted
 * capture's decisions pass the decision fence. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn() }))

import { grantedEntityIds, withGrantedIds } from '../grants'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_WS = 'aaaaaaaa-0000-4000-8000-000000000002'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a' // the owner (user ids)
const BEN = 'uuuuuuuu-0000-4000-8000-00000000000b' // the reader
const ANA_M = 'mmmmmmmm-0000-4000-8000-00000000000a'
const BEN_M = 'mmmmmmmm-0000-4000-8000-00000000000b'
const BEN_M2 = 'mmmmmmmm-0000-4000-8000-0000000000b2' // Ben's member row in the other workspace
const DESIGN = 'tttttttt-0000-4000-8000-000000000001' // Ben is in it
const SALES = 'tttttttt-0000-4000-8000-000000000002' // Ben isn't
const ELSEWHERE_TEAM = 'tttttttt-0000-4000-8000-000000000003' // another workspace's, Ben in it

type Grant = { entity_id: string; grantee_kind: string; grantee_member_id?: string; grantee_team_id?: string; grantee_channel_id?: string; workspace_id?: string; entity_type?: string }

function db(grants: Grant[]) {
  return memoryDb({
    member: [
      { id: ANA_M, user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN_M, user_id: BEN, workspace_id: WS, display_name: 'Ben Okafor' },
      { id: BEN_M2, user_id: BEN, workspace_id: OTHER_WS, display_name: 'Ben Okafor' },
    ],
    team: [
      { id: DESIGN, workspace_id: WS, name: 'Design' },
      { id: SALES, workspace_id: WS, name: 'Sales' },
      { id: ELSEWHERE_TEAM, workspace_id: OTHER_WS, name: 'Elsewhere' },
    ],
    team_member: [
      { team_id: DESIGN, member_id: BEN_M },
      { team_id: SALES, member_id: ANA_M },
      { team_id: ELSEWHERE_TEAM, member_id: BEN_M2 },
    ],
    team_chat_channel: [
      { id: 'ch-open', workspace_id: WS, team_id: null, kind: 'channel', name: 'general' },
      { id: 'ch-design', workspace_id: WS, team_id: DESIGN, kind: 'channel', name: 'design' },
      { id: 'ch-sales', workspace_id: WS, team_id: SALES, kind: 'channel', name: 'sales' },
      { id: 'ch-dm-ab', workspace_id: WS, team_id: null, kind: 'dm', name: null },
      { id: 'ch-foreign', workspace_id: OTHER_WS, team_id: null, kind: 'channel', name: 'elsewhere' },
    ],
    team_chat_member: [
      { channel_id: 'ch-dm-ab', member_id: ANA_M, workspace_id: WS },
      { channel_id: 'ch-dm-ab', member_id: BEN_M, workspace_id: WS },
    ],
    document: [
      { id: 'doc-ws', workspace_id: WS, visibility: 'workspace', created_by: ANA_M, title: 'Team handbook' },
      { id: 'doc-ana', workspace_id: WS, visibility: 'private', created_by: ANA_M, title: 'Q3 pricing' },
      { id: 'doc-ana-2', workspace_id: WS, visibility: 'private', created_by: ANA_M, title: 'Hiring plan' },
    ],
    captures: [
      { id: 'cap-ana', workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: false, title: 'Fernhill call' },
      { id: 'cap-eval', workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: true, title: 'Mock call' },
    ],
    decision: [{ id: 'dec-ana', capture_id: 'cap-ana', confirmation: 'suggested', content: 'Raise prices' }],
    entity_access: grants.map((g, i) => ({
      id: `grant-${i}`,
      workspace_id: g.workspace_id ?? WS,
      entity_type: g.entity_type ?? 'document',
      grantee_member_id: null,
      grantee_team_id: null,
      grantee_channel_id: null,
      ...g,
    })),
  })
}

const granted = async (grants: Grant[], user: string | null = BEN, ids = ['doc-ana']) =>
  [...(await grantedEntityIds(db(grants), { userId: user, workspaceId: WS }, 'document', ids))].sort()

describe('grantedEntityIds: has_entity_grant for an explicit user', () => {
  it('no grant, no access', async () => {
    expect(await granted([])).toEqual([])
  })

  it('a member grant reaches that member only', async () => {
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: BEN_M }])).toEqual(['doc-ana'])
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: ANA_M }])).toEqual([])
  })

  it('a team grant reaches the team’s members, never another workspace’s team', async () => {
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'team', grantee_team_id: DESIGN }])).toEqual(['doc-ana'])
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'team', grantee_team_id: SALES }])).toEqual([])
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'team', grantee_team_id: ELSEWHERE_TEAM }])).toEqual([])
  })

  it('a channel grant reaches whoever can read the channel', async () => {
    const via = (ch: string) => granted([{ entity_id: 'doc-ana', grantee_kind: 'channel', grantee_channel_id: ch }])
    expect(await via('ch-open')).toEqual(['doc-ana'])
    expect(await via('ch-design')).toEqual(['doc-ana'])
    expect(await via('ch-dm-ab')).toEqual(['doc-ana'])
    expect(await via('ch-sales')).toEqual([])
    expect(await via('ch-foreign')).toEqual([])
  })

  it('a grant filed under another workspace never applies', async () => {
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: BEN_M2, workspace_id: OTHER_WS }])).toEqual([])
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: BEN_M, workspace_id: OTHER_WS }])).toEqual([])
    // Ben's member row in the other workspace, named in this one's grant (the trigger refuses it; the mirror ignores it).
    expect(await granted([{ entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: BEN_M2 }])).toEqual([])
  })

  it('only the kind asked about, and only the ids asked about', async () => {
    const g: Grant[] = [
      { entity_id: 'doc-ana', grantee_kind: 'member', grantee_member_id: BEN_M },
      { entity_id: 'doc-ana-2', grantee_kind: 'member', grantee_member_id: BEN_M, entity_type: 'capture' },
    ]
    expect(await granted(g, BEN, ['doc-ana', 'doc-ana-2'])).toEqual(['doc-ana'])
  })

  it('fails closed: no user, a non-member, a read error', async () => {
    const g: Grant[] = [{ entity_id: 'doc-ana', grantee_kind: 'channel', grantee_channel_id: 'ch-open' }]
    expect(await granted(g, null)).toEqual([])
    expect(await granted(g, 'uuuuuuuu-0000-4000-8000-0000000000ff')).toEqual([])
    const broken = {
      from: () => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'maybeSingle']) q[m] = () => q
        q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } })
        return q
      },
    } as never
    expect([...(await grantedEntityIds(broken, { userId: BEN, workspaceId: WS }, 'document', ['doc-ana']))]).toEqual([])
  })
})

describe('withGrantedIds', () => {
  it('adds a granted row of the workspace, never an eval capture', async () => {
    const client = db([
      { entity_id: 'cap-ana', grantee_kind: 'member', grantee_member_id: BEN_M, entity_type: 'capture' },
      { entity_id: 'cap-eval', grantee_kind: 'member', grantee_member_id: BEN_M, entity_type: 'capture' },
    ])
    const out = await withGrantedIds(client, { userId: BEN, workspaceId: WS }, 'capture', ['cap-ana', 'cap-eval'], [])
    expect([...out]).toEqual(['cap-ana'])
  })

  it('without a user it changes nothing', async () => {
    const client = db([{ entity_id: 'doc-ana', grantee_kind: 'channel', grantee_channel_id: 'ch-open' }])
    expect([...(await withGrantedIds(client, { userId: null, workspaceId: WS }, 'document', ['doc-ana'], ['doc-ws']))]).toEqual(['doc-ws'])
  })
})

describe('the fences that use it', () => {
  it('a granted private document is mentionable, an ungranted one is not', async () => {
    const client = db([{ entity_id: 'doc-ana', grantee_kind: 'channel', grantee_channel_id: 'ch-design' }])
    const refs = [
      { type: 'document' as const, id: 'doc-ana' },
      { type: 'document' as const, id: 'doc-ana-2' },
      { type: 'document' as const, id: 'doc-ws' },
    ]
    const out = await visibleMentionTargets(client, { workspaceId: WS, userId: BEN }, refs)
    expect(out.map((r) => r.id).sort()).toEqual(['doc-ana', 'doc-ws'])
    // Unattended (no user): only the workspace one.
    expect((await visibleMentionTargets(client, { workspaceId: WS, userId: null }, refs)).map((r) => r.id)).toEqual(['doc-ws'])
  })

  it('a granted capture’s decisions pass the decision fence; revoked, they don’t', async () => {
    const withGrant = db([{ entity_id: 'cap-ana', grantee_kind: 'member', grantee_member_id: BEN_M, entity_type: 'capture' }])
    expect([...(await visiblePrivateKindIds(withGrant, 'decision', BEN, ['dec-ana'], WS))]).toEqual(['dec-ana'])
    expect([...(await visiblePrivateKindIds(db([]), 'decision', BEN, ['dec-ana'], WS))]).toEqual([])
  })
})
