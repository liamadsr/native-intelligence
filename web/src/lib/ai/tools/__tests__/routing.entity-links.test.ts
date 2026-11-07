/**
 * Cross-workspace routing for `unlink_entities` — it now resolves the
 * SOURCE entity's own workspace via resolveEntityWorkspace instead of
 * deleting scoped to the session workspace only.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createEntityLinkTools } from '../entity-links'

const USER = 'user-1'
const WS_SESSION = 'ws-session'
const WS_OTHER = 'ws-other'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Same row-store double as routing.flows.test.ts — see its header comment. */
function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'delete' = 'select'
    let proxy: Record<string, unknown>
    const matching = () => tables[table].filter((r) => preds.every((p) => p(r)))

    const run = (): Row[] => {
      if (mode === 'delete') {
        const rows = matching()
        tables[table] = tables[table].filter((r) => !rows.includes(r))
        return rows
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      delete: () => { mode = 'delete'; return proxy },
      maybeSingle: async () => {
        const rows = matching()
        return { data: rows[0] ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const rows = run()
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  return { from, tables } as never
}

describe('unlink_entities — cross-workspace source routing', () => {
  it('routes a foreign-but-member source entity to its own workspace and deletes there', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
      entity_link: [
        { id: 'link-1', workspace_id: WS_OTHER, source_type: 'document', source_id: 'doc-1', target_type: 'action', target_id: 'act-1', relation: 'references' },
      ],
    })
    const tools = createEntityLinkTools(USER, client, WS_SESSION)
    const res = (await tools.unlink_entities.execute!(
      { source_type: 'document', source_id: 'doc-1', target_type: 'action', target_id: 'act-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toMatchObject({ success: true, deleted_count: 1 })
    expect((client as unknown as { tables: Record<string, Row[]> }).tables.entity_link).toHaveLength(0)
  })

  it('strictWorkspace fences a foreign source entity to not-found (no delete)', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
      entity_link: [
        { id: 'link-1', workspace_id: WS_OTHER, source_type: 'document', source_id: 'doc-1', target_type: 'action', target_id: 'act-1', relation: 'references' },
      ],
    })
    const tools = createEntityLinkTools(USER, client, WS_SESSION, true)
    const res = (await tools.unlink_entities.execute!(
      { source_type: 'document', source_id: 'doc-1', target_type: 'action', target_id: 'act-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toEqual({ success: false, error: 'Source entity not found' })
    expect((client as unknown as { tables: Record<string, Row[]> }).tables.entity_link).toHaveLength(1)
  })

  it('a source type with no direct workspace column (e.g. cycle) falls back to the session workspace, unchanged', async () => {
    const client = makeClient({
      entity_link: [
        { id: 'link-1', workspace_id: WS_SESSION, source_type: 'cycle', source_id: 'cyc-1', target_type: 'action', target_id: 'act-1', relation: 'references' },
      ],
    })
    const tools = createEntityLinkTools(USER, client, WS_SESSION)
    const res = (await tools.unlink_entities.execute!(
      { source_type: 'cycle', source_id: 'cyc-1', target_type: 'action', target_id: 'act-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toMatchObject({ success: true, deleted_count: 1 })
  })
})
