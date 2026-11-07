/**
 * The agent tools see the WHOLE workspace, not just the rows the caller made.
 *
 * Dial8 is a workspace for many people. The tools used to scope shared tables
 * to `.eq('user_id', userId)`, so a teammate's ENG-42 could not even be looked
 * up, let alone updated, from chat. They now match RLS instead:
 *   - actions: any member reads and updates; only an owner or admin deletes;
 *   - projects: any member reads and updates;
 *   - attachments: any member reads, but a file on a capture is only as
 *     visible as that capture (a teammate's private meeting stays hidden).
 *
 * The workspace fence is untouched, so a row in a workspace the caller doesn't
 * belong to stays invisible — these tools run on a service-role client for MCP
 * and unattended runs, where the tools' own filters are the only fence.
 *
 * The Supabase double is a small in-memory engine: eq/neq/in/ilike/is/or
 * become predicates ANDed over real rows, and update/delete mutate them.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createActionTools } from '../actions'
import { createProjectTools } from '../projects'
import { createAttachmentTools } from '../attachments'

vi.mock('@/lib/proposed-changes/apply-engine', () => ({ applyChange: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const ME = 'user-me'
const TEAMMATE = 'user-teammate'
const WS = 'ws-1'
const WS_FOREIGN = 'ws-foreign'
const MY_MEMBER = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_MEMBER = '22222222-2222-4222-8222-222222222222'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Split a PostgREST `.or()` filter on its top-level commas (not those inside `in.(...)`). */
function orClauses(filter: string): Array<(r: Row) => boolean> {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of filter) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts.map((p) => {
    const [col, op, ...rest] = p.split('.')
    const val = rest.join('.')
    if (op === 'eq') return (r: Row) => String(r[col]) === val
    if (op === 'in') {
      const vals = val.replace(/^\(|\)$/g, '').split(',')
      return (r: Row) => vals.includes(String(r[col]))
    }
    throw new Error(`unsupported or() op: ${p}`)
  })
}

function tableChain(rows: Row[], opts: { blockDelete?: boolean; embeds?: Record<string, (r: Row, val: unknown) => boolean> } = {}) {
  const preds: Array<(r: Row) => boolean> = []
  let limitN: number | null = null
  let mode: 'select' | 'update' | 'delete' = 'select'
  let patch: Row = {}

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.range = vi.fn(pass)
  chain.textSearch = vi.fn(pass)
  chain.eq = vi.fn((col: string, val: unknown) => {
    // A filter on an inner embed (`assigned.member_id`) keeps the parent rows
    // that have a matching embedded row.
    const embed = opts.embeds?.[col]
    if (col.includes('.') && !embed) throw new Error(`unsupported embed filter: ${col}`)
    preds.push(embed ? (r) => embed(r, val) : (r) => r[col] === val)
    return chain
  })
  chain.neq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] !== val)
    return chain
  })
  chain.is = vi.fn((col: string, val: unknown) => {
    preds.push((r) => (r[col] ?? null) === val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    preds.push((r) => vals.includes(r[col]))
    return chain
  })
  chain.ilike = vi.fn((col: string, pattern: string) => {
    const needle = pattern.replace(/%/g, '').toLowerCase()
    preds.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return chain
  })
  chain.or = vi.fn((filter: string) => {
    const clauses = orClauses(filter)
    preds.push((r) => clauses.some((c) => c(r)))
    return chain
  })
  chain.limit = vi.fn((n: number) => {
    limitN = n
    return chain
  })
  chain.update = vi.fn((p: Row) => {
    mode = 'update'
    patch = p
    return chain
  })
  chain.delete = vi.fn(() => {
    mode = 'delete'
    return chain
  })

  const run = (): Row[] => {
    let matched = rows.filter((r) => preds.every((p) => p(r)))
    if (limitN !== null) matched = matched.slice(0, limitN)
    if (mode === 'update') for (const r of matched) Object.assign(r, patch)
    if (mode === 'delete') {
      // RLS on the session client filters a delete it refuses silently: no
      // error, no rows.
      if (opts.blockDelete) return []
      for (const r of matched) rows.splice(rows.indexOf(r), 1)
    }
    return matched
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1
      ? { data: matched[0], error: null }
      : { data: null, error: { message: 'no rows returned' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = run()
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
  }
  return chain
}

function makeDb(seed: Record<string, Row[]>, opts: { myRole?: string; blockDelete?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    member: [
      { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: opts.myRole ?? 'member', workspace: { id: WS, name: 'Alpha' } },
      { id: TEAMMATE_MEMBER, user_id: TEAMMATE, workspace_id: WS, role: 'member', workspace: { id: WS, name: 'Alpha' } },
    ],
    team: [{ id: 'team-1', workspace_id: WS }],
    workflow_state: [],
    action_assignee: [],
    ...seed,
  }
  const from = vi.fn((table: string) => {
    tables[table] ??= []
    return tableChain(tables[table], {
      blockDelete: table === 'actions' && opts.blockDelete,
      embeds: {
        'assigned.member_id': (r, val) => tables.action_assignee.some((x) => x.action_id === r.id && x.member_id === val),
      },
    })
  })
  const storage = {
    from: () => ({
      createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/file' }, error: null }),
      download: async () => ({ data: null, error: { message: 'not in this test' } }),
    }),
  }
  return { supabase: { from, storage } as never, tables }
}

function action(overrides: Partial<Row> & { id: string }): Row {
  return {
    workspace_id: WS,
    user_id: ME,
    identifier: 'ENG-1',
    title: 'Something',
    description: null,
    status_id: null,
    team_id: 'team-1',
    priority: 'none',
    due_at: null,
    assignee_id: null,
    parent_id: null,
    project_id: null,
    workflow_state: null,
    project: null,
    labels: [],
    ...overrides,
  }
}

/** One of mine, one a teammate made and owns, one in a workspace I'm not in. */
const actionSeed = () => ({
  actions: [
    action({ id: 'a-mine', identifier: 'ENG-1', title: 'My work', assignee_id: MY_MEMBER }),
    action({ id: 'a-teammate', identifier: 'ENG-42', title: 'Teammate work', user_id: TEAMMATE, assignee_id: TEAMMATE_MEMBER }),
    action({ id: 'a-foreign', identifier: 'ENG-42', title: 'Foreign work', user_id: 'stranger', workspace_id: WS_FOREIGN }),
  ],
})

type ToolResult = {
  success: boolean
  error?: string
  message?: string
  actions?: Array<{ id: string }>
  action?: { id: string; title?: string }
  projects?: Array<{ id: string }>
  project?: { id: string; name: string }
  attachments?: Array<{ id: string }>
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

const actionTools = (supabase: never) => createActionTools(ME, supabase, WS)

describe("actions — a teammate's action is the workspace's action", () => {
  it("list_actions lists everyone's actions by default, and nothing outside the workspace", async () => {
    const { supabase } = makeDb(actionSeed())
    const res = await run(actionTools(supabase).list_actions, { status: 'all' })

    expect(res.success).toBe(true)
    expect(res.actions?.map((a) => a.id).sort()).toEqual(['a-mine', 'a-teammate'])
  })

  it("finds a teammate's action by identifier, and updates it", async () => {
    const { supabase, tables } = makeDb(actionSeed())
    const res = await run(actionTools(supabase).update_action, { identifier: 'ENG-42', title: 'Renamed' })

    expect(res.success).toBe(true)
    expect(tables.actions.find((a) => a.id === 'a-teammate')!.title).toBe('Renamed')
    // The identical identifier in a workspace I'm not in is untouched.
    expect(tables.actions.find((a) => a.id === 'a-foreign')!.title).toBe('Foreign work')
  })

  it("get_action reads a teammate's action by identifier and by id", async () => {
    const { supabase } = makeDb(actionSeed())
    const byIdentifier = await run(actionTools(supabase).get_action, { identifier: 'ENG-42' })
    const byId = await run(actionTools(supabase).get_action, { action_id: 'a-teammate' })

    expect(byIdentifier.success).toBe(true)
    expect(byIdentifier.action?.id).toBe('a-teammate')
    expect(byId.success).toBe(true)
    expect(byId.action?.id).toBe('a-teammate')
  })
})

describe("list_actions — assignee: 'me' keeps \"what do I need to do\" expressible", () => {
  it("narrows to the caller's assignments, through the join table, whoever made the action", async () => {
    const seed = actionSeed()
    // A teammate-made action I'm assigned to.
    seed.actions.push(action({ id: 'a-joined', identifier: 'ENG-9', user_id: TEAMMATE, assignee_id: null }))
    const { supabase } = makeDb({
      ...seed,
      action_assignee: [
        { action_id: 'a-mine', member_id: MY_MEMBER },
        { action_id: 'a-joined', member_id: MY_MEMBER },
        { action_id: 'a-teammate', member_id: TEAMMATE_MEMBER },
      ],
    })
    const res = await run(actionTools(supabase).list_actions, { status: 'all', assignee: 'me' })

    expect(res.success).toBe(true)
    expect(res.actions?.map((a) => a.id).sort()).toEqual(['a-joined', 'a-mine'])
  })

  it("narrows to a teammate's assignments by member id", async () => {
    const { supabase } = makeDb({
      ...actionSeed(),
      action_assignee: [
        { action_id: 'a-mine', member_id: MY_MEMBER },
        { action_id: 'a-teammate', member_id: TEAMMATE_MEMBER },
      ],
    })
    const res = await run(actionTools(supabase).list_actions, { status: 'all', assignee: TEAMMATE_MEMBER })

    expect(res.actions?.map((a) => a.id)).toEqual(['a-teammate'])
  })

  it('refuses an assignee that is neither me nor a uuid, before it reaches a filter string', async () => {
    const { supabase } = makeDb(actionSeed())
    const res = await run(actionTools(supabase).list_actions, { status: 'all', assignee: 'x,user_id.eq.y' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/assignee/)
  })
})

describe('delete_action — owners and admins only, as RLS says', () => {
  it('lets a workspace owner delete a teammate-made action', async () => {
    const { supabase, tables } = makeDb(actionSeed(), { myRole: 'owner' })
    const res = await run(actionTools(supabase).delete_action, { identifier: 'ENG-42' })

    expect(res).toEqual({ success: true, message: 'Action deleted' })
    expect(tables.actions.map((a) => a.id)).not.toContain('a-teammate')
  })

  it('lets an admin delete their own action', async () => {
    const { supabase, tables } = makeDb(actionSeed(), { myRole: 'admin' })
    const res = await run(actionTools(supabase).delete_action, { action_id: 'a-mine' })

    expect(res.success).toBe(true)
    expect(tables.actions.map((a) => a.id)).not.toContain('a-mine')
  })

  it("refuses a plain member deleting a teammate's action, and deletes nothing", async () => {
    const { supabase, tables } = makeDb(actionSeed())
    const res = await run(actionTools(supabase).delete_action, { identifier: 'ENG-42' })

    expect(res).toEqual({ success: false, error: 'Only a workspace owner or admin can delete an action' })
    expect(tables.actions).toHaveLength(3)
  })

  it('refuses a plain member deleting even an action they created', async () => {
    const { supabase, tables } = makeDb(actionSeed())
    const res = await run(actionTools(supabase).delete_action, { action_id: 'a-mine' })

    expect(res.success).toBe(false)
    expect(tables.actions).toHaveLength(3)
  })

  it('reports failure, not success, when the delete matched no row', async () => {
    const { supabase, tables } = makeDb(actionSeed(), { myRole: 'owner', blockDelete: true })
    const res = await run(actionTools(supabase).delete_action, { action_id: 'a-teammate' })

    expect(res).toEqual({ success: false, error: 'Action not deleted' })
    expect(tables.actions).toHaveLength(3)
  })
})

describe("projects — a teammate's project is the workspace's project", () => {
  const projectSeed = () => ({
    projects: [
      { id: 'p-mine', workspace_id: WS, user_id: ME, name: 'Apollo', is_archived: false, is_pinned: false, status: 'active' },
      { id: 'p-teammate', workspace_id: WS, user_id: TEAMMATE, name: 'Hermes launch', is_archived: false, is_pinned: false, status: 'active' },
      { id: 'p-default', workspace_id: WS, user_id: TEAMMATE, name: '__default__', is_archived: false, is_pinned: false, status: 'active' },
      { id: 'p-foreign', workspace_id: WS_FOREIGN, user_id: 'stranger', name: 'Hermes launch', is_archived: false, is_pinned: false, status: 'active' },
    ],
  })

  it("list_projects returns a teammate's project, but not the hidden default or another workspace's", async () => {
    const { supabase } = makeDb(projectSeed())
    const res = await run(createProjectTools(ME, supabase, WS).list_projects, {})

    expect(res.success).toBe(true)
    expect(res.projects?.map((p) => p.id).sort()).toEqual(['p-mine', 'p-teammate'])
  })

  it("update_project by name finds a teammate's project", async () => {
    const { supabase, tables } = makeDb(projectSeed())
    const res = await run(createProjectTools(ME, supabase, WS).update_project, {
      name_match: 'hermes',
      status: 'paused',
    })

    expect(res.success).toBe(true)
    expect(tables.projects.find((p) => p.id === 'p-teammate')!.status).toBe('paused')
    expect(tables.projects.find((p) => p.id === 'p-foreign')!.status).toBe('active')
  })

  it("never matches a teammate's hidden __default__ project by name", async () => {
    const { supabase } = makeDb(projectSeed())
    const res = await run(createProjectTools(ME, supabase, WS).update_project, {
      name_match: 'default',
      status: 'paused',
    })

    expect(res).toEqual({ success: false, error: 'Project not found' })
  })

  it('refuses a name that matches several projects, naming them, and changes none', async () => {
    const seed = projectSeed()
    seed.projects.push({ id: 'p-two', workspace_id: WS, user_id: ME, name: 'Hermes docs', is_archived: false, is_pinned: false, status: 'active' })
    const { supabase, tables } = makeDb(seed)
    const res = await run(createProjectTools(ME, supabase, WS).update_project, { name_match: 'hermes', status: 'paused' })

    expect(res.success).toBe(false)
    expect(res.error).toContain('matches several projects')
    expect(res.error).toContain('"Hermes launch"')
    expect(res.error).toContain('"Hermes docs"')
    expect(tables.projects.every((p) => p.status === 'active')).toBe(true)
  })

  it('takes the one exact name among several matches', async () => {
    const seed = projectSeed()
    seed.projects.push({ id: 'p-two', workspace_id: WS, user_id: ME, name: 'Hermes launch v2', is_archived: false, is_pinned: false, status: 'active' })
    const { supabase, tables } = makeDb(seed)
    const res = await run(createProjectTools(ME, supabase, WS).update_project, { name_match: 'hermes launch', status: 'paused' })

    expect(res.success).toBe(true)
    expect(tables.projects.find((p) => p.id === 'p-teammate')!.status).toBe('paused')
    expect(tables.projects.find((p) => p.id === 'p-two')!.status).toBe('active')
  })
})

describe('a title that matches several actions is refused, never guessed', () => {
  const seed = () => ({
    actions: [
      action({ id: 'a-mine', identifier: 'ENG-1', title: 'Follow up with Ana' }),
      action({ id: 'a-teammate', identifier: 'ENG-42', title: 'Follow up with Bo', user_id: TEAMMATE }),
    ],
  })

  it('update_action by a shared title names both and changes neither', async () => {
    const { supabase, tables } = makeDb(seed())
    const res = await run(actionTools(supabase).update_action, { title_match: 'follow up', title: 'Renamed' })

    expect(res.success).toBe(false)
    expect(res.error).toContain('ENG-1 "Follow up with Ana"')
    expect(res.error).toContain('ENG-42 "Follow up with Bo"')
    expect(tables.actions.map((a) => a.title)).toEqual(['Follow up with Ana', 'Follow up with Bo'])
  })

  it("acts on the sole match, a teammate's included", async () => {
    const { supabase, tables } = makeDb(seed())
    const res = await run(actionTools(supabase).update_action, { title_match: 'with bo', title: 'Renamed' })

    expect(res.success).toBe(true)
    expect(tables.actions.find((a) => a.id === 'a-teammate')!.title).toBe('Renamed')
  })
})

describe('attachments — workspace-wide, but only as visible as their capture', () => {
  const attachmentSeed = () => ({
    captures: [
      { id: 'cap-shared', workspace_id: WS, user_id: TEAMMATE, visibility: 'workspace', is_eval: false },
      { id: 'cap-private', workspace_id: WS, user_id: TEAMMATE, visibility: 'private', is_eval: false },
      { id: 'cap-mine', workspace_id: WS, user_id: ME, visibility: 'private', is_eval: false },
    ],
    attachments: [
      { id: 'f-action', workspace_id: WS, user_id: TEAMMATE, note_id: null, action_id: 'a-teammate', file_extension: 'pdf', storage_path: 'x/f-action.pdf' },
      { id: 'f-shared', workspace_id: WS, user_id: TEAMMATE, note_id: 'cap-shared', action_id: null, file_extension: 'pdf', storage_path: 'x/f-shared.pdf' },
      { id: 'f-private', workspace_id: WS, user_id: TEAMMATE, note_id: 'cap-private', action_id: null, file_extension: 'pdf', storage_path: 'x/f-private.pdf' },
      { id: 'f-mine', workspace_id: WS, user_id: ME, note_id: 'cap-mine', action_id: null, file_extension: 'pdf', storage_path: 'x/f-mine.pdf' },
    ],
  })

  it("lists a teammate's files on an action and on a shared capture, never on their private capture", async () => {
    const { supabase } = makeDb(attachmentSeed())
    const tools = createAttachmentTools(ME, supabase, WS)
    const onAction = await run(tools.list_attachments, { action_id: 'a-teammate' })
    const onShared = await run(tools.list_attachments, { capture_id: 'cap-shared' })
    const onPrivate = await run(tools.list_attachments, { capture_id: 'cap-private' })
    const onMine = await run(tools.list_attachments, { capture_id: 'cap-mine' })

    expect(onAction.attachments?.map((a) => a.id)).toEqual(['f-action'])
    expect(onShared.attachments?.map((a) => a.id)).toEqual(['f-shared'])
    expect(onPrivate.attachments).toEqual([])
    expect(onMine.attachments?.map((a) => a.id)).toEqual(['f-mine'])
  })

  it("hides even the caller's own private capture's files when private captures are omitted", async () => {
    const { supabase } = makeDb(attachmentSeed())
    const res = await run(createAttachmentTools(ME, supabase, WS, false, true).list_attachments, { capture_id: 'cap-mine' })

    expect(res.attachments).toEqual([])
  })

  it("get_attachment_content opens a teammate's shared file but not one on their private capture", async () => {
    const { supabase } = makeDb(attachmentSeed())
    const tools = createAttachmentTools(ME, supabase, WS)
    const shared = await run(tools.get_attachment_content, { attachment_id: 'f-shared' })
    const priv = await run(tools.get_attachment_content, { attachment_id: 'f-private' })

    expect(shared.success).toBe(true)
    expect(priv).toEqual({ success: false, error: 'Attachment not found' })
  })
})
