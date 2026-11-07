/**
 * show and read_card (docs/plans/one-agent-and-chat-pages.md, Part 1) against
 * the views query engine on an in-memory double that returns only the columns
 * a select names, as PostgREST does, and models what RLS would hide: the tool
 * route runs on a SERVICE-ROLE client, so the visibility fence
 * (src/lib/views/visibility-fence.ts) is all that stands between a card and
 * another member's private contacts, companies and private-team actions.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createShowTools } from '../show'
import { buildCardContextEntry, type CardContextEntry } from '@/lib/chat-cards/context'

const WS = 'ws-1'
const ME = 'user-me'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MY_MEMBER = uuid(901)
const KENAN = uuid(902) // on my team
const ZOE = uuid(903) // on no team of mine
const ADMIN = uuid(904)
const PUBLIC_TEAM = uuid(801)
const MY_PRIVATE_TEAM = uuid(802)
const SECRET_TEAM = uuid(803) // private, and I am not on it
const ATLAS = uuid(701)

function action(n: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    identifier: `GEN-${n}`,
    title,
    workspace_id: WS,
    team_id: PUBLIC_TEAM,
    parent_id: null,
    priority: 'medium',
    assignee_id: KENAN,
    project_id: null,
    status_id: null,
    created_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    ...extra,
  }
}

function contact(n: number, name: string, visibility: string, createdBy: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    workspace_id: WS,
    full_name: name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test`,
    visibility,
    created_by_member_id: createdBy,
    merged_into_contact_id: null,
    company_id: null,
    created_at: `2026-09-${String(10 + (n % 20)).padStart(2, '0')}T00:00:00Z`,
    ...extra,
  }
}

function seeded() {
  const db = makeFakeSupabase({ project: true })
  db.seed('member', [
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: 'member', display_name: 'Liam' },
    { id: KENAN, user_id: 'user-k', workspace_id: WS, role: 'member', display_name: 'Kenan' },
    { id: ZOE, user_id: 'user-z', workspace_id: WS, role: 'member', display_name: 'Zoe' },
    { id: ADMIN, user_id: 'user-admin', workspace_id: WS, role: 'admin', display_name: 'Ada' },
  ])
  db.seed('team', [
    { id: PUBLIC_TEAM, workspace_id: WS, name: 'Engineering', is_private: false },
    { id: MY_PRIVATE_TEAM, workspace_id: WS, name: 'Founders', is_private: true },
    { id: SECRET_TEAM, workspace_id: WS, name: 'Acquisition', is_private: true },
  ])
  db.seed('team_member', [
    { team_id: PUBLIC_TEAM, member_id: MY_MEMBER },
    { team_id: PUBLIC_TEAM, member_id: KENAN },
    { team_id: MY_PRIVATE_TEAM, member_id: MY_MEMBER },
    { team_id: SECRET_TEAM, member_id: ZOE },
  ])
  db.seed('projects', [{ id: ATLAS, name: 'Atlas', workspace_id: WS }])
  db.seed('actions', [
    action(1, 'Pricing page copy', { assignee_id: MY_MEMBER, priority: 'high' }),
    action(2, 'Pricing FAQ', { project_id: ATLAS }),
    action(3, 'Fix login', { assignee_id: MY_MEMBER, project_id: ATLAS }),
    action(4, 'Ship docs'),
    action(5, 'Pricing tiers', { workspace_id: 'ws-other' }),
    action(6, 'Pricing for the acquisition', { team_id: SECRET_TEAM }),
    action(7, 'Pricing for founders', { team_id: MY_PRIVATE_TEAM }),
  ])
  db.seed('contact', [
    contact(11, 'Wendy Workspace', 'workspace', ZOE, { company_id: uuid(21) }),
    contact(12, 'Molly Mine', 'private', MY_MEMBER),
    contact(13, 'Tom Teammate', 'team', KENAN),
    contact(14, 'Petra Private', 'private', ZOE, { company_id: uuid(22) }),
    contact(15, 'Sam Shared', 'private', ZOE),
    contact(16, 'Tess Team-of-Zoe', 'team', ZOE),
  ])
  db.seed('contact_share', [{ contact_id: uuid(15), shared_with_member_id: MY_MEMBER, shared_with_team_id: null }])
  db.seed('company', [
    // Acme: a contact everyone sees. Hidden Co: only Zoe's private contact.
    { id: uuid(21), workspace_id: WS, name: 'Acme', created_at: '2026-09-01T00:00:00Z', visible_contacts: [{ id: uuid(11), visibility: 'workspace', created_by_member_id: ZOE, merged_into_contact_id: null }] },
    { id: uuid(22), workspace_id: WS, name: 'Hidden Co', created_at: '2026-09-02T00:00:00Z', visible_contacts: [{ id: uuid(14), visibility: 'private', created_by_member_id: ZOE, merged_into_contact_id: null }] },
  ])
  return db
}

type Exec = (input: unknown) => Promise<Record<string, unknown>>
function tools(db: ReturnType<typeof makeFakeSupabase>, cards?: CardContextEntry[], userId = ME) {
  const t = createShowTools(userId, db as never, WS, cards)
  return {
    show: ((input: unknown) => (t.show.execute as unknown as Exec)(input)) as Exec,
    readCard: ((input: unknown) => (t.read_card.execute as unknown as Exec)(input)) as Exec,
  }
}

const identifiers = (out: Record<string, unknown>) => ((out.items ?? out.rows) as Array<{ identifier: string }>).map((i) => i.identifier).sort()
const titles = (out: Record<string, unknown>) => ((out.items ?? out.rows) as Array<{ title: string }>).map((i) => i.title).sort()

describe('show', () => {
  it('runs the page once and returns the cleaned-up spec, the count and the first rows', async () => {
    const out = await tools(seeded()).show({
      kind: 'list',
      title: 'Pricing',
      entity_type: 'action',
      filters: [{ field: 'title', operator: 'contains', value: 'pricing' }],
    })
    expect(out.success).toBe(true)
    expect(out.card).toEqual({ kind: 'list', title: 'Pricing', entity_type: 'action', filters: [{ field: 'title', operator: 'contains', value: 'pricing' }] })
    // Not the other workspace's, not the secret team's; my private team's is mine.
    expect(identifiers(out)).toEqual(['GEN-1', 'GEN-2', 'GEN-7'])
    expect(out.count).toBe(3)
    expect(out.items).toContainEqual({ id: uuid(1), identifier: 'GEN-1', title: 'Pricing page copy' })
  })

  it('turns a project name into its id, and refuses an unknown one naming what exists', async () => {
    const db = seeded()
    const ok = await tools(db).show({ kind: 'list', title: 'Atlas', entity_type: 'action', filters: [{ field: 'project_id', operator: 'is', value: 'atlas' }] })
    expect(ok.success).toBe(true)
    expect((ok.card as { filters: unknown[] }).filters).toEqual([{ field: 'project_id', operator: 'is', value: ATLAS }])
    expect(ok.count).toBe(2)
    const bad = await tools(db).show({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'project_id', operator: 'is', value: 'Zeus' }] })
    expect(bad).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(bad.error).toContain("no project named 'Zeus'")
    expect(bad.error).toContain('Atlas')
  })

  it('refuses a wrong field with the fix, before any query', async () => {
    const db = seeded()
    const out = await tools(db).show({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'owner', operator: 'is', value: '@me' }] })
    expect(out.success).toBe(false)
    expect(out.error).toContain('assignee_id')
    expect(db.calls.filter((c) => c.table === 'actions')).toHaveLength(0)
  })

  it('opens a record by an action identifier, holding its real id', async () => {
    const out = await tools(seeded()).show({ kind: 'record', title: 'Fix login', record: { type: 'action', id: 'gen-3' } })
    expect(out).toMatchObject({ success: true, card: { kind: 'record', record: { type: 'action', id: uuid(3) } }, item: { identifier: 'GEN-3' } })
  })
})

describe('visibility: a card shows, counts and names only what the person may see', () => {
  it("lists and counts the contacts the person sees, never another member's private ones", async () => {
    const out = await tools(seeded()).show({ kind: 'list', title: 'People', entity_type: 'contact', filters: [] })
    // Workspace-wide, my own, a teammate's team contact, one shared with me.
    expect(titles(out)).toEqual(['Molly Mine', 'Sam Shared', 'Tom Teammate', 'Wendy Workspace'])
    expect(out.count).toBe(4)
  })

  it('an admin sees every contact', async () => {
    const out = await tools(seeded(), undefined, 'user-admin').show({ kind: 'list', title: 'People', entity_type: 'contact', filters: [] })
    expect(out.count).toBe(6)
  })

  it('read_card never hands back a hidden contact or its fields', async () => {
    const cur = { filters: [] }
    const cards = [buildCardContextEntry({ n: 1, id: 'c1', spec: { kind: 'list', title: 'People', entity_type: 'contact', base: cur }, cur })]
    const out = await tools(seeded(), cards).readCard({ card: 1, fields: ['email'] })
    expect(out.total).toBe(4)
    const emails = (out.rows as Array<{ email: string }>).map((r) => r.email)
    expect(emails).toContain('molly.mine@acme.test')
    expect(emails).not.toContain('petra.private@acme.test')
    expect(emails).not.toContain('tess.team-of-zoe@acme.test')
  })

  it('counts a company only when the person sees one of its contacts (an admin sees all)', async () => {
    const out = await tools(seeded()).show({ kind: 'list', title: 'Companies', entity_type: 'company', filters: [] })
    expect(titles(out)).toEqual(['Acme'])
    expect(out.count).toBe(1)
    const admin = await tools(seeded(), undefined, 'user-admin').show({ kind: 'list', title: 'Companies', entity_type: 'company', filters: [] })
    expect(admin.count).toBe(2)
  })

  it('will not open a hidden contact or company as a record, and refuses as if it did not exist', async () => {
    const t = tools(seeded())
    const hidden = await t.show({ kind: 'record', title: 'Petra', record: { type: 'contact', id: uuid(14) } })
    expect(hidden).toMatchObject({ success: false })
    expect(hidden.error).toBe(`record.id: no contact '${uuid(14)}' in this workspace`)
    expect((await t.show({ kind: 'record', title: 'Hidden', record: { type: 'company', id: uuid(22) } })).success).toBe(false)
    expect((await t.show({ kind: 'record', title: 'Sam', record: { type: 'contact', id: uuid(15) } })).success).toBe(true)
    expect((await t.show({ kind: 'record', title: 'Acme', record: { type: 'company', id: uuid(21) } })).success).toBe(true)
  })

  it("never resolves or names a company the person cannot see, nor lists companies in a refusal", async () => {
    const hidden = await tools(seeded()).show({ kind: 'list', title: 'x', entity_type: 'contact', filters: [{ field: 'company_id', operator: 'is', value: 'Hidden Co' }] })
    expect(hidden.success).toBe(false)
    expect(hidden.error).toContain("no company named 'Hidden Co'")
    expect(hidden.error).not.toMatch(/Acme|Petra|Some there/)
    const visible = await tools(seeded()).show({ kind: 'list', title: 'x', entity_type: 'contact', filters: [{ field: 'company_id', operator: 'is', value: 'Acme' }] })
    expect((visible.card as { filters: unknown[] }).filters).toEqual([{ field: 'company_id', operator: 'is', value: uuid(21) }])
  })

  it('leaves out private teams the person is not on: their actions, a record, and the team name', async () => {
    const t = tools(seeded())
    const all = await t.show({ kind: 'list', title: 'All', entity_type: 'action', filters: [] })
    expect(identifiers(all)).not.toContain('GEN-6')
    expect(all.count).toBe(5)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'action', id: 'GEN-6' } })).success).toBe(false)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'action', id: 'GEN-7' } })).success).toBe(true)
    const team = await t.show({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'team_id', operator: 'is', value: 'Acquisition' }] })
    expect(team.success).toBe(false)
    expect(team.error).toContain("no team named 'Acquisition'")
    expect(team.error).toContain('Engineering')
    expect(team.error).toContain('Founders')
    expect(team.error?.toString().split("'Acquisition'")[1]).not.toContain('Acquisition')
  })

  it("never opens an eval capture, nor another member's private one", async () => {
    const db = seeded()
    db.seed('captures', [
      { id: uuid(31), workspace_id: WS, title: 'Mock call', visibility: 'workspace', user_id: 'user-k', is_eval: true },
      { id: uuid(32), workspace_id: WS, title: 'Zoe 1:1', visibility: 'private', user_id: 'user-z', is_eval: false },
      { id: uuid(33), workspace_id: WS, title: 'Standup', visibility: 'workspace', user_id: 'user-k', is_eval: false },
    ])
    const t = tools(db)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'capture', id: uuid(31) } })).success).toBe(false)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'capture', id: uuid(32) } })).success).toBe(false)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'capture', id: uuid(33) } })).success).toBe(true)
  })
})

describe('visibility follow-ups', () => {
  it("never names a private team the person is not on through a row's team embed (a document)", async () => {
    const db = seeded()
    db.seed('document', [
      { id: uuid(41), workspace_id: WS, title: 'Plan', kind: 'doc', visibility: 'workspace', team_id: PUBLIC_TEAM, team: { id: PUBLIC_TEAM, name: 'Engineering' }, created_at: '2026-10-01T00:00:00Z' },
      { id: uuid(42), workspace_id: WS, title: 'Deal memo', kind: 'doc', visibility: 'workspace', team_id: SECRET_TEAM, team: { id: SECRET_TEAM, name: 'Acquisition' }, created_at: '2026-10-02T00:00:00Z' },
    ])
    const cur = { filters: [] }
    const cards = [buildCardContextEntry({ n: 1, id: 'c1', spec: { kind: 'list', title: 'Docs', entity_type: 'document', base: cur }, cur })]
    const out = await tools(db, cards).readCard({ card: 1, fields: ['team'] })
    const rows = out.rows as Array<{ title: string; team: unknown }>
    expect(rows.find((r) => r.title === 'Plan')?.team).toBe('Engineering')
    expect(rows.find((r) => r.title === 'Deal memo')?.team).toBeNull()
    expect(JSON.stringify(out)).not.toContain('Acquisition')
  })

  it("lists, counts and opens a person's own private documents, never another member's (369)", async () => {
    const db = seeded()
    db.seed('document', [
      { id: uuid(43), workspace_id: WS, title: 'Team plan', kind: 'doc', visibility: 'workspace', created_by: ZOE, created_at: '2026-10-01T00:00:00Z' },
      { id: uuid(44), workspace_id: WS, title: 'My prep', kind: 'doc', visibility: 'private', created_by: MY_MEMBER, created_at: '2026-10-02T00:00:00Z' },
      { id: uuid(45), workspace_id: WS, title: 'Zoe prep', kind: 'doc', visibility: 'private', created_by: ZOE, created_at: '2026-10-03T00:00:00Z' },
    ])
    const t = tools(db)
    const list = await t.show({ kind: 'list', title: 'Docs', entity_type: 'document', filters: [] })
    expect(titles(list).sort()).toEqual(['My prep', 'Team plan'])
    expect(JSON.stringify(list)).not.toContain('Zoe prep')
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'document', id: uuid(44) } })).success).toBe(true)
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'document', id: uuid(45) } })).success).toBe(false)
  })

  it('fences company names before capping the candidates, so a visible match is never crowded out', async () => {
    const db = seeded()
    db.seed('company', Array.from({ length: 25 }, (_, i) => ({
      id: uuid(1000 + i),
      workspace_id: WS,
      name: `Globex ${String(i).padStart(2, '0')}`,
      visible_contacts: [{ id: uuid(14), visibility: 'private', created_by_member_id: ZOE }],
    })))
    db.seed('company', [{ id: uuid(1100), workspace_id: WS, name: 'Globex Main', visible_contacts: [{ id: uuid(11), visibility: 'workspace', created_by_member_id: ZOE }] }])
    db.rows('contact').push({ ...db.rows('contact')[0], id: uuid(17), company_id: uuid(1100) })
    const out = await tools(db).show({ kind: 'list', title: 'x', entity_type: 'contact', filters: [{ field: 'company_id', operator: 'is', value: 'Globex' }] })
    expect(out.success).toBe(true)
    expect((out.card as { filters: unknown[] }).filters).toEqual([{ field: 'company_id', operator: 'is', value: uuid(1100) }])
  })

  it('counts a company whose only visible contact was merged away, as the live policy does', async () => {
    const db = seeded()
    db.seed('contact', [contact(18, 'Merged Mo', 'workspace', ZOE, { company_id: uuid(23), merged_into_contact_id: uuid(11) })])
    db.seed('company', [{ id: uuid(23), workspace_id: WS, name: 'Merged Inc', created_at: '2026-09-03T00:00:00Z', visible_contacts: [{ id: uuid(18), visibility: 'workspace', created_by_member_id: ZOE, merged_into_contact_id: uuid(11) }] }])
    const t = tools(db)
    const list = await t.show({ kind: 'list', title: 'Companies', entity_type: 'company', filters: [] })
    expect(titles(list)).toEqual(['Acme', 'Merged Inc'])
    expect((await t.show({ kind: 'record', title: 'x', record: { type: 'company', id: uuid(23) } })).success).toBe(true)
  })
})

describe('status names', () => {
  function withStates() {
    const db = seeded()
    // Over a thousand states of other teams come first; the lookup must not stop at them.
    db.seed('workflow_state', [
      ...Array.from({ length: 1100 }, (_, i) => ({ id: uuid(5000 + i), name: 'Done', team_id: uuid(9000), category: 'completed', team: { workspace_id: 'ws-other' } })),
      { id: uuid(601), name: 'Done', team_id: PUBLIC_TEAM, category: 'completed', team: { workspace_id: WS } },
      { id: uuid(602), name: 'In Progress', team_id: PUBLIC_TEAM, category: 'started', team: { workspace_id: WS } },
      { id: uuid(603), name: 'Vault', team_id: SECRET_TEAM, category: 'started', team: { workspace_id: WS } },
    ])
    return db
  }

  it("resolves a status by name among the person's teams, past any number of other teams' states", async () => {
    const out = await tools(withStates()).show({ kind: 'list', title: 'Done', entity_type: 'action', filters: [{ field: 'status_id', operator: 'is', value: 'done' }] })
    expect(out.success).toBe(true)
    expect((out.card as { filters: unknown[] }).filters).toEqual([{ field: 'status_id', operator: 'is', value: uuid(601) }])
  })

  it("never resolves or lists a private team's status", async () => {
    const out = await tools(withStates()).show({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'status_id', operator: 'is', value: 'Vault' }] })
    expect(out.success).toBe(false)
    expect(out.error).toContain('In Progress')
    expect(String(out.error).split('Statuses here:')[1]).not.toContain('Vault')
  })

  it('hides completed actions when the card does, as the page does', async () => {
    const db = withStates()
    // Every action has a status; GEN-1's is a completed one.
    for (const a of db.rows('actions')) a.status_id = a.id === uuid(1) ? uuid(601) : uuid(602)
    const base = { filters: [{ field: 'title', operator: 'contains' as const, value: 'pricing' }] }
    const cur = { ...base, show_completed: false }
    const cards = [buildCardContextEntry({ n: 1, id: 'c1', spec: { kind: 'list', title: 'Pricing', entity_type: 'action', base }, cur })]
    const out = await tools(db, cards).readCard({ card: 1 })
    expect(identifiers(out)).toEqual(['GEN-2', 'GEN-7'])
    expect(out.total).toBe(2)
  })
})

describe('read_card', () => {
  const AGENT = { filters: [{ field: 'title', operator: 'contains' as const, value: 'pricing' }] }
  const MINE = { filters: [{ field: 'assignee_id', operator: 'is' as const, value: '@me' }] }

  function cards(): CardContextEntry[] {
    return [
      buildCardContextEntry({ n: 1, id: 'call_1', spec: { kind: 'list', title: 'Pricing', entity_type: 'action', base: AGENT }, cur: AGENT }),
      // Card 2: the person changed it by hand to their own actions.
      buildCardContextEntry({ n: 2, id: 'call_2', spec: { kind: 'list', title: 'Pricing again', entity_type: 'action', base: AGENT }, cur: MINE, touchedAt: 1_000 }),
    ]
  }

  it("returns the rows the card shows now, the person's change included, with the fields asked for", async () => {
    const out = await tools(seeded(), cards()).readCard({ card: 2, fields: ['priority'] })
    expect(out).toMatchObject({ success: true, card: 2, total: 2 })
    const rows = out.rows as Array<Record<string, unknown>>
    expect(rows.map((r) => r.identifier).sort()).toEqual(['GEN-1', 'GEN-3'])
    expect(rows.find((r) => r.identifier === 'GEN-1')).toMatchObject({ title: 'Pricing page copy', priority: 'high' })
  })

  it('reads the card in focus when no number is given', async () => {
    const out = await tools(seeded(), cards()).readCard({})
    expect(out.card).toBe(2)
  })

  it('names the cards there are when asked for one that is not', async () => {
    const out = await tools(seeded(), cards()).readCard({ card: 9 })
    expect(out.success).toBe(false)
    expect(out.error).toContain('card 1 (Pricing), card 2 (Pricing again)')
  })

  it('says no card is open when the chat sent none', async () => {
    expect(await tools(seeded()).readCard({})).toMatchObject({ success: false, code: 'NO_CARDS' })
  })

  it('refuses a field rows do not have, listing the ones they do', async () => {
    const out = await tools(seeded(), cards()).readCard({ card: 1, fields: ['blocked'] })
    expect(out.success).toBe(false)
    expect(out.error).toContain('priority')
  })

  it('says a card that came without its spec is too big to read back', async () => {
    const out = await tools(seeded(), [{ n: 4, id: 'c4', kind: 'list', title: 'Huge', entity: 'action' }]).readCard({ card: 4 })
    expect(out).toMatchObject({ success: false, code: 'CARD_TOO_BIG' })
  })
})
