/**
 * `dial8_search_tools` and `dial8_call_tool` — the two tools that make a stale
 * catalog survivable.
 *
 * The claim under test is the one from the incident: a client whose tool list
 * was fetched before a tool existed can still FIND it (search) and CALL it
 * (dispatch), because neither of those two names ever changes.
 *
 * And the one thing that must not slip: the guard classifies by REGISTERED
 * name and `call_tool` is allowed under a read-only token, so the dispatcher
 * itself has to refuse a write. That check is asserted through the real guard,
 * not around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { registerDiscoveryTools } from '../discovery'
import { MCP_IMAGE_NOT_SENT } from '../envelope'
import { installMcpGuard, type McpAuditFn } from '../../guard'
import { catalogFingerprint } from '../../catalog'

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

/** Records what was registered and lets a test call it, like the SDK would. */
function fakeServer() {
  const handlers = new Map<string, Handler>()
  const descriptions = new Map<string, string>()
  const server = {
    tool(name: string, description: string, _shape: unknown, cb: Handler) {
      handlers.set(name, cb)
      descriptions.set(name, description)
    },
  }
  return { server, handlers, descriptions }
}

const ACTIVE = { id: 'ws-1', name: 'Native Intelligence' }

/** A bridged surface: one read tool, one write tool, one with no execute. */
function aiToolsFixture(execute = vi.fn(async () => ({ success: true, companies: [] }))) {
  return {
    list_companies: {
      description: 'List the companies in the CRM.',
      inputSchema: z.object({ search: z.string().optional().describe('Name or domain.') }),
      execute,
    },
    create_company: {
      description: 'Create a company in the CRM.',
      inputSchema: z.object({ name: z.string() }),
      execute: vi.fn(async () => ({ success: true, company: { id: 'co-1' } })),
    },
    // No execute — the AI-SDK client-resolved tool. Never dispatchable.
    ask_user: { description: 'Ask the user a question.', inputSchema: z.object({}) },
  }
}

function build(opts: { readOnly?: boolean; audit?: McpAuditFn; aiTools?: object } = {}) {
  const { server, handlers, descriptions } = fakeServer()
  const aiTools = opts.aiTools ?? aiToolsFixture()
  // The guard goes on FIRST, exactly as registerTools installs it, so these
  // tests exercise the same wrapping production does.
  installMcpGuard(server as never, { readOnly: opts.readOnly ?? false, audit: opts.audit })
  registerDiscoveryTools(server as never, {
    aiTools: aiTools as Record<string, unknown>,
    exposedNames: ['dial8_list_companies', 'dial8_create_company', 'dial8_search_tools', 'dial8_call_tool'],
    readOnly: opts.readOnly ?? false,
    active: ACTIVE,
    audit: opts.audit,
  })
  const call = async (tool: string, args: Record<string, unknown>) => {
    const handler = handlers.get(tool)
    if (!handler) throw new Error(`${tool} was not registered`)
    const res = await handler(args)
    return { raw: res, body: JSON.parse(res.content[0].text) as Record<string, never> }
  }
  return { call, handlers, descriptions, aiTools }
}

const STAMP = {
  version: catalogFingerprint([
    'dial8_list_companies',
    'dial8_create_company',
    'dial8_search_tools',
    'dial8_call_tool',
  ]),
  tool_count: 4,
}

describe('registration', () => {
  it('registers both tools under names that must never change', () => {
    const { handlers } = build()
    expect([...handlers.keys()].sort()).toEqual(['dial8_call_tool', 'dial8_search_tools'])
  })
})

describe('dial8_search_tools', () => {
  it('lists categories when asked for nothing', async () => {
    const { call } = build()
    const { body } = await call('dial8_search_tools', {})
    expect(Array.isArray(body.categories)).toBe(true)
    expect(body.catalog).toEqual(STAMP)
  })

  it('finds a tool by topic and returns the name you must invoke', async () => {
    const { call } = build()
    const { body } = await call('dial8_search_tools', { query: 'companies' })
    const names = (body.tools as unknown as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('dial8_list_companies')
    expect(body.catalog).toEqual(STAMP)
  })

  it('returns the full argument schema for an exact name, prefixed or bare', async () => {
    const { call } = build()
    for (const name of ['list_companies', 'dial8_list_companies']) {
      const { body } = await call('dial8_search_tools', { name })
      expect(body.found).toBe(true)
      const tool = body.tool as unknown as {
        name: string
        access: string
        input_schema: { properties: Record<string, unknown> }
      }
      expect(tool.name).toBe('dial8_list_companies')
      expect(tool.access).toBe('read')
      expect(Object.keys(tool.input_schema.properties)).toEqual(['search'])
    }
  })

  it('answers an unknown name with near misses and the stale-catalog hint', async () => {
    const { call } = build()
    const { body } = await call('dial8_search_tools', { name: 'list_company' })
    expect(body.found).toBe(false)
    expect(body.closest).toContain('dial8_list_companies')
    expect(body.hint).toContain('reconnect')
  })

  it('never advertises a write tool to a read-only token', async () => {
    const { call } = build({ readOnly: true })
    const { body } = await call('dial8_search_tools', { query: 'companies' })
    const names = (body.tools as unknown as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('dial8_list_companies')
    expect(names).not.toContain('dial8_create_company')

    const exact = await call('dial8_search_tools', { name: 'create_company' })
    expect(exact.body.tool).toMatchObject({ available_to_this_token: false })
  })
})

describe('dial8_call_tool', () => {
  it('invokes the tool and returns what a direct call would, workspace stamp included', async () => {
    const execute = vi.fn(async () => ({ success: true, companies: [{ id: 'co-1' }] }))
    const { call } = build({ aiTools: aiToolsFixture(execute) })

    const { body } = await call('dial8_call_tool', {
      name: 'dial8_list_companies',
      input: { search: 'van' },
    })

    expect(execute).toHaveBeenCalledWith({ search: 'van' }, {})
    expect(body).toMatchObject({ success: true, active_workspace: ACTIVE })
  })

  it('leaves out an image a tool returns (read_chat_file on a photo), with a note: never base64 text to the client', async () => {
    const execute = vi.fn(async () => ({ success: true, file_name: 'a.png', __imageBase64: 'QUJD', __imageMimeType: 'image/jpeg' }))
    const { call } = build({ aiTools: aiToolsFixture(execute as never) })
    const { raw, body } = await call('dial8_call_tool', { name: 'dial8_list_companies', input: {} })
    expect(body).toEqual({ success: true, file_name: 'a.png', image: MCP_IMAGE_NOT_SENT, active_workspace: ACTIVE })
    expect(JSON.stringify(raw)).not.toContain('QUJD')
  })

  /*
   * The audit row's `target_workspace_id` (mig 271) is the only record that a
   * dispatched write crossed a tenant boundary — so the dispatcher has to pull
   * it out of the result the SAME way a direct call does (targetWorkspaceOf),
   * before anything stringifies the result, and hand it to audit as the 5th
   * arg AND stamp it onto the returned content for installMcpGuard to read
   * back on a direct call. See guard.audit-target-workspace.test.ts.
   */
  it('passes the target workspace from a create-echoed result to audit', async () => {
    const audit = vi.fn()
    const execute = vi.fn(async () => ({ success: true, workspace: { id: 'ws-target', name: 'Beta' } }))
    const { call } = build({ audit, aiTools: aiToolsFixture(execute as never) })

    await call('dial8_call_tool', { name: 'dial8_list_companies' })

    expect(audit).toHaveBeenCalledWith(
      'dial8_call_tool:list_companies',
      true,
      expect.any(Number),
      undefined,
      'ws-target',
    )
  })

  it('takes a bare name and a tool with no arguments', async () => {
    const execute = vi.fn(async () => ({ success: true }))
    const { call } = build({ aiTools: aiToolsFixture(execute) })
    await call('dial8_call_tool', { name: 'list_companies' })
    expect(execute).toHaveBeenCalledWith({}, {})
  })

  /*
   * The suggestion list IS the recovery path — a stale client reads it when
   * the tool it wanted is missing. "list_prospects" first suggested
   * list_actions and list_labels, because every list_* tool matched on the
   * word "list", which reads as "prospects don't exist here".
   */
  it('suggests by the meaningful word, not by the verb every tool shares', async () => {
    const { call } = build({
      aiTools: {
        list_prospect_lists: { description: 'Prospect lists.', inputSchema: z.object({}), execute: vi.fn() },
        list_prospect_entries: { description: 'Prospect entries.', inputSchema: z.object({}), execute: vi.fn() },
        list_actions: { description: 'Actions.', inputSchema: z.object({}), execute: vi.fn() },
        list_labels: { description: 'Labels.', inputSchema: z.object({}), execute: vi.fn() },
      },
    })
    const { body } = await call('dial8_call_tool', { name: 'list_prospects' })
    expect(body.closest as unknown as string[]).toEqual([
      'dial8_list_prospect_lists',
      'dial8_list_prospect_entries',
    ])
  })

  it('answers an unknown name with near misses, the stamp and the hint — never a bare failure', async () => {
    const { call } = build()
    const { body } = await call('dial8_call_tool', { name: 'list_prospects' })
    expect(body.error_type).toBe('unknown_tool')
    expect(body.catalog).toEqual(STAMP)
    expect(body.hint).toContain('reconnect')
    expect(body.active_workspace).toEqual(ACTIVE)
  })

  /*
   * The guard lets `call_tool` through for a read-only token on purpose (it is
   * in READ_ALLOWED_WRITES) — otherwise a read-only session loses the one tool
   * that reaches anything missing from its catalog. Which makes the check
   * inside the dispatcher the only thing standing between that token and a
   * write. Assert it through the real guard: read passes, write is refused.
   */
  it('refuses a write to a read-only token THROUGH the dispatcher', async () => {
    const audit = vi.fn()
    const aiTools = aiToolsFixture()
    const { call } = build({ readOnly: true, audit, aiTools })

    const blocked = await call('dial8_call_tool', { name: 'create_company', input: { name: 'X' } })
    expect(blocked.raw.isError).toBe(true)
    expect(blocked.body.error_type).toBe('forbidden')
    expect(aiTools.create_company.execute).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith('dial8_call_tool:create_company', false, 0, 'forbidden_read_only')

    // …and the read still works, which is the reason the guard was opened.
    const allowed = await call('dial8_call_tool', { name: 'list_companies' })
    expect(allowed.body).toMatchObject({ success: true })
  })

  it('audits under the INNER name, so direct and dispatched calls stay countable apart', async () => {
    const audit = vi.fn()
    const { call } = build({ audit })
    await call('dial8_call_tool', { name: 'list_companies' })
    const names = audit.mock.calls.map((c) => c[0])
    expect(names).toContain('dial8_call_tool:list_companies')
  })

  it('refuses to dispatch itself, or anything without an execute', async () => {
    const { call } = build()
    for (const name of ['call_tool', 'search_tools', 'ask_user']) {
      const { body } = await call('dial8_call_tool', { name })
      expect(body.error_type, name).toBe('unknown_tool')
    }
  })

  it('validates input against the tool schema before executing, like a direct call', async () => {
    const audit = vi.fn()
    const aiTools = aiToolsFixture()
    const { call } = build({ audit, aiTools })

    const bad = await call('dial8_call_tool', { name: 'create_company', input: { name: 42 } })
    expect(bad.raw.isError).toBe(true)
    expect(bad.body.error_type).toBe('invalid_input')
    expect(aiTools.create_company.execute).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith('dial8_call_tool:create_company', false, 0, 'invalid_input')

    // The parsed value (unknown keys stripped) is what reaches execute.
    await call('dial8_call_tool', { name: 'create_company', input: { name: 'Acme', junk: true } })
    expect(aiTools.create_company.execute).toHaveBeenCalledWith({ name: 'Acme' }, {})
  })

  it('reports a throwing tool as a categorised error, not a crash', async () => {
    const execute = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const { call } = build({ aiTools: aiToolsFixture(execute) })
    const { raw, body } = await call('dial8_call_tool', { name: 'list_companies' })
    expect(raw.isError).toBe(true)
    expect(body).toMatchObject({ error_type: 'network_error', retryable: true })
  })
})
