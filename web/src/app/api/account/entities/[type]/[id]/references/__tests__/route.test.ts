/**
 * GET /api/account/entities/[type]/[id]/references — "Referenced in" on the
 * viewer's RLS client. The fake database below IS the viewer's RLS view: a row
 * RLS hides (another member's private doc, a DM they're not in) is simply not
 * in it. So: the entity must be readable (else 404); a source that isn't is
 * left out; claims and mail never show; several edges from one source are one
 * row; a message names its channel. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const DEAL = 'd0000000-0000-4000-8000-000000000001'
const HIDDEN_DEAL = 'd0000000-0000-4000-8000-0000000000ff'
const MSG = 'b0000000-0000-4000-8000-000000000001'
const DM_MSG_NOT_MINE = 'b0000000-0000-4000-8000-000000000002'
const DOC = 'c0000000-0000-4000-8000-000000000001'
const PRIVATE_DOC = 'c0000000-0000-4000-8000-000000000002'
const ACTION = 'a0000000-0000-4000-8000-000000000001'
const CH = 'f0000000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({ db: null as unknown as SupabaseClient }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: h.db, user: { id: 'user-ana' }, workspaceId: WS }),
}))

import { GET } from '../route'

type Row = Record<string, unknown>
const edge = (source_type: string, source_id: string, relation: string, created_at: string, target_id = DEAL): Row => ({
  id: `${source_type}-${source_id}-${relation}`,
  workspace_id: WS,
  source_type,
  source_id,
  target_type: 'flow',
  target_id,
  relation,
  created_at,
})

beforeEach(() => {
  h.db = memoryDb({
    flow: [{ id: DEAL, workspace_id: WS, name: 'Fernhill renewal' }],
    team_chat_message: [{ id: MSG, workspace_id: WS, channel_id: CH, body: 'Can someone own @Fernhill renewal?' }],
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'sales' }],
    document: [{ id: DOC, workspace_id: WS, title: 'Q4 renewals plan' }],
    actions: [{ id: ACTION, workspace_id: WS, title: 'Send the renewal quote' }],
    claim: [{ id: 'claim-1', workspace_id: WS, text: 'Fernhill renews in March' }],
    entity_link: [
      edge('team_chat_message', MSG, 'mentions', '2026-11-09T10:00:00Z'),
      edge('document', DOC, 'mentions', '2026-11-08T10:00:00Z'),
      edge('document', DOC, 'related_to', '2026-11-08T11:00:00Z'),
      edge('action', ACTION, 'related_to', '2026-11-07T10:00:00Z'),
      // Not the viewer's to read (RLS left them out of this view):
      edge('document', PRIVATE_DOC, 'mentions', '2026-11-09T11:00:00Z'),
      edge('team_chat_message', DM_MSG_NOT_MINE, 'mentions', '2026-11-09T12:00:00Z'),
      // Never listed:
      edge('claim', 'claim-1', 'about', '2026-11-09T09:00:00Z'),
      edge('email', 'e0000000-0000-4000-8000-000000000001', 'mentions', '2026-11-09T09:00:00Z'),
      // Another deal's.
      edge('action', ACTION, 'mentions', '2026-11-09T09:00:00Z', HIDDEN_DEAL),
    ],
  })
})

const call = (type: string, id: string) => GET(new Request('http://x'), { params: Promise.resolve({ type, id }) })

describe('GET references', () => {
  it('lists what the viewer may read that links to the entity, one row per source, newest first', async () => {
    const res = await call('flow', DEAL)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.references).toEqual([
      { type: 'team_chat_message', id: MSG, label: 'Can someone own @Fernhill renewal?', relations: ['mentions'], created_at: '2026-11-09T10:00:00Z', context: '#sales' },
      { type: 'document', id: DOC, label: 'Q4 renewals plan', relations: ['related_to', 'mentions'], created_at: '2026-11-08T11:00:00Z', context: null },
      { type: 'action', id: ACTION, label: 'Send the renewal quote', relations: ['related_to'], created_at: '2026-11-07T10:00:00Z', context: null },
    ])
    expect(body.count).toBe(3)
    const raw = JSON.stringify(body)
    expect(raw).not.toContain(PRIVATE_DOC)
    expect(raw).not.toContain(DM_MSG_NOT_MINE)
    expect(raw).not.toContain('claim-1')
  })

  it('is a 404 for an entity the viewer cannot read (or that is gone)', async () => {
    expect((await call('flow', HIDDEN_DEAL)).status).toBe(404)
  })

  it('refuses an unknown kind, mail, and a malformed id', async () => {
    expect((await call('widget', DEAL)).status).toBe(400)
    expect((await call('email', DEAL)).status).toBe(400)
    expect((await call('flow', 'nope')).status).toBe(400)
  })

  it('an entity nothing links to answers an empty list', async () => {
    h.db = memoryDb({ flow: [{ id: DEAL, workspace_id: WS, name: 'Fernhill renewal' }], entity_link: [] })
    const body = await (await call('flow', DEAL)).json()
    expect(body.references).toEqual([])
  })
})
