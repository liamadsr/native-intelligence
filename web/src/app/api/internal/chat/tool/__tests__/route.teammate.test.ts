/**
 * POST /api/internal/chat/tool for a TEAMMATE-chat token (bots v2, Phase 1,
 * decision 3) — the ENFORCE half of the teammate ceiling.
 *
 * Pins:
 *   1. the bounds are read live for the TOKEN's teammate in the token's
 *      workspace; a teammate that is gone, or on a private team the token's
 *      user is not on (an owner/admin the admin ALL policy would let see it),
 *      refuses every call (403 TEAMMATE_UNAVAILABLE) — fail closed;
 *   2. a {read} system teammate cannot run a write — create_action included
 *      (the CORE union gotcha) — but can run a read and search_tools;
 *   3. a {read, internal-write} teammate can draft; nothing outside its
 *      classes or allowlist runs;
 *   4. ask_user / start_helper never run, and the user's external MCP tools
 *      are neither loaded nor reachable;
 *   5. the tools run as the teammate: createTools gets origin
 *      { actor: 'agent', depth: 1 }.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const SECRET = 'test-chat-internal-secret-teammate'

const teammate: { row: Record<string, unknown> | null } = { row: null }
/** The private-team rule's reads: the teammate's team, the user's member row, their seat. */
const reach: { team: unknown; member: unknown; team_member: unknown } = { team: null, member: null, team_member: null }
const teammateEqs: Array<Array<[string, unknown]>> = []
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = []
      if (table === 'ai_team_member') teammateEqs.push(eqs)
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => (eqs.push([col, v]), c)
      c.maybeSingle = async () => ({
        data:
          table === 'ai_team_member'
            ? teammate.row
            : table === 'workspace'
              ? { settings: null }
              : table === 'team' || table === 'member' || table === 'team_member'
                ? reach[table]
                : null,
        error: null,
      })
      return c
    },
  }),
}))

const executeSpy = vi.fn(async () => ({ ok: true }))
const stub = () => ({ description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy })
const createToolsCalls: unknown[][] = []
vi.mock('@/lib/ai/tools', () => ({
  createTools: (...args: unknown[]) => (
    createToolsCalls.push(args),
    {
      list_actions: stub(),
      list_emails: stub(),
      create_action: stub(),
      create_document: stub(),
      delete_action: stub(),
      start_helper: stub(),
      settle_card: stub(),
      list_bot_work: stub(),
      get_bot_item: stub(),
      settle_work_item: stub(),
      send_work_answer: stub(),
      create_flow: stub(),
      update_flow: stub(),
      create_skill: stub(),
      update_skill: stub(),
    }
  ),
}))
const externalLoads = vi.fn(async () => ({ tools: { mcp__linear__create_issue: stub() }, meta: new Map(), servers: [] }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: () => externalLoads() }))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/tool-discovery')>()),
  createSearchToolsTool: () => ({ ...stub(), description: 'search' }),
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined) }))
vi.mock('@/lib/chat/start-helper', () => ({ startChatHelper: vi.fn(), stopChatHelper: vi.fn(), shadowHelperChoice: vi.fn() }))

const { POST } = await import('../route')
const { mintChatRunToken } = await import('@/lib/chat/chat-run-token')

function call(toolName: string, claims: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const token = mintChatRunToken({
    conversationId: 'conv-tm',
    workspaceId: 'ws-2',
    userId: 'user-1',
    teammateId: 'tm-1',
    ...claims,
  } as never)
  return POST(
    new Request('http://localhost/api/internal/chat/tool', {
      method: 'POST',
      headers: { 'x-chat-run-secret': SECRET, 'x-chat-run-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName, input: {}, ...extra }),
    }),
  )
}

const row = (classes: string[], over: Record<string, unknown> = {}) => ({
  is_system: false,
  team_id: 'team-1',
  allowed_side_effects: classes,
  tool_allowlist: null,
  agent: { agent_config: null, workspace_id: null, is_system: false },
  ...over,
})

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  vi.clearAllMocks()
  createToolsCalls.length = 0
  teammateEqs.length = 0
  teammate.row = row(['read'])
  reach.team = { is_private: false }
  reach.member = null
  reach.team_member = null
})

describe('chat tool route — teammate chat', () => {
  it('reads the bounds for the TOKEN’s teammate in the token’s workspace', async () => {
    await call('list_actions')
    expect(teammateEqs[0]).toEqual([['id', 'tm-1'], ['workspace_id', 'ws-2']])
  })

  it('a teammate that is gone refuses every call (fail closed)', async () => {
    teammate.row = null
    const res = await call('list_actions')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TEAMMATE_UNAVAILABLE')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('a teammate on a private team the token user is not on (an owner/admin) refuses every call', async () => {
    reach.team = { is_private: true }
    reach.member = { id: 'mem-admin' }
    reach.team_member = null
    const res = await call('list_actions')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TEAMMATE_UNAVAILABLE')
    expect(executeSpy).not.toHaveBeenCalled()
    // …while a seat on the team lets the same call through.
    reach.team_member = { team_id: 'team-1' }
    expect((await call('list_actions')).status).toBe(200)
  })

  it('a {read} system teammate runs a read and search_tools, but no write — create_action included', async () => {
    expect((await call('list_actions')).status).toBe(200)
    expect((await call('list_emails')).status).toBe(200)
    expect((await call('search_tools')).status).toBe(200)
    for (const write of ['create_action', 'create_document', 'delete_action']) {
      const res = await call(write)
      expect(res.status, write).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
  })

  it('a {read, internal-write} teammate can draft, but nothing outside its classes', async () => {
    teammate.row = row(['read', 'internal-write'])
    expect((await call('create_document')).status).toBe(200)
    expect((await call('create_action')).status).toBe(200)
    expect((await call('delete_action')).status).toBe(403)
  })

  it('its tool_allowlist narrows inside the classes', async () => {
    teammate.row = row(['read', 'internal-write'], { tool_allowlist: ['create_document'] })
    expect((await call('create_document')).status).toBe(200)
    expect((await call('list_actions')).status).toBe(403)
  })

  it('never ask_user or start_helper, and no external MCP tool is loaded or reachable', async () => {
    teammate.row = row(['read', 'internal-write', 'automation-write', 'external-write', 'delete'])
    for (const name of ['ask_user', 'start_helper', 'mcp__linear__create_issue', 'mcp_confirm_call']) {
      expect((await call(name)).status, name).toBe(403)
    }
    expect(externalLoads).not.toHaveBeenCalled()
  })

  it('the tools run as the teammate: an agent origin, one hop from the person', async () => {
    await call('list_actions')
    const options = createToolsCalls[0][4] as { origin?: unknown; strictWorkspace?: unknown; searchDefaultWindow?: unknown }
    expect(options.origin).toEqual({ actor: 'agent', depth: 1 })
    // A chat (its prompt carries the scope guidance): searches start at the past 4 weeks.
    expect(options.searchDefaultWindow).toBe('past_4_weeks')
    expect(options.strictWorkspace).toBeUndefined()
    expect(createToolsCalls[0].slice(0, 3)).toEqual(['user-1', expect.anything(), 'ws-2'])
  })

  it("a stale searchSettings on the bot's thread is ignored: the agent picks each search's scope", async () => {
    await call('list_actions', {}, { searchSettings: { timeWindow: 'recent', includeTranscripts: false, includeAttachments: true } })
    expect(createToolsCalls[0]).toHaveLength(5)
    expect(JSON.stringify(createToolsCalls[0][4] ?? {})).not.toContain('timeWindow')
  })

  it('an ordinary chat token still loads external tools (the teammate branch is keyed on the claim)', async () => {
    const res = await call('mcp__linear__create_issue', { teammateId: undefined })
    expect(externalLoads).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })
})

// ── A bot conversation in the main chat (bots-v4 Phase C) ─────────────────────
// The same enforce half as the bot's thread, keyed on the same teammateId:
// its limits are checked live on every call, wherever it chats (decision 12).
describe('chat tool route — a bot conversation (teammateIn: chat)', () => {
  const bot = (toolName: string) => call(toolName, { conversationId: 'conv-bot', teammateIn: 'chat' })

  it('reads the bounds live for the token’s bot, and a read-only bot can’t write in the main chat', async () => {
    expect((await bot('list_actions')).status).toBe(200)
    expect(teammateEqs[0]).toEqual([['id', 'tm-1'], ['workspace_id', 'ws-2']])
    for (const write of ['create_action', 'create_document', 'delete_action']) {
      const res = await bot(write)
      expect(res.status, write).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('one set to change Dial8 records can, there too', async () => {
    teammate.row = row(['read', 'internal-write'])
    expect((await bot('create_document')).status).toBe(200)
    expect((await bot('delete_action')).status).toBe(403)
  })

  it('never start_helper, ask_user or an external MCP tool, which is never loaded', async () => {
    teammate.row = row(['read', 'internal-write'])
    for (const name of ['start_helper', 'ask_user', 'mcp__linear__create_issue', 'mcp_confirm_call']) {
      expect((await bot(name)).status, name).toBe(403)
    }
    expect(externalLoads).not.toHaveBeenCalled()
  })

  it('a bot moved out of reach refuses every call there too (fail closed)', async () => {
    reach.team = { is_private: true }
    reach.member = { id: 'mem-admin' }
    reach.team_member = null
    const res = await bot('list_actions')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TEAMMATE_UNAVAILABLE')
  })
})

// ── The main agent's bot-work tools (bots-v4 Phase A1 reads, A2 writes) ──────
// list_bot_work, get_bot_item, settle_work_item and send_work_answer are the
// main chat's: attended only, and no bot is granted them, so a bot's thread
// and a bot conversation refuse them whatever the bot's classes or its
// follow-through grants.
describe('chat tool route — the bot-work tools are never a bot’s', () => {
  const WIDE = ['read', 'internal-write', 'automation-write', 'external-write', 'delete']
  const BOT_WORK = ['list_bot_work', 'get_bot_item', 'settle_work_item', 'send_work_answer']

  it('a bot’s thread and a bot conversation refuse them, even a bot with every class', async () => {
    teammate.row = row(WIDE)
    for (const extra of [{}, { conversationId: 'conv-bot', teammateIn: 'chat' }]) {
      for (const name of BOT_WORK) {
        const res = await call(name, extra)
        expect(res.status, `${name} ${JSON.stringify(extra)}`).toBe(403)
        expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      }
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('Triage holds its settle_card grant there, never the bot-work tools', async () => {
    teammate.row = row(['read'], { is_system: true, system_key: 'captures', role: null })
    expect((await call('settle_card')).status).toBe(200)
    for (const name of BOT_WORK) expect((await call(name)).status, name).toBe(403)
  })

  it('the main chat (no teammate) runs them', async () => {
    for (const name of BOT_WORK) {
      expect((await call(name, { teammateId: undefined })).status, name).toBe(200)
    }
  })

  it("hands createTools the browser's zone the chat-agent forwarded, only when it is a real one", async () => {
    await call('list_actions', {}, { timeZone: 'Europe/London' })
    expect((createToolsCalls[0][4] as { timeZone?: string }).timeZone).toBe('Europe/London')
    await call('list_actions', {}, { timeZone: 'Mars/Olympus' })
    expect((createToolsCalls[1][4] as { timeZone?: string }).timeZone).toBeUndefined()
  })

  it('no bot runs the loop builders, whatever its classes (attended only, granted to no bot)', async () => {
    teammate.row = row(['read', 'internal-write', 'automation-write', 'external-write', 'delete'])
    for (const name of ['create_flow', 'update_flow']) {
      const res = await call(name)
      expect(res.status, name).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('no bot runs the skill writers, whatever its classes (attended only, granted to no bot); the main chat does', async () => {
    teammate.row = row(['read', 'internal-write', 'automation-write', 'external-write', 'delete'])
    for (const extra of [{}, { conversationId: 'conv-bot', teammateIn: 'chat' }]) {
      for (const name of ['create_skill', 'update_skill']) {
        const res = await call(name, extra)
        expect(res.status, `${name} ${JSON.stringify(extra)}`).toBe(403)
        expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      }
    }
    expect(executeSpy).not.toHaveBeenCalled()
    for (const name of ['create_skill', 'update_skill']) {
      expect((await call(name, { teammateId: undefined })).status, name).toBe(200)
    }
  })
})
