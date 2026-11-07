/**
 * Every list/get result is WORKSPACE-QUALIFIED.
 *
 * The id-addressable tools resolve cross-workspace (resolveEntityWorkspace), and
 * `find` / `search` / `list_recent_captures` already fan out across every
 * workspace the user belongs to — so a row an agent is holding may well not be
 * from the session's active workspace. Until now most list/get payloads named no
 * workspace at all, which left "the active one" as the only available inference
 * and made a wrong-tenant follow-up write the natural failure mode.
 *
 * Each row (or, for a single-entity get, the entity) therefore carries its own
 * `workspace_id`. `workspace_name` is NOT added: the MCP envelope carries the
 * active workspace's name on every response, and the cross-workspace search
 * paths already carry names for the rows they merge.
 *
 * Sibling coverage: list_actions in actions.list.test.ts, get_action and the
 * identifier routing in actions.workspace-routing.test.ts, claims in
 * claims.cross-workspace.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createDocumentTools } from '../documents'
import { createProjectTools } from '../projects'
import { createCaptureTools } from '../captures'

const USER_ID = 'user-1'
const WS_ID = 'ws-1'
const WS_OTHER = 'ws-2'

const EXEC = {
  toolCallId: 'c',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/**
 * Table-aware chainable double. `.eq()` / `.in()` become real predicates — the
 * cross-workspace gets below depend on resolveEntityWorkspace's fast path
 * genuinely MISSING in the active workspace — and every other builder method
 * continues the chain untouched. Rows come back from an await (list reads) or
 * from `.single()` / `.maybeSingle()` (single-row reads).
 */
function client(tables: Record<string, Row[]>) {
  const from = vi.fn((table: string) => {
    const all = tables[table] ?? []
    const preds: Array<(r: Row) => boolean> = []
    const rows = () => all.filter((r) => preds.every((p) => p(r)))
    let proxy: Record<string, unknown>
    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val)
        return proxy
      },
      in: (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(r[col]))
        return proxy
      },
      single: async () => {
        const found = rows()[0]
        return { data: found ?? null, error: found ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const data = rows()
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })
  return { from } as never
}

const run = (t: { execute?: unknown }, args: Record<string, unknown> = {}) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, EXEC)

describe('documents', () => {
  it('list_documents tags every row with its own workspace_id', async () => {
    const supabase = client({
      document: [
        { id: 'd-1', workspace_id: WS_ID, title: 'Spec', project_id: null, status: 'draft', kind: 'doc', visibility: 'workspace', is_pinned: false, created_at: null, updated_at: null, project: null, author: null },
      ],
    })
    const res = await run(createDocumentTools(USER_ID, supabase, WS_ID).list_documents, { limit: 20 })

    expect(res.success).toBe(true)
    expect((res.documents as Row[])[0].workspace_id).toBe(WS_ID)
  })

  it('get_document returns workspace_id as a FIELD, not just inside the hint prose', async () => {
    // The row lives in ws-2: resolveEntityWorkspace's fast path misses, the
    // anywhere-lookup finds it, and the membership probe passes.
    const supabase = client({
      document: [{ id: 'd-9', workspace_id: WS_OTHER, title: 'Foreign spec', content: '', tags: [], frontmatter: {}, project: null, author: null }],
      member: [{ id: 'm-1', user_id: USER_ID, workspace_id: WS_OTHER }],
      entity_link: [],
    })
    const res = await run(createDocumentTools(USER_ID, supabase, WS_ID).get_document, { document_id: 'd-9' })

    expect(res.success).toBe(true)
    expect((res.document as Row).workspace_id).toBe(WS_OTHER)
    // The prose hint is still there for the agent to read.
    expect(res.workspace_hint).toContain(WS_OTHER)
  })
})

describe('projects', () => {
  it('list_projects tags every row with its own workspace_id', async () => {
    const supabase = client({
      projects: [
        { id: 'p-1', workspace_id: WS_ID, user_id: USER_ID, is_archived: false, name: 'Atlas', description: null, status: 'active', start_date: null, target_date: null, is_pinned: false, lead: null, initiative: null },
      ],
      actions: [],
      milestone: [],
    })
    const res = await run(createProjectTools(USER_ID, supabase, WS_ID).list_projects, {})

    expect(res.success).toBe(true)
    expect((res.projects as Row[])[0].workspace_id).toBe(WS_ID)
  })

  it('get_project_context names the workspace the project actually lives in', async () => {
    const supabase = client({
      projects: [{ id: 'p-9', workspace_id: WS_OTHER, name: 'Foreign', description: null, status: 'active', start_date: null, target_date: null }],
      member: [{ id: 'm-1', user_id: USER_ID, workspace_id: WS_OTHER }],
      captures: [],
      milestone: [],
      actions: [],
    })
    const res = await run(createProjectTools(USER_ID, supabase, WS_ID).get_project_context, { project_id: 'p-9' })

    expect(res.success).toBe(true)
    expect((res.project as Row).workspace_id).toBe(WS_OTHER)
  })
})

describe('captures', () => {
  it('list_captures tags every row with its own workspace_id', async () => {
    const supabase = client({
      captures: [
        { id: 'c-1', workspace_id: WS_ID, project_id: null, title: 'Standup', content: 'hi', transcript: null, duration_seconds: 60, tags: [], is_pinned: false, started_at: null, ended_at: null, created_at: null },
      ],
    })
    const res = await run(createCaptureTools(USER_ID, supabase, WS_ID).list_captures, { limit: 50 })

    expect(res.success).toBe(true)
    expect((res.captures as Row[])[0].workspace_id).toBe(WS_ID)
  })

  it('get_capture_content reports the workspace the read was routed to', async () => {
    const supabase = client({
      // One fixture row answers all three captures reads (the workspace probe,
      // the visibility re-check and the payload fetch).
      captures: [{ id: 'c-9', workspace_id: WS_OTHER, visibility: 'workspace', user_id: USER_ID, is_eval: false, title: 'Foreign call', content: '', transcript: null, summary: null, ai_summary: 'Notes', tags: [], duration_seconds: 10, started_at: null, ended_at: null, created_at: null, project_id: null }],
      member: [{ id: 'm-1', user_id: USER_ID, workspace_id: WS_OTHER }],
      capture_participant: [],
    })
    const res = await run(createCaptureTools(USER_ID, supabase, WS_ID).get_capture_content, { capture_id: 'c-9' })

    expect(res.success).toBe(true)
    expect((res.capture as Row).workspace_id).toBe(WS_OTHER)
  })
})
