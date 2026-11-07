/**
 * Cross-workspace routing for `attach_chat_file` — it now routes by the
 * TARGET entity (the action or capture the file attaches to) via
 * resolveEntityWorkspace, instead of forcing everything into the session
 * workspace.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createAttachmentTools } from '../attachments'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = 'user-1'
const WS_SESSION = 'ws-session'
const WS_OTHER = 'ws-other'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Same row-store double as routing.flows.test.ts — see its header comment. */
function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))
  const inserts: Record<string, Row[]> = {}

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' = 'select'
    let payload: Row = {}
    let headOnly = false
    let proxy: Record<string, unknown>
    const matching = () => tables[table].filter((r) => preds.every((p) => p(r)))

    const run = (): Row | Row[] | null => {
      if (mode === 'insert') {
        const row = { id: `gen-${Math.random().toString(36).slice(2, 8)}`, ...payload }
        tables[table].push(row)
        ;(inserts[table] ??= []).push(row)
        return row
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      select: (_cols?: string, opts?: { head?: boolean; count?: string }) => {
        if (opts?.head) headOnly = true
        return proxy
      },
      insert: (p: Row) => { mode = 'insert'; payload = p; return proxy },
      maybeSingle: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: null }
      },
      single: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = run()
        const data = Array.isArray(r) ? r : r ? [r] : []
        return Promise.resolve(headOnly ? { count: data.length, error: null } : { data, error: null, count: data.length }).then(
          resolve,
        )
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  return { from, tables, inserts } as never
}

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  storage_path: `${USER}/chat-uploads/file.md`,
  file_name: 'file.md',
  file_size: 10,
  mime_type: 'text/markdown',
  ...overrides,
})

describe('attach_chat_file — routes by the target entity', () => {
  it('a foreign-but-member action_id attaches the file into the ACTION\'s own workspace', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      actions: [{ id: 'act-1', workspace_id: WS_OTHER, project_id: null }],
    })
    const tools = createAttachmentTools(USER, client, WS_SESSION)
    const res = (await tools.attach_chat_file.execute!(baseArgs({ action_id: 'act-1' }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res.success).toBe(true)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.attachments?.[0]?.workspace_id).toBe(
      WS_OTHER,
    )
  })

  it('strictWorkspace fences a foreign action_id to not-found (no attachment written)', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      actions: [{ id: 'act-1', workspace_id: WS_OTHER, project_id: null }],
    })
    const tools = createAttachmentTools(USER, client, WS_SESSION, true)
    const res = (await tools.attach_chat_file.execute!(baseArgs({ action_id: 'act-1' }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ success: false, error: 'Action not found in this workspace' })
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.attachments).toBeUndefined()
  })

  it('a foreign-but-member capture_id attaches the file into the CAPTURE\'s own workspace', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      captures: [{ id: 'cap-1', workspace_id: WS_OTHER, project_id: null }],
    })
    const tools = createAttachmentTools(USER, client, WS_SESSION)
    const res = (await tools.attach_chat_file.execute!(baseArgs({ capture_id: 'cap-1' }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res.success).toBe(true)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.attachments?.[0]?.workspace_id).toBe(
      WS_OTHER,
    )
  })

  it('strictWorkspace fences a foreign capture_id to not-found (no attachment written)', async () => {
    const client = makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
      captures: [{ id: 'cap-1', workspace_id: WS_OTHER, project_id: null }],
    })
    const tools = createAttachmentTools(USER, client, WS_SESSION, true)
    const res = (await tools.attach_chat_file.execute!(baseArgs({ capture_id: 'cap-1' }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ success: false, error: 'Capture not found in this workspace' })
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.attachments).toBeUndefined()
  })
})
