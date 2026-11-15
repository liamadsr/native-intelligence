/**
 * POST /api/internal/skill-run/tool: a row or contact fire's forced reads
 * (run-skill.ts fireSubjectReadRefusal). The token's `contactId` adds
 * get_contact to a skill scoped away from contacts, held to that one contact:
 * a call naming another is refused model-visibly and never dispatches; the
 * one that fired the run is read. A skill that reads contacts on its own is
 * untouched. The row fire's `recordTableId` keeps working the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))

const SECRET = 'test-internal-secret-abcdefghij'
const recipeConfig: { current: unknown } = { current: { enabled_tools: ['emails'] } }

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit', 'in', 'is', 'order']) c[m] = () => c
      c.maybeSingle = async () =>
        table === 'workspace' ? { data: { settings: {} }, error: null } : { data: { agent_config: recipeConfig.current }, error: null }
      c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return c
    }
    return { from: (table: string) => chain(table), rpc: async () => ({ data: null, error: null }) }
  },
}))

const executeSpy = vi.fn(async () => ({ success: true }))
const stubTool = { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy }
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ get_contact: stubTool, query_rows: stubTool, get_table: stubTool, list_emails: stubTool }),
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

const CONTACT = '55555555-5555-4555-8555-555555555555'
const OTHER = '66666666-6666-4666-8666-666666666666'
const TABLE = '33333333-3333-4333-8333-333333333333'

function toolReq(token: string, toolName: string, input: unknown) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input }),
  })
}

const token = (extra: Record<string, unknown>) =>
  mintRunToken({ workspaceId: 'ws-1', runAsUserId: 'user-1', skillId: 'skill-1', mode: 'report', hasCapture: false, outputContract: 'prose', model: 'm', ...extra })

describe('a contact fire’s forced read at the tool route', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    recipeConfig.current = { enabled_tools: ['emails'] }
    executeSpy.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('reads the contact that fired the run', async () => {
    const res = await POST(toolReq(token({ contactId: CONTACT }), 'get_contact', { contact_id: CONTACT }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses another contact, an email or a name, model-visibly, and never dispatches', async () => {
    for (const input of [{ contact_id: OTHER }, { email: 'someone@acme.example' }, { name: 'Rowan Pike' }]) {
      const res = await POST(toolReq(token({ contactId: CONTACT }), 'get_contact', input))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.output).toMatchObject({ success: false, code: 'CONTACT_OUT_OF_RUN' })
      expect(body.output.error).toContain(CONTACT)
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('without the claim, get_contact is outside a skill scoped away from contacts', async () => {
    const res = await POST(toolReq(token({}), 'get_contact', { contact_id: CONTACT }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('a skill that reads contacts on its own reads any contact, as it always did', async () => {
    recipeConfig.current = { enabled_tools: ['contacts'] }
    const res = await POST(toolReq(token({ contactId: CONTACT }), 'get_contact', { contact_id: OTHER }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('a contact fire opens no table, and a row fire still reads only its own table', async () => {
    const tables = await POST(toolReq(token({ contactId: CONTACT }), 'query_rows', { table: TABLE }))
    expect(tables.status).toBe(403)
    const own = await POST(toolReq(token({ recordTableId: TABLE }), 'query_rows', { table: TABLE }))
    expect(own.status).toBe(200)
    const other = await POST(toolReq(token({ recordTableId: TABLE }), 'query_rows', { table: 'Salaries' }))
    expect((await other.json()).output).toMatchObject({ success: false, code: 'TABLE_OUT_OF_RUN' })
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })
})
