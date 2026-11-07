/**
 * Create-time workspace routing for `create_package`, plus cross-workspace
 * routing for the existing-package mutates (`update_package`,
 * `add_to_package`, `remove_from_package`) via `loadPackage`.
 *
 * The package-visibility ACL (`canSee` / mig 238) is a SEPARATE fence from
 * workspace routing and must still run on whichever workspace a package
 * resolves to — the last test in this file pins that down: a package that
 * resolves cross-workspace (the caller is a member there) but isn't visible
 * to them still reads as "Package not found".
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createPackageTools } from '../packages'

const USER = 'user-1'
const OTHER_USER = 'user-2'
const WS_SESSION = 'ws-session'
const WS_OTHER = 'ws-other'
const WS_STRANGER = 'ws-stranger'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Same row-store double as routing.flows.test.ts — see its header comment. */
function makeClient(seed: Record<string, Row[]> = {}, rpc: Record<string, unknown> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))
  const inserts: Record<string, Row[]> = {}

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select'
    let payload: Row = {}
    let proxy: Record<string, unknown>
    const matching = () => tables[table].filter((r) => preds.every((p) => p(r)))

    const run = (): Row | Row[] | null => {
      if (mode === 'insert' || mode === 'upsert') {
        const row = { id: `gen-${Math.random().toString(36).slice(2, 8)}`, ...payload }
        tables[table].push(row)
        ;(inserts[table] ??= []).push(row)
        return row
      }
      if (mode === 'update') {
        const rows = matching()
        for (const r of rows) Object.assign(r, payload)
        return rows
      }
      if (mode === 'delete') {
        const rows = matching()
        tables[table] = tables[table].filter((r) => !rows.includes(r))
        return rows
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      neq: (col: string, val: unknown) => { preds.push((r) => r[col] !== val); return proxy },
      in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return proxy },
      or: () => proxy,
      order: () => proxy,
      limit: () => proxy,
      ilike: () => proxy,
      select: () => proxy,
      insert: (p: Row) => { mode = 'insert'; payload = p; return proxy },
      update: (p: Row) => { mode = 'update'; payload = p; return proxy },
      upsert: (p: Row) => { mode = 'upsert'; payload = p; return proxy },
      delete: () => { mode = 'delete'; return proxy },
      single: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = run()
        const data = Array.isArray(r) ? r : r ? [r] : []
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  const rpcFn = vi.fn(async (name: string) => ({ data: rpc[name] ?? null, error: null }))
  return { from, rpc: rpcFn, tables, inserts } as never
}

// Cast to `never`: the `ai` SDK types `execute`'s parameter from the schema's
// OUTPUT (post-default) shape, which makes zod-defaulted fields (e.g.
// `visibility`) look required even though callers may omit them — same
// workaround used throughout the existing test suite when calling `execute`
// directly, bypassing the runtime zod parse that normally fills defaults in.
const pkgArgs = (overrides: Record<string, unknown> = {}) => ({ name: 'Roadmap', ...overrides }) as never

function seeded(rpc: Record<string, unknown> = { package_editable_by: true }) {
  return makeClient(
    {
      member: [
        { id: 'm-session', user_id: USER, workspace_id: WS_SESSION, workspace: { id: WS_SESSION, name: 'Session WS' } },
        { id: 'm-other', user_id: USER, workspace_id: WS_OTHER, workspace: { id: WS_OTHER, name: 'Other WS' } },
      ],
    },
    rpc,
  )
}

describe('create_package — create-time workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member → insert carries it', async () => {
    const client = seeded()
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.create_package.execute!(pkgArgs({ workspace_id: WS_OTHER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res.success).toBe(true)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.knowledge_package?.[0]?.workspace_id).toBe(
      WS_OTHER,
    )
    expect((res.workspace as { id: string }).id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id → "Workspace not found", no insert', async () => {
    const client = seeded()
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.create_package.execute!(pkgArgs({ workspace_id: WS_STRANGER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.knowledge_package).toBeUndefined()
  })

  it("(c) policy 'explicit', ≥2 workspaces, no id → needs_workspace, no insert", async () => {
    const client = seeded()
    const tools = createPackageTools(USER, client, WS_SESSION, false, 'explicit')
    const res = (await tools.create_package.execute!(pkgArgs(), EXEC)) as Record<string, unknown>

    expect(res.error_type).toBe('needs_workspace')
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.knowledge_package).toBeUndefined()
  })

  it("(d) policy 'session', no id → session workspace, unchanged call chain", async () => {
    const client = seeded()
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.create_package.execute!(pkgArgs(), EXEC)) as Record<string, unknown>

    expect((res.workspace as { id: string }).id).toBe(WS_SESSION)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.knowledge_package?.[0]?.workspace_id).toBe(
      WS_SESSION,
    )
  })

  it('(e) strictWorkspace + explicit foreign → not found, no member probe', async () => {
    const client = seeded()
    const tools = createPackageTools(USER, client, WS_SESSION, true)
    const res = (await tools.create_package.execute!(pkgArgs({ workspace_id: WS_OTHER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    const fromMock = (client as unknown as { from: { mock: { calls: unknown[][] } } }).from
    expect(fromMock.mock.calls.some((c) => c[0] === 'member')).toBe(false)
  })
})

describe('update_package / add_to_package / remove_from_package — cross-workspace routing', () => {
  /** A workspace-visible package (so `canSee` passes on membership alone). */
  function clientWithPackage(ws: string) {
    const client = makeClient(
      {
        member: [
          { id: 'm-session', user_id: USER, workspace_id: WS_SESSION },
          { id: 'm-other', user_id: USER, workspace_id: WS_OTHER },
        ],
        knowledge_package: [
          {
            id: 'pkg-1',
            workspace_id: ws,
            name: 'Roadmap',
            slug: 'roadmap',
            description: null,
            visibility: 'workspace',
            team_id: null,
            rules: {},
            created_by: OTHER_USER,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        document: [{ id: 'doc-1', workspace_id: ws }],
      },
      { package_editable_by: true },
    )
    return client
  }

  it('update_package: foreign-but-member package routes to its own workspace', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.update_package.execute!({ package_id: 'pkg-1', name: 'Renamed' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: true, package: { name: 'Renamed' } })
  })

  it('update_package: strictWorkspace fences a foreign package_id to not-found', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION, true)
    const res = (await tools.update_package.execute!({ package_id: 'pkg-1', name: 'Renamed' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ success: false, error: 'Package not found' })
  })

  it('add_to_package: foreign-but-member package pins into its own workspace', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.add_to_package.execute!(
      { package_id: 'pkg-1', entity_type: 'document', entity_id: 'doc-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res.success).toBe(true)
    expect(
      (client as unknown as { inserts: Record<string, Row[]> }).inserts.knowledge_package_item?.[0]?.workspace_id,
    ).toBe(WS_OTHER)
  })

  it('add_to_package: strictWorkspace fences a foreign package_id to not-found', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION, true)
    const res = (await tools.add_to_package.execute!(
      { package_id: 'pkg-1', entity_type: 'document', entity_id: 'doc-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toEqual({ success: false, error: 'Package not found' })
  })

  it('remove_from_package: foreign-but-member package routes to its own workspace', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.remove_from_package.execute!(
      { package_id: 'pkg-1', entity_type: 'document', entity_id: 'doc-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toEqual({ success: true })
  })

  it('remove_from_package: strictWorkspace fences a foreign package_id to not-found', async () => {
    const client = clientWithPackage(WS_OTHER)
    const tools = createPackageTools(USER, client, WS_SESSION, true)
    const res = (await tools.remove_from_package.execute!(
      { package_id: 'pkg-1', entity_type: 'document', entity_id: 'doc-1' },
      EXEC,
    )) as Record<string, unknown>

    expect(res).toEqual({ success: false, error: 'Package not found' })
  })

  it('the visibility ACL still rejects an invisible package even when it resolves cross-workspace', async () => {
    // The caller IS a member of WS_OTHER (resolveEntityWorkspace succeeds),
    // but the package is personal and owned by someone else with no share —
    // canSee must still reject it, same as a package in the caller's own
    // workspace that they can't see.
    const client = makeClient(
      {
        member: [{ id: 'm-other', user_id: USER, workspace_id: WS_OTHER }],
        knowledge_package: [
          {
            id: 'pkg-secret',
            workspace_id: WS_OTHER,
            name: 'Secret plan',
            slug: 'secret-plan',
            description: null,
            visibility: 'personal',
            team_id: null,
            rules: {},
            created_by: OTHER_USER,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        knowledge_package_share: [],
        team_member: [],
      },
      { package_editable_by: true },
    )
    const tools = createPackageTools(USER, client, WS_SESSION)
    const res = (await tools.update_package.execute!({ package_id: 'pkg-secret', name: 'Renamed' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ success: false, error: 'Package not found' })
  })
})
