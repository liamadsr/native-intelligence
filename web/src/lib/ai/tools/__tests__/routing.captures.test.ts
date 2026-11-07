/**
 * Create-time workspace routing for the CAPTURE family (captures.ts).
 *
 * `create_capture` is a ROOT create whose DEPENDENT LOOKUP is the one that
 * bites: with no `project_id` it picks the user's default project, and that
 * lookup was pinned to the session workspace. Routing the insert alone would
 * file a meeting in another tenant under a project id from this one — a
 * cross-workspace FK, and a capture nobody in the target workspace can open
 * from its project. So the target is resolved FIRST and the default-project
 * lookup re-pointed at it.
 *
 * `list_contact_captures` is the other half: `contact_id` is a caller-supplied
 * id, so it now ROUTES (a contact the user can see in another workspace is
 * answerable by id) and every query below it — the contact read, the embedded
 * `capture.workspace_id` filter, and the defence-in-depth TS check — is scoped
 * to the CONTACT's workspace rather than the session's.
 *
 * Deliberately unchanged: `list_captures`' `project_id` is a FILTER inside a
 * list whose scope is the active workspace (omit it and you get the whole
 * workspace), not an anchor, so it keeps the active-workspace default.
 *
 * The Supabase double mirrors routing.projects.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCaptureTools } from '../captures'

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_STRANGER = 'ws-nope'

const EXEC = {
  toolCallId: 'c',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Query = { table: string; op: 'select' | 'insert' | 'update' | 'delete'; eq: Record<string, unknown> }

function valueAt(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Row)[k] : undefined), row)
}

/** See routing.projects.test.ts for the annotated version of this double. */
function client(tables: Record<string, Row[]>, hiddenContacts: string[] = []) {
  const queries: Query[] = []
  const inserts: Array<{ table: string; values: Row[] }> = []
  const updates: Array<{ table: string; values: Row }> = []

  const from = vi.fn((table: string) => {
    const q: Query = { table, op: 'select', eq: {} }
    queries.push(q)
    const preds: Array<(r: Row) => boolean> = []
    const matching = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
    let written: Row[] = []
    let proxy: Record<string, unknown>

    const result = () => {
      if (q.op === 'insert') return written
      if (q.op === 'update') return matching().map((r) => Object.assign(r, written[0]))
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        q.eq[col] = val
        preds.push((r) => valueAt(r, col) === val)
        return proxy
      },
      neq: (col: string, val: unknown) => {
        preds.push((r) => valueAt(r, col) !== val)
        return proxy
      },
      in: (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(valueAt(r, col)))
        return proxy
      },
      ilike: (col: string, pattern: string) => {
        const needle = pattern.replace(/%/g, '').toLowerCase()
        preds.push((r) => String(valueAt(r, col) ?? '').toLowerCase().includes(needle))
        return proxy
      },
      insert: (values: Row | Row[]) => {
        q.op = 'insert'
        const list = (Array.isArray(values) ? values : [values]).map((v, i) => ({
          id: `${table}-new-${i}`,
          ...v,
        }))
        inserts.push({ table, values: list })
        ;(tables[table] ??= []).push(...list)
        written = list
        return proxy
      },
      update: (values: Row) => {
        q.op = 'update'
        updates.push({ table, values })
        written = [values]
        return proxy
      },
      delete: () => {
        q.op = 'delete'
        return proxy
      },
      single: async () => {
        const found = result()[0]
        return { data: found ?? null, error: found ? null : { message: 'No rows found' } }
      },
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: result(), error: null }).then(resolve),
    }

    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  // contact_visible_to: visible unless listed in hiddenContacts.
  const rpc = vi.fn(async (_fn: string, args: { p_contact_id: string }) => ({
    data: !hiddenContacts.includes(args.p_contact_id),
    error: null,
  }))
  return { supabase: { from, rpc } as never, queries, inserts, updates }
}

const member = (workspaceId: string, name: string): Row => ({
  id: `member-${workspaceId}`,
  user_id: USER_ID,
  workspace_id: workspaceId,
  workspace: { id: workspaceId, name },
})

const MEMBER_OF_BOTH = [member(WS_ACTIVE, 'Marketing'), member(WS_OTHER, 'Engineering')]

/** A default project in each workspace — routing must pick the right one. */
const PROJECTS: Row[] = [
  { id: 'p-active', workspace_id: WS_ACTIVE, user_id: USER_ID, is_archived: false, name: 'Inbox (Marketing)' },
  { id: 'p-other', workspace_id: WS_OTHER, user_id: USER_ID, is_archived: false, name: 'Inbox (Engineering)' },
]

const run = (t: { execute?: unknown }, args: Record<string, unknown> = {}) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, EXEC)

const tools = (
  supabase: never,
  opts: { strict?: boolean; policy?: 'session' | 'explicit' } = {},
) =>
  createCaptureTools(USER_ID, supabase, WS_ACTIVE, undefined, opts.strict ?? false, false, opts.policy ?? 'session')

describe('create_capture — create-time workspace routing', () => {
  it('routes an explicit foreign workspace_id, and picks the default project THERE', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH], projects: [...PROJECTS] })

    const res = await run(tools(supabase).create_capture, { title: 'Standup', workspace_id: WS_OTHER })

    expect(res.success).toBe(true)
    const inserted = inserts.find((i) => i.table === 'captures')
    expect(inserted?.values[0].workspace_id).toBe(WS_OTHER)
    // The dependent lookup is filtered on the target, so the capture is filed
    // under a project the target workspace actually owns.
    const projectRead = queries.find((q) => q.table === 'projects')
    expect(projectRead?.eq.workspace_id).toBe(WS_OTHER)
    expect(inserted?.values[0].project_id).toBe('p-other')
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
  })

  it('refuses an explicit workspace the caller is NOT a member of, and inserts nothing', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH], projects: [...PROJECTS] })

    const res = await run(tools(supabase).create_capture, { title: 'Standup', workspace_id: WS_STRANGER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
    // The refusal comes BEFORE the default-project lookup, so a rejected target
    // cannot even probe for projects.
    expect(queries.some((q) => q.table === 'projects')).toBe(false)
  })

  it("policy 'explicit' with several workspaces and no workspace_id asks instead of guessing", async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH], projects: [...PROJECTS] })

    const res = await run(tools(supabase, { policy: 'explicit' }).create_capture, { title: 'Standup' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
    ])
    expect(inserts).toHaveLength(0)
  })

  it("policy 'session' with no workspace_id keeps the old chain: default project in the session workspace, then insert", async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH], projects: [...PROJECTS] })

    const res = await run(tools(supabase).create_capture, { title: 'Standup' })

    expect(res.success).toBe(true)
    expect(queries.map((q) => q.table)).toEqual(['projects', 'captures'])
    expect(queries[0].eq.workspace_id).toBe(WS_ACTIVE)
    expect(inserts[0].values[0]).toMatchObject({ workspace_id: WS_ACTIVE, project_id: 'p-active' })
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })

  it('under strictWorkspace a foreign workspace_id is not-found, with no membership probe at all', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH], projects: [...PROJECTS] })

    const res = await run(tools(supabase, { strict: true }).create_capture, {
      title: 'Standup',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
    expect(queries.some((q) => q.table === 'member')).toBe(false)
  })
})

describe('list_contact_captures — routed by the contact', () => {
  const fixture = (hiddenContacts: string[] = []) =>
    client({
      contact: [{ id: 'ct-9', workspace_id: WS_OTHER, full_name: 'Dana Lin' }],
      member: [...MEMBER_OF_BOTH],
      capture_participant: [
        {
          contact_id: 'ct-9',
          speaker_label: 'Speaker 1',
          voice_match_confidence: 0.9,
          capture: {
            id: 'cap-1',
            workspace_id: WS_OTHER,
            user_id: USER_ID,
            visibility: 'workspace',
            is_eval: false,
            title: 'Discovery call',
            ai_summary: null,
            started_at: null,
            ended_at: null,
            duration_seconds: 900,
            status: 'ready',
          },
        },
      ],
    }, hiddenContacts)

  it('answers for a contact in another workspace the user belongs to, scoped to THAT workspace', async () => {
    const { supabase, queries } = fixture()

    const res = await run(tools(supabase).list_contact_captures, { contact_id: 'ct-9' })

    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    expect(res.workspace_id).toBe(WS_OTHER)
    // The embedded capture filter follows the contact rather than the session.
    const participantRead = queries.find((q) => q.table === 'capture_participant')
    expect(participantRead?.eq['capture.workspace_id']).toBe(WS_OTHER)
  })

  it("is not-found for another member's private contact (service role: contact_visible_to)", async () => {
    const { supabase, queries } = fixture(['ct-9'])

    const res = await run(tools(supabase).list_contact_captures, { contact_id: 'ct-9' })

    expect(res).toEqual({ success: false, error: 'Contact not found in this workspace' })
    expect(queries.some((q) => q.table === 'capture_participant')).toBe(false)
  })

  it('is not-found for that same contact under strictWorkspace', async () => {
    const { supabase, queries } = fixture()

    const res = await run(tools(supabase, { strict: true }).list_contact_captures, { contact_id: 'ct-9' })

    expect(res).toEqual({ success: false, error: 'Contact not found in this workspace' })
    expect(queries.some((q) => q.table === 'capture_participant')).toBe(false)
  })
})

describe('get_capture_content — participant contacts are fenced (service role: contact_visible_to)', () => {
  const fixture = (hiddenContacts: string[]) =>
    client(
      {
        member: [...MEMBER_OF_BOTH],
        captures: [
          {
            id: 'cap-7',
            workspace_id: WS_ACTIVE,
            user_id: USER_ID,
            visibility: 'workspace',
            is_eval: false,
            title: 'Pricing call',
            ai_summary: 'Talked pricing',
          },
        ],
        capture_participant: [
          {
            capture_id: 'cap-7',
            speaker_label: 'Speaker 1',
            contact_id: 'ct-private',
            external_name: 'Speaker from invite',
            external_email: null,
            contact: { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com', avatar_url: null },
            member: null,
          },
          {
            capture_id: 'cap-7',
            speaker_label: 'Speaker 2',
            contact_id: 'ct-shared',
            external_name: null,
            external_email: null,
            contact: { id: 'ct-shared', full_name: 'Sam Shared', email: 'sam@example.com', avatar_url: null },
            member: null,
          },
        ],
      },
      hiddenContacts,
    )

  it("never returns another member's private contact's name or email; the visible one resolves", async () => {
    const { supabase } = fixture(['ct-private'])

    const res = await run(tools(supabase).get_capture_content, { capture_id: 'cap-7' })

    expect(res.success).toBe(true)
    const participants = (res.capture as { participants: Array<Record<string, unknown>> }).participants
    expect(participants[0]).toMatchObject({ display_name: 'Speaker from invite', email: null })
    expect(participants[1]).toMatchObject({ display_name: 'Sam Shared', email: 'sam@example.com' })
    expect(JSON.stringify(res)).not.toContain('Ana Private')
    expect(JSON.stringify(res)).not.toContain('ana.p@example.com')
  })
})
