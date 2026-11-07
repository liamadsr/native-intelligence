/**
 * GET /api/account/agent-work: work with no bot the caller can reach is its
 * workspace's Assistant's (lib/work/bot-owner.ts; Liam, 2026-10-08).
 *
 * What we lock in:
 *   - `?light=1` names every row and card row no reachable bot holds for its
 *     workspace's Assistant: a row with no teammate (older work, a deleted
 *     bot's: the column is `on delete set null`) and a row whose teammate is
 *     behind a private team the caller isn't on; a reachable bot keeps its
 *     own; a sequence send keeps no bot; a workspace with no Assistant keeps
 *     today's answer;
 *   - so the counts over that answer (countByOwner, the shared source's)
 *     count them for the Assistant, a card with a gone raiser too;
 *   - `?teammate=<the Assistant>` reads its own rows AND those rows (not a
 *     reachable bot's, not a sequence send), each named for it, and its last
 *     finished row the same way; another bot's read is unchanged;
 *   - the light read heals a workspace with no Assistant (assistant-heal.ts):
 *     one `seed_system_teammates` call on the service client, then the roster
 *     read again, so this answer names that workspace's work for it; nothing
 *     is called when every workspace has its Assistant; a failed seed keeps
 *     today's answer (the first describe's w2, whose rpc has no stub).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { countByOwner, cardLookupRows, teammateKey } from '@/lib/work/agent-work-lanes'
import { botOwnersFromRoster, withCardOwners } from '@/lib/work/bot-owner'
import type { WorkItem } from '@/lib/work/types'
import { resetAssistantHealForTests } from '@/lib/work/assistant-heal'

const hoisted = vi.hoisted(() => ({
  session: null as unknown,
  service: null as unknown,
  memberships: [
    { memberId: 'm1', workspaceId: 'w1' },
    { memberId: 'm2', workspaceId: 'w2' },
  ],
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: hoisted.session,
    user: { id: 'user-1' },
    workspaceId: 'w1',
    member: { id: 'm1' },
  })),
}))

vi.mock('@/app/api/account/notifications/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/account/notifications/scope')>()
  return { ...actual, resolveMemberships: vi.fn(async () => hoisted.memberships) }
})

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { GET } = await import('@/app/api/account/agent-work/route')

const MIN = 60_000
const DAY = 86_400_000
const ASSISTANT = '00000000-0000-4000-8000-0000000000e1'
const WRITER = '00000000-0000-4000-8000-0000000000e2'
const PRIVATE = '00000000-0000-4000-8000-0000000000e3'
const GONE = '00000000-0000-4000-8000-0000000000e9'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function req(query: string) {
  return new Request(`http://localhost/api/account/agent-work${query}`)
}

function job(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: String(over.id),
    status: 'running',
    origin: 'user',
    progress: {},
    source: {},
    ai_team_member_id: null,
    created_at: ago(60 * MIN),
    ...over,
  }
}

function mate(over: Record<string, unknown>) {
  return {
    workspace_id: 'w1',
    team_id: 'team-public',
    name: String(over.id),
    avatar_url: null,
    role: null,
    autonomy: 'propose',
    is_system: false,
    system_key: null,
    bot_character: null,
    created_at: ago(10 * DAY),
    ...over,
  }
}

let session: FakeSupabase
let service: FakeSupabase

beforeEach(() => {
  resetAssistantHealForTests()
  session = makeFakeSupabase()
  service = makeFakeSupabase()
  hoisted.session = session
  hoisted.service = service
  session.seed('member', [
    { id: 'm1', workspace_id: 'w1', user_id: 'user-1', role: 'owner' },
    { id: 'm2', workspace_id: 'w2', user_id: 'user-1', role: 'member' },
  ])
  session.seed('team', [
    { id: 'team-public', workspace_id: 'w1', is_private: false },
    { id: 'team-private', workspace_id: 'w1', is_private: true },
  ])
  session.seed('ai_team_member', [
    mate({ id: ASSISTANT, name: 'Assistant', team_id: null, is_system: true, system_key: 'assistant', bot_character: 'chat' }),
    mate({ id: WRITER, name: 'Writer', role: 'writer' }),
    // An owner sees a private team's teammate under RLS, but can't reach it (not on the team).
    mate({ id: PRIVATE, name: 'Closer', team_id: 'team-private' }),
  ])
})

const rowById = <T extends { id: string }>(rows: readonly T[], id: string) => rows.find((r) => r.id === id)

describe('?light=1: work no reachable bot holds is named for the Assistant', () => {
  beforeEach(() => {
    session.seed('tracked_job', [
      job({ id: 'legacy', kind: 'prospecting' }),
      job({ id: 'import', kind: 'crm_import' }),
      job({ id: 'writer', status: 'needs_review', ai_team_member_id: WRITER }),
      job({ id: 'private', ai_team_member_id: PRIVATE }),
      job({ id: 'sequence', kind: 'sequence_enrolment' }),
      // w2 has no Assistant: today's answer.
      job({ id: 'w2-legacy', workspace_id: 'w2', member_id: 'm2', kind: 'prospecting' }),
    ])
  })

  it('names the rows with no teammate and the private bot’s for the Assistant; a reachable bot and a sequence send keep theirs', async () => {
    const res = await GET(req('?light=1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ items: WorkItem[] }>(res)
    for (const id of ['legacy', 'import', 'private']) {
      expect(rowById(body.items, id), id).toMatchObject({
        ai_team_member_id: ASSISTANT,
        teammate: { id: ASSISTANT, name: 'Assistant', is_system: true, system_key: 'assistant' },
      })
    }
    // No teammate: fronted for attribution only, so its run's chat stays the person's own.
    for (const id of ['legacy', 'import']) expect(rowById(body.items, id)?.source, id).toMatchObject({ teammate_routed: true })
    // A private team's bot's: shown by the Assistant, but never its own run (no run chat).
    expect(rowById(body.items, 'private')?.source).toMatchObject({ owner_fallback: true })
    expect(rowById(body.items, 'private')?.source).not.toHaveProperty('teammate_routed')
    expect(rowById(body.items, 'writer')?.ai_team_member_id).toBe(WRITER)
    expect(rowById(body.items, 'writer')?.source).not.toHaveProperty('teammate_routed')
    expect(rowById(body.items, 'sequence')?.ai_team_member_id ?? null).toBeNull()
    expect(rowById(body.items, 'w2-legacy')?.ai_team_member_id ?? null).toBeNull()
  })

  it('counts them, and a card whose raiser is gone, for the Assistant on its face; sequence sends stay a lane', async () => {
    session.seed('tracked_job', [job({ id: 'legacy-q', status: 'needs_input', kind: 'onboarding_research' })])
    const body = await readJson<{ items: WorkItem[]; card_rows: WorkItem[]; roster: Array<{ id: string; workspace_id: string; system_key: string | null; reachable?: boolean | null }> }>(
      await GET(req('?light=1')),
    )
    const owners = botOwnersFromRoster(body.roster)
    const cards = withCardOwners(
      [
        { id: 'card-gone', workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: GONE } },
        { id: 'card-none', workspace_id: 'w1', source_flow_run_id: null, payload: {} },
        { id: 'card-writer', workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: WRITER } },
      ],
      owners,
    )
    const counts = countByOwner(body.items, cards, cardLookupRows(body.items, body.card_rows))
    expect(counts.get(teammateKey(ASSISTANT))).toEqual({
      running: 3,
      needsYou: 3,
      beckoning: ['legacy-q', 'card-gone', 'card-none'],
      // A parked question beckons (the bubble lists it) but lights no dot (P13).
      asking: ['legacy-q'],
    })
    expect(counts.get(teammateKey(WRITER))).toEqual({ running: 0, needsYou: 2, beckoning: ['writer', 'card-writer'] })
    expect(counts.get(teammateKey(PRIVATE))).toBeUndefined()
    expect(counts.get('lane:sequence_enrolment')).toEqual({ running: 1, needsYou: 0, beckoning: [] })
    // The workspace with no Assistant: today's lane.
    expect(counts.get('lane:prospecting')).toEqual({ running: 1, needsYou: 0, beckoning: [] })
  })
})

describe('?teammate=<the Assistant>: its rows and the ones no reachable bot holds', () => {
  beforeEach(() => {
    session.seed('tracked_job', [
      job({ id: 'own', ai_team_member_id: ASSISTANT, source: { teammate_routed: true } }),
      job({ id: 'legacy', kind: 'prospecting', status: 'done', created_at: ago(2 * DAY), finished_at: ago(DAY) }),
      job({ id: 'private', ai_team_member_id: PRIVATE, status: 'needs_review' }),
      job({ id: 'writer', ai_team_member_id: WRITER, status: 'needs_review' }),
      job({ id: 'sequence', kind: 'sequence_enrolment' }),
    ])
  })

  it('lists its own, the teammate-less one and the private bot’s, each named for it; never a reachable bot’s or a sequence send', async () => {
    const res = await GET(req(`?teammate=${ASSISTANT}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ items: WorkItem[]; last_finished: WorkItem | null }>(res)
    expect(body.items.map((r) => r.id).sort()).toEqual(['legacy', 'own', 'private'])
    for (const r of body.items) expect(r.ai_team_member_id, r.id).toBe(ASSISTANT)
    // The ones it takes carry its embed (its own come with the read's).
    for (const id of ['legacy', 'private']) expect(rowById(body.items, id)?.teammate, id).toMatchObject({ id: ASSISTANT, name: 'Assistant' })
    expect(body.last_finished).toMatchObject({ id: 'legacy', ai_team_member_id: ASSISTANT })
  })

  it('&last=1 finds the last finished row the same way', async () => {
    const body = await readJson<{ last_finished: WorkItem | null }>(await GET(req(`?teammate=${ASSISTANT}&last=1`)))
    expect(body.last_finished).toMatchObject({ id: 'legacy', ai_team_member_id: ASSISTANT, teammate: { name: 'Assistant' } })
  })

  it('leaves another bot’s read as it was: only its own rows', async () => {
    const body = await readJson<{ items: WorkItem[] }>(await GET(req(`?teammate=${WRITER}`)))
    expect(body.items.map((r) => r.id)).toEqual(['writer'])
  })
})

// One face (always-on-agent §2c): an area face's work is the agent's own.
describe('one face: an area face’s rows are the Assistant’s', () => {
  const MAIL = '00000000-0000-4000-8000-0000000000e4'

  beforeEach(() => {
    session.seed('ai_team_member', [mate({ id: MAIL, name: 'Mail', team_id: null, is_system: true, system_key: 'mail', bot_character: 'mail' })])
    session.seed('tracked_job', [
      job({ id: 'drafts', kind: 'email_drafts', status: 'needs_review', ai_team_member_id: MAIL }),
      job({ id: 'writer', ai_team_member_id: WRITER, status: 'needs_review' }),
    ])
  })

  it('?light=1 names them for the Assistant, routed (its run chat stays the person’s) with their area', async () => {
    const body = await readJson<{ items: WorkItem[] }>(await GET(req('?light=1')))
    expect(rowById(body.items, 'drafts')).toMatchObject({
      ai_team_member_id: ASSISTANT,
      source: { teammate_routed: true, face_area: 'mail' },
    })
    expect(rowById(body.items, 'writer')?.ai_team_member_id).toBe(WRITER)
  })

  it('?teammate=<the Assistant> takes them in; ?teammate=<an area face> reads as the Assistant', async () => {
    const own = await readJson<{ teammate_id: string; items: WorkItem[] }>(await GET(req(`?teammate=${ASSISTANT}`)))
    expect(own.items.map((r) => r.id)).toContain('drafts')
    expect(own.items.map((r) => r.id)).not.toContain('writer')
    const asked = await readJson<{ teammate_id: string; items: WorkItem[] }>(await GET(req(`?teammate=${MAIL}`)))
    expect(asked.teammate_id).toBe(ASSISTANT)
    expect(asked.items.map((r) => r.id)).toContain('drafts')
  })
})

describe('?light=1: a workspace with no Assistant gets one', () => {
  const W2_ASSISTANT = '00000000-0000-4000-8000-0000000000f2'

  beforeEach(() => {
    session.seed('tracked_job', [job({ id: 'w2-legacy', workspace_id: 'w2', member_id: 'm2', kind: 'prospecting' })])
  })

  it('seeds it once on the service client and names its work for the new Assistant', async () => {
    service = makeFakeSupabase({
      rpc: {
        seed_system_teammates: (args) => {
          session.seed('ai_team_member', [
            mate({ id: W2_ASSISTANT, workspace_id: 'w2', name: 'Assistant', team_id: null, is_system: true, system_key: 'assistant', bot_character: 'chat', created_at: ago(0) }),
          ])
          return { data: args.p_workspace_id === 'w2' ? 5 : 0, error: null }
        },
      },
    })
    hoisted.service = service
    const body = await readJson<{ items: WorkItem[]; roster: Array<{ id: string; workspace_id: string; system_key: string | null }> }>(
      await GET(req('?light=1')),
    )
    expect(service.rpcCalls).toEqual([{ fn: 'seed_system_teammates', args: { p_workspace_id: 'w2' } }])
    expect(body.roster.find((t) => t.workspace_id === 'w2' && t.system_key === 'assistant')?.id).toBe(W2_ASSISTANT)
    expect(rowById(body.items, 'w2-legacy')).toMatchObject({ ai_team_member_id: W2_ASSISTANT, teammate: { id: W2_ASSISTANT, system_key: 'assistant' } })
  })

  it('calls nothing when every workspace has its Assistant', async () => {
    session.seed('ai_team_member', [mate({ id: W2_ASSISTANT, workspace_id: 'w2', name: 'Assistant', team_id: null, is_system: true, system_key: 'assistant' })])
    const res = await GET(req('?light=1'))
    expect(res.status).toBe(200)
    expect(service.rpcCalls).toEqual([])
  })
})
