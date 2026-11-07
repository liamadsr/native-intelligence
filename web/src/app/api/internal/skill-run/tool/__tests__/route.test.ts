/**
 * Route tests for POST /api/internal/skill-run/tool — the eve skill-runner's
 * tool-dispatch trust boundary (Phase 2).
 *
 * The load-bearing invariants this asserts:
 *   1. inherit-all (null ceiling, act + all categories) permits a tool that
 *      EXISTS in the real registry — the bug where null was mishandled and either
 *      permitted any string OR (on the rebuild side) advertised nothing.
 *   2. a NON-existent tool name is rejected (404) even under inherit-all — null
 *      means "any tool that exists", never "any string".
 *   3. prototype-magic names ('__proto__', 'constructor', 'hasOwnProperty') are
 *      rejected (403) and NEVER reach tool dispatch, both under inherit-all (where
 *      the ceiling check is the one that must catch them) and a restricted ceiling.
 *
 * The REAL createTools + search_tools are mocked to a tiny spy-backed tool so we
 * can assert dispatch never fires on a rejected call. The ceiling is derived from
 * the mocked recipe's agent_config via the real computeSkillCeiling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'
import { TOOL_IMAGE_NOT_SHOWN } from '@/lib/ai/tools/tool-image'

const SECRET = 'test-internal-secret-abcdefghij'

// The recipe agent_config the mocked getServiceClient returns — swapped per test
// to drive computeSkillCeiling into inherit-all (null) vs a restricted set.
const recipeConfig: { current: unknown } = { current: { enabled_tools: [...ALL_CATEGORY_IDS] } }
// The workspace's settings row (the kill switch, A5 slice 5): a read error when `error` is set.
const workspaceRow: { settings: unknown; error: { message: string } | null } = { settings: {}, error: null }

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c
      c.maybeSingle = async () =>
        table === 'workspace'
          ? workspaceRow.error
            ? { data: null, error: workspaceRow.error }
            : { data: { settings: workspaceRow.settings }, error: null }
          : { data: { agent_config: recipeConfig.current }, error: null }
      return c
    }
    return { from: (table: string) => chain(table) }
  },
}))

// A single spy-backed tool stands in for every createTools() entry. Its execute
// is a spy so we can prove a rejected call never dispatches.
const executeSpy = vi.fn(async () => ({ ok: true }))
const stubTool = {
  description: 'stub',
  inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  execute: executeSpy,
}
// Records the options the route hands createTools (the loop-guard origin).
const createToolsOpts: { last?: unknown } = {}
vi.mock('@/lib/ai/tools', () => ({
  createTools: (..._args: unknown[]) => {
    createToolsOpts.last = _args[4]
    return { list_actions: stubTool, create_action: stubTool }
  },
}))
// Partial mock: only createSearchToolsTool is stubbed. computeSkillCeiling (via
// run-skill.ts) still needs the REAL computeToolCeiling from this module.
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

function toolReq(token: string, toolName: unknown, input: unknown = {}) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_SKILL_SECRET_HEADER]: SECRET,
      [RUN_SKILL_TOKEN_HEADER]: token,
    },
    body: JSON.stringify({ toolName, input }),
  })
}

function inheritAllToken() {
  // act mode + all categories → computeSkillCeiling returns null (inherit-all).
  return mintRunToken({
    workspaceId: 'ws-1',
    runAsUserId: 'user-1',
    skillId: 'skill-1',
    mode: 'act',
    hasCapture: false,
    outputContract: 'prose',
    model: 'claude-haiku-4-5-20251001',
  })
}

describe('POST /api/internal/skill-run/tool — ceiling + prototype-pollution safety', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    recipeConfig.current = { enabled_tools: [...ALL_CATEGORY_IDS] } // inherit-all default
    workspaceRow.settings = {}
    workspaceRow.error = null
    executeSpy.mockClear()
  })

  it('kill switch: with autonomy off, an unattended loop run gets no tool (model-visible refusal), nothing dispatches', async () => {
    workspaceRow.settings = { agent_autonomy: { mode: 'off' } }
    const res = await POST(toolReq(inheritAllToken(), 'create_action', { title: 'x' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.output).toMatchObject({ success: false, code: 'AGENT_PAUSED' })
    expect(executeSpy).not.toHaveBeenCalled()
    // Reads too: a paused loop stops, it does not keep looking around.
    const read = await POST(toolReq(inheritAllToken(), 'list_actions'))
    expect((await read.json()).output).toMatchObject({ code: 'AGENT_PAUSED' })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('kill switch: propose or attempt runs as usual, and a failed settings read fails open', async () => {
    workspaceRow.settings = { agent_autonomy: { mode: 'propose' } }
    expect((await POST(toolReq(inheritAllToken(), 'list_actions'))).status).toBe(200)
    workspaceRow.settings = {}
    workspaceRow.error = { message: 'boom' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await POST(toolReq(inheritAllToken(), 'list_actions'))).status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('[agent-paused] could not read the kill switch; continuing', expect.objectContaining({ door: 'skill_run_tool' }))
    warn.mockRestore()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('inherit-all: a real registry tool is permitted and dispatches', async () => {
    const res = await POST(toolReq(inheritAllToken(), 'list_actions'))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('an image a tool returns (read_chat_file on a photo) is stripped with a note: a run’s model never gets base64 as text', async () => {
    executeSpy.mockResolvedValueOnce({ success: true, file_name: 'a.png', __imageBase64: 'QUJD', __imageMimeType: 'image/jpeg' } as never)
    const res = await POST(toolReq(inheritAllToken(), 'list_actions'))
    expect(res.status).toBe(200)
    expect((await res.json()).output).toEqual({ success: true, file_name: 'a.png', image: TOOL_IMAGE_NOT_SHOWN })
  })

  it('inherit-all: a NONexistent tool is rejected (403 out-of-ceiling), never dispatches', async () => {
    // null ceiling means "any tool that EXISTS", not "any string" — a name that is
    // not in the registry fails the ceiling gate before the lookup.
    const res = await POST(toolReq(inheritAllToken(), 'totally_made_up_tool'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('a chat-native tool (start_helper) is out of every skill ceiling, inherit-all included', async () => {
    for (const config of [{ enabled_tools: [...ALL_CATEGORY_IDS] }, { enabled_tools: ['actions'] }]) {
      recipeConfig.current = config
      const res = await POST(toolReq(inheritAllToken(), 'start_helper', { role: 'writer', brief: { task: 'x' } }))
      expect(res.status, JSON.stringify(config)).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  for (const magic of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    it(`inherit-all: prototype-magic name '${magic}' is rejected (403), never dispatches`, async () => {
      const res = await POST(toolReq(inheritAllToken(), magic))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    })
  }

  it('restricted ceiling: prototype-magic name is rejected (403), never dispatches', async () => {
    // A skill restricted to the actions category → non-null ceiling. The Set.has
    // check already rejects prototype-magic names; this pins that too.
    recipeConfig.current = { enabled_tools: ['actions'] }
    const token = mintRunToken({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      skillId: 'skill-1',
      mode: 'act',
      hasCapture: false,
      outputContract: 'prose',
      model: 'claude-haiku-4-5-20251001',
    })
    const res = await POST(toolReq(token, '__proto__'))
    expect(res.status).toBe(403)
    expect(executeSpy).not.toHaveBeenCalled()
  })
})


describe('skill-run tool route — loop-guard origin', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it("stamps the run's status writes as an AGENT's at the depth the token carries (default 1)", async () => {
    createToolsOpts.last = undefined
    await POST(toolReq(inheritAllToken(), 'list_actions'))
    expect((createToolsOpts.last as { origin?: unknown })?.origin).toMatchObject({ actor: 'agent', depth: 1, run_id: expect.any(String) })
    // A skill run is not the main chat: its searches keep the all-time default
    // (no searchDefaultWindow, so createTools uses 'all_time').
    expect((createToolsOpts.last as { searchDefaultWindow?: unknown })?.searchDefaultWindow).toBeUndefined()
    // Nobody is watching: the actions it files arrive as suggestions (the promotion guard).
    const rules = (createToolsOpts.last as { actionRules?: { filedByRun?: unknown } })?.actionRules
    expect(rules).toMatchObject({ unattended: true, fileActionsAsSuggested: true })
    expect(typeof rules?.filedByRun).toBe('function')
    // A fire with no ledger row can't say what it filed: everything counts as
    // its own (fail closed), so it confirms none of it.
    expect(await (rules as { filedByRun: (ids: string[]) => Promise<Set<string>> }).filedByRun(['X1'])).toEqual(new Set(['x1']))

    createToolsOpts.last = undefined
    const deeper = mintRunToken({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      skillId: 'skill-1',
      mode: 'act',
      hasCapture: false,
      outputContract: 'prose',
      model: 'm',
      originDepth: 2,
    })
    await POST(toolReq(deeper, 'list_actions'))
    expect((createToolsOpts.last as { origin?: unknown })?.origin).toMatchObject({ actor: 'agent', depth: 2 })
  })
})

describe('skill-run tool route — no go-ahead in an unattended run', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    recipeConfig.current = { enabled_tools: [...ALL_CATEGORY_IDS] }
    executeSpy.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('refuses confirmed_with_user: true before the tool runs, as a result that names what to do', async () => {
    const res = await POST(toolReq(inheritAllToken(), 'list_actions', { list_id: 'l-1', confirmed_with_user: true }))
    expect(res.status).toBe(200)
    const { output } = await res.json()
    expect(output).toMatchObject({ success: false, needs_go_ahead: true })
    expect(output.error).toContain('nobody to ask')
    expect(output.error).toContain('Report what you would run')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('lets every other call through, including confirmed_with_user: false', async () => {
    for (const input of [{}, { confirmed_with_user: false }, { list_id: 'l-1' }]) {
      const res = await POST(toolReq(inheritAllToken(), 'list_actions', input))
      expect(res.status, JSON.stringify(input)).toBe(200)
    }
    expect(executeSpy).toHaveBeenCalledTimes(3)
  })
})

describe('a test_flow DRY run (F1 review): no write runs, report mode included', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    recipeConfig.current = { enabled_tools: [...ALL_CATEGORY_IDS] }
    workspaceRow.settings = {}
    workspaceRow.error = null
    executeSpy.mockClear()
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })
  const dryToken = () =>
    mintRunToken({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      skillId: 'skill-1',
      mode: 'report',
      hasCapture: false,
      outputContract: 'prose',
      model: 'claude-haiku-4-5-20251001',
      dryRun: true,
    })

  it("report mode's allowed writes (create_document, add_comment, suggest_changes) echo what they would write and run nothing", async () => {
    for (const toolName of ['create_document', 'add_comment', 'suggest_changes']) {
      const input = { entity_id: 'ENG-42', body: 'a test comment' }
      const res = await POST(toolReq(dryToken(), toolName, input))
      expect(res.status, toolName).toBe(200)
      expect((await res.json()).output, toolName).toMatchObject({ success: true, dry_run: true, written: false, would_have_written: input })
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('reads still run', async () => {
    expect((await POST(toolReq(dryToken(), 'list_actions'))).status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('a real (non-dry) run still dispatches its writes', async () => {
    const res = await POST(toolReq(inheritAllToken(), 'create_action', { title: 'x' }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })
})
