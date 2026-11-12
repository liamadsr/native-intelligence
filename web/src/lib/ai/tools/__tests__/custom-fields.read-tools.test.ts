/**
 * The agent's read tools return a record's custom field values (migration
 * 496 gave tasks, projects, initiatives and documents fields, beside 473's
 * deals, contacts and companies): the SET ones, by the field's name, in
 * definition order, the names set_custom_fields takes. Nothing when none is
 * set (an empty widget shows nothing), and a failed definitions read leaves
 * the record without its fields rather than failing the read.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createActionTools } from '../actions'
import { createDocumentTools } from '../documents'
import { createInitiativeTools } from '../initiatives'
import { createProjectTools } from '../projects'
import { createContactTools } from '../contacts'
import { customFieldsForModel, withCustomFields, type CustomFieldDefinition } from '@/lib/crm/custom-fields'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const WS = 'ws-1'
const ME = 'user-me'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const def = (entity_type: string, key: string, label: string, position: number, field_type = 'text'): CustomFieldDefinition =>
  ({ id: `def-${entity_type}-${key}`, workspace_id: WS, entity_type, key, label, field_type, options: [], position }) as CustomFieldDefinition

function world(): FakeSupabase {
  const db = makeFakeSupabase()
  db.seed('member', [{ id: 'm-me', user_id: ME, workspace_id: WS, role: 'member', display_name: 'Avery Fernhill' }])
  db.seed('team', [{ id: 'team-1', workspace_id: WS, is_private: false, created_at: '2026-01-01T00:00:00Z' }])
  db.seed('workflow_state', [{ id: 'st-todo', team_id: 'team-1', name: 'Todo', category: 'unstarted', is_default: true, sort_order: 0 }])
  db.seed('custom_field_definition', [
    def('action', 'region', 'Region', 0),
    def('action', 'effort_points', 'Effort points', 1, 'number'),
    def('document', 'audience', 'Audience', 0),
    def('project', 'budget_code', 'Budget code', 0),
    def('initiative', 'quarter', 'Quarter', 0),
    def('contact', 'tier', 'Tier', 0),
  ] as unknown as Array<Record<string, unknown>>)
  db.seed('actions', [
    {
      id: 'a-1', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-1', title: 'Fix the gate', status_id: 'st-todo',
      parent_id: null, confirmation: 'confirmed', priority: 0, due_at: null, created_at: '2026-10-01T00:00:00Z',
      // Effort set, a stale key from a removed field, and an empty value.
      custom_fields: { effort_points: 3, region: 'West', retired_field: 'x' },
    },
    {
      id: 'a-2', workspace_id: WS, team_id: 'team-1', identifier: 'ENG-2', title: 'Nothing set', status_id: 'st-todo',
      parent_id: null, confirmation: 'confirmed', priority: 0, due_at: null, created_at: '2026-10-01T00:00:00Z',
      custom_fields: { region: '' },
    },
  ])
  db.seed('document', [
    {
      id: 'doc-1', workspace_id: WS, title: 'Launch brief', content: 'body', kind: 'doc', status: 'active', visibility: 'workspace',
      created_by: 'm-me', frontmatter: {}, revision: 1, is_pinned: false, tags: [], created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z', custom_fields: { audience: 'Partners' },
    },
  ])
  db.seed('projects', [
    { id: 'p-1', workspace_id: WS, name: 'Harbor launch', status: 'active', is_archived: false, is_pinned: false, custom_fields: { budget_code: 'HB-7' } },
  ])
  db.seed('initiative', [
    { id: 'i-1', workspace_id: WS, name: 'Grow the west', status: 'active', custom_fields: { quarter: 'Q1' }, created_at: '2026-10-01T00:00:00Z' },
  ])
  db.seed('contact', [
    { id: 'c-1', workspace_id: WS, full_name: 'Rowan Pike', email: 'rowan@example.com', visibility: 'workspace', custom_fields: { tier: 'Gold' } },
  ])
  return db
}

/** The fake, with `.single()` reading one row as PostgREST's does (the fake's returns a list). */
function client(db: FakeSupabase) {
  return {
    ...db,
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
  } as never
}

type Result = Record<string, unknown> & { success: boolean; error?: string }
const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Result> }).execute(args, OPTS)

describe('custom field values on the read tools', () => {
  it('get_action: the set ones, by name, in definition order; a removed field and an empty value left out', async () => {
    const res = await run(createActionTools(ME, client(world()), WS).get_action, { action_id: 'a-1' })
    expect(res.success).toBe(true)
    const fields = (res.action as Record<string, unknown>).custom_fields as Record<string, unknown>
    expect(fields).toEqual({ Region: 'West', 'Effort points': 3 })
    expect(Object.keys(fields)).toEqual(['Region', 'Effort points'])
  })

  it('get_action: nothing set, no custom_fields at all', async () => {
    const res = await run(createActionTools(ME, client(world()), WS).get_action, { action_id: 'a-2' })
    expect(res.success).toBe(true)
    expect(res.action as Record<string, unknown>).not.toHaveProperty('custom_fields')
  })

  it('list_actions carries them on each row that has any', async () => {
    const res = await run(createActionTools(ME, client(world()), WS).list_actions, { filter: 'all' })
    const rows = res.actions as Array<{ id: string; custom_fields?: Record<string, unknown> }>
    expect(rows.find((r) => r.id === 'a-1')?.custom_fields).toEqual({ Region: 'West', 'Effort points': 3 })
    expect(rows.find((r) => r.id === 'a-2')).not.toHaveProperty('custom_fields')
  })

  it('get_document and list_documents', async () => {
    const t = createDocumentTools(ME, client(world()), WS)
    const one = await run(t.get_document, { document_id: 'doc-1' })
    expect((one.document as Record<string, unknown>).custom_fields).toEqual({ Audience: 'Partners' })
    const list = await run(t.list_documents, { limit: 10 })
    expect((list.documents as Array<Record<string, unknown>>)[0].custom_fields).toEqual({ Audience: 'Partners' })
  })

  it('get_project_context and list_projects', async () => {
    const t = createProjectTools(ME, client(world()), WS)
    const ctx = await run(t.get_project_context, { project_id: 'p-1' })
    const project = ctx.project as Record<string, unknown>
    expect(project.custom_fields).toEqual({ 'Budget code': 'HB-7' })
    expect(project.name).toBe('Harbor launch')
    const list = await run(t.list_projects, {})
    expect((list.projects as Array<Record<string, unknown>>)[0].custom_fields).toEqual({ 'Budget code': 'HB-7' })
  })

  it('get_initiative and list_initiatives', async () => {
    const t = createInitiativeTools(ME, client(world()), WS)
    const one = await run(t.get_initiative, { initiative_id: 'i-1' })
    expect((one.initiative as Record<string, unknown>).custom_fields).toEqual({ Quarter: 'Q1' })
    const list = await run(t.list_initiatives, { filter: 'all' })
    expect((list.initiatives as Array<Record<string, unknown>>)[0].custom_fields).toEqual({ Quarter: 'Q1' })
  })

  it("get_contact names them as every other kind does, not by the stored key", async () => {
    const db = world()
    const fake = { ...(client(db) as object), rpc: async (fn: string) => (fn === 'contact_visible_to' ? { data: true, error: null } : { data: null, error: { message: 'no' } }) }
    const res = await run(createContactTools(ME, fake as never, WS).get_contact, { contact_id: 'c-1' })
    expect(res.success).toBe(true)
    expect((res.contact as Record<string, unknown>).custom_fields).toEqual({ Tier: 'Gold' })
  })

  it('a failed definitions read leaves the record without its fields, never failing the read', async () => {
    const db = world()
    const broken = {
      ...(client(db) as object),
      from: (table: string) => {
        if (table === 'custom_field_definition') {
          const q = db.from(table) as unknown as Record<string, unknown>
          const fail = () => Promise.resolve({ data: null, error: { message: 'boom' } })
          const chain: Record<string, unknown> = new Proxy(q, {
            get: (target, prop) => (prop === 'then' ? (res: (v: unknown) => unknown) => fail().then(res) : typeof target[prop as string] === 'function' ? () => chain : target[prop as string]),
          })
          return chain
        }
        return (client(db) as { from: (t: string) => unknown }).from(table)
      },
    }
    const res = await run(createActionTools(ME, broken as never, WS).get_action, { action_id: 'a-1' })
    expect(res.success).toBe(true)
    expect(res.action as Record<string, unknown>).not.toHaveProperty('custom_fields')
  })
})

describe('customFieldsForModel / withCustomFields', () => {
  const defs = [def('action', 'region', 'Region', 0), def('action', 'effort_points', 'Effort points', 1, 'number')]

  it('keeps strings and numbers that are set, by label, in definition order', () => {
    expect(customFieldsForModel(defs, { effort_points: 0, region: 'East' })).toEqual({ Region: 'East', 'Effort points': 0 })
  })

  it('drops null, empty, unknown keys and non-scalar junk', () => {
    expect(customFieldsForModel(defs, { region: null, effort_points: '', other: 1 })).toEqual({})
    expect(customFieldsForModel(defs, { region: { nested: true }, effort_points: [1] })).toEqual({})
    expect(customFieldsForModel(defs, null)).toEqual({})
    expect(customFieldsForModel(defs, ['West'])).toEqual({})
  })

  it('keeps a new type’s value in its own form, and drops one in another form', () => {
    const typed = [
      def('action', 'tags', 'Tags', 0, 'multi_select'),
      def('action', 'budget', 'Budget', 1, 'currency'),
      def('action', 'done', 'Done', 2, 'checkbox'),
      def('action', 'deals', 'Deals', 3, 'relation'),
    ]
    const id = 'd0000000-0000-4000-8000-000000000001'
    expect(customFieldsForModel(typed, { tags: ['A'], budget: { amount: 5, currency: 'EUR' }, done: false, deals: [id] })).toEqual({
      Tags: ['A'],
      Budget: { amount: 5, currency: 'EUR' },
      Done: false,
      Deals: [id],
    })
    expect(customFieldsForModel(typed, { tags: 'A', budget: 5, done: 'yes', deals: [{ id }] })).toEqual({})
  })

  it('withCustomFields is empty when nothing is set or no field is defined', () => {
    expect(withCustomFields(defs, {})).toEqual({})
    expect(withCustomFields([], { region: 'West' })).toEqual({})
    expect(withCustomFields(defs, { region: 'West' })).toEqual({ custom_fields: { Region: 'West' } })
  })
})
