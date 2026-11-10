/**
 * The share dialog's reads and writes (../store.ts): a record's grants with
 * their grantees' names, whether the viewer may share it and whether it is
 * restricted; adding one (the database's refusals said in words); removing
 * one. RLS decides who sees and does what (proven on DEV); this pins what the
 * dialog is told. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { addEntityGrant, loadEntityAccess, removeEntityGrant } from '../store'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA_M = 'mmmmmmmm-0000-4000-8000-00000000000a'
const BEN_M = 'mmmmmmmm-0000-4000-8000-00000000000b'
const TEAM = 'tttttttt-0000-4000-8000-000000000001'

function db(canShare = true) {
  const tables = {
    member: [
      { id: ANA_M, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN_M, workspace_id: WS, display_name: 'Ben Okafor' },
    ],
    team: [{ id: TEAM, workspace_id: WS, name: 'Design' }],
    team_chat_channel: [
      { id: 'ch-launch', workspace_id: WS, kind: 'channel', name: 'launch', dm_key: null },
      { id: 'ch-dm', workspace_id: WS, kind: 'dm', name: null, dm_key: `${ANA_M}:${BEN_M}` },
    ],
    document: [
      { id: 'doc-private', workspace_id: WS, visibility: 'private' },
      { id: 'doc-open', workspace_id: WS, visibility: 'workspace' },
    ],
    contact: [] as Array<Record<string, unknown>>,
    company: [{ id: 'co-1', workspace_id: WS }],
    entity_access: [
      { id: 'g-1', workspace_id: WS, entity_type: 'document', entity_id: 'doc-private', grantee_kind: 'member', grantee_member_id: BEN_M, source: 'manual', created_at: '2026-11-01T00:00:00Z' },
      { id: 'g-2', workspace_id: WS, entity_type: 'document', entity_id: 'doc-private', grantee_kind: 'team', grantee_team_id: TEAM, source: 'manual', created_at: '2026-11-02T00:00:00Z' },
      { id: 'g-3', workspace_id: WS, entity_type: 'document', entity_id: 'doc-private', grantee_kind: 'channel', grantee_channel_id: 'ch-launch', source: 'mention', created_at: '2026-11-03T00:00:00Z' },
      { id: 'g-4', workspace_id: WS, entity_type: 'document', entity_id: 'doc-private', grantee_kind: 'channel', grantee_channel_id: 'ch-dm', source: 'channel_share', created_at: '2026-11-04T00:00:00Z' },
    ] as Array<Record<string, unknown>>,
  }
  const client = memoryDb(tables, {
    entity_access: (a, b) => a.entity_id === b.entity_id && a.grantee_kind === b.grantee_kind && (a.grantee_member_id ?? a.grantee_team_id ?? a.grantee_channel_id) === (b.grantee_member_id ?? b.grantee_team_id ?? b.grantee_channel_id),
  }) as SupabaseClient & { rpc: unknown }
  Object.assign(client, { rpc: async (name: string) => ({ data: name === 'entity_access_can_share' ? canShare : null, error: null }) })
  return { client, tables }
}

describe('loadEntityAccess', () => {
  it('names every grantee: a member, a team, a channel, a DM by its other person', async () => {
    const { client } = db()
    const access = await loadEntityAccess(client, { workspaceId: WS, memberId: ANA_M }, 'document', 'doc-private')
    expect(access?.can_share).toBe(true)
    expect(access?.restricted).toBe(true)
    expect(access?.grants.map((g) => [g.grantee_kind, g.grantee_name, g.source])).toEqual([
      ['member', 'Ben Okafor', 'manual'],
      ['team', 'Design', 'manual'],
      ['channel', '#launch', 'mention'],
      ['channel', 'Ben Okafor (direct message)', 'channel_share'],
    ])
  })

  it('a workspace document is not restricted; one the viewer can’t read is null', async () => {
    const { client } = db(false)
    expect(await loadEntityAccess(client, { workspaceId: WS, memberId: ANA_M }, 'document', 'doc-open')).toEqual({ can_share: false, restricted: false, grants: [] })
    expect(await loadEntityAccess(client, { workspaceId: WS, memberId: ANA_M }, 'document', 'doc-gone')).toBeNull()
  })

  it('a company with no workspace-wide contact is restricted', async () => {
    const { client, tables } = db()
    expect((await loadEntityAccess(client, { workspaceId: WS, memberId: ANA_M }, 'company', 'co-1'))?.restricted).toBe(true)
    tables.contact.push({ id: 'ct-1', workspace_id: WS, company_id: 'co-1', visibility: 'workspace', merged_into_contact_id: null })
    expect((await loadEntityAccess(client, { workspaceId: WS, memberId: ANA_M }, 'company', 'co-1'))?.restricted).toBe(false)
  })
})

describe('addEntityGrant and removeEntityGrant', () => {
  it('adds a manual view grant as the person', async () => {
    const { client, tables } = db()
    const out = await addEntityGrant(client, { workspaceId: WS, memberId: ANA_M }, 'document', 'doc-open', { kind: 'team', id: TEAM })
    expect('id' in out).toBe(true)
    expect(tables.entity_access.at(-1)).toMatchObject({ entity_id: 'doc-open', grantee_kind: 'team', grantee_team_id: TEAM, level: 'view', granted_by: ANA_M, source: 'manual' })
  })

  it('says the refusals in words', async () => {
    const { client } = db()
    expect(await addEntityGrant(client, { workspaceId: WS, memberId: ANA_M }, 'document', 'doc-private', { kind: 'member', id: BEN_M })).toEqual({ error: 'exists', message: 'They already have access' })
    const refusing = {
      from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'rls', code: '42501' } }) }) }) }),
    } as never
    expect(await addEntityGrant(refusing, { workspaceId: WS, memberId: BEN_M }, 'document', 'doc-private', { kind: 'member', id: BEN_M })).toEqual({ error: 'forbidden', message: "You can't share this" })
  })

  it('removes one grant, and answers false when none was removed', async () => {
    const { client, tables } = db()
    expect(await removeEntityGrant(client, WS, 'g-1')).toBe(true)
    expect(tables.entity_access.map((g) => g.id)).toEqual(['g-2', 'g-3', 'g-4'])
    expect(await removeEntityGrant(client, WS, 'g-1')).toBe(false)
  })
})
