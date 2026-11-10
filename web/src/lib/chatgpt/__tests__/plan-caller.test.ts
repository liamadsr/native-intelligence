/**
 * Who a plan proxy call is for (plan-caller.ts): each agent family's own
 * secret header picks the family, and that family's secret and a verified,
 * unexpired token of its own must both hold. Header-only. And a family with
 * rows binds its claims to them (security review 2026-10-31, P0-1): a token
 * forged by a secret-holder never spends another person's plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Whether each family's claims bind to live rows (the binders are tested on their own). */
const bound = vi.hoisted(() => ({ chat: true, skill_run: true, live_agent: true, agent_run: true, member: true, user: true }))
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBinding: async () => (bound.chat ? 'bound' : 'unbound') }))
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBinding: async () => (bound.skill_run ? 'bound' : 'unbound') }))
vi.mock('@/lib/live-agent/live-agent-spec', () => ({ loadLiveAgentTurnState: async () => (bound.live_agent ? {} : null) }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.maybeSingle = async () => ({
        data: (table === 'agent_run' ? bound.agent_run : table === 'member' ? bound.member : false) ? { id: 'row' } : null,
        error: null,
      })
      return c
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: bound.user ? { id } : null }, error: bound.user ? null : { message: 'User not found' } }),
      },
    },
  }),
}))
import { CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, mintChatRunToken } from '@/lib/chat/chat-run-token'
import { AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER, mintAgentRunToken } from '@/lib/agent-run/agent-run-token'
import { LIVE_AGENT_SECRET_HEADER, LIVE_AGENT_TOKEN_HEADER, mintLiveAgentRunToken } from '@/lib/live-agent/live-agent-run-token'
import { UTILITY_SECRET_HEADER, UTILITY_TOKEN_HEADER, mintUtilityToken } from '@/lib/eve/utility-run-token'
import { RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER, mintRunToken } from '@/lib/flows/skill-run-token'
import { PLAN_CALLER_HEADERS, planCallerFrom, type PlanCallerFamily } from '../plan-caller'

const SECRETS = {
  RUN_SKILL_INTERNAL_SECRET: 'skill-secret',
  CHAT_INTERNAL_SECRET: 'chat-secret',
  AGENT_RUN_INTERNAL_SECRET: 'agent-run-secret',
  LIVE_AGENT_INTERNAL_SECRET: 'live-agent-secret',
  UTILITY_INTERNAL_SECRET: 'utility-secret',
}

const PROXY_URL = 'https://nativeintelligence.dev/api/internal/chatgpt-plan/v1/responses'

/** One family's headers, secret and a fresh token for user `u1`. */
const FAMILIES: Record<PlanCallerFamily, { secretHeader: string; tokenHeader: string; secret: string; mint: () => string }> = {
  chat: {
    secretHeader: CHAT_RUN_SECRET_HEADER,
    tokenHeader: CHAT_RUN_TOKEN_HEADER,
    secret: SECRETS.CHAT_INTERNAL_SECRET,
    mint: () => mintChatRunToken({ conversationId: 'c1', workspaceId: 'w1', userId: 'u1' }),
  },
  agent_run: {
    secretHeader: AGENT_RUN_SECRET_HEADER,
    tokenHeader: AGENT_RUN_TOKEN_HEADER,
    secret: SECRETS.AGENT_RUN_INTERNAL_SECRET,
    mint: () => mintAgentRunToken({ agentRunId: 'r1', workspaceId: 'w1', userId: 'u1' }),
  },
  live_agent: {
    secretHeader: LIVE_AGENT_SECRET_HEADER,
    tokenHeader: LIVE_AGENT_TOKEN_HEADER,
    secret: SECRETS.LIVE_AGENT_INTERNAL_SECRET,
    mint: () =>
      mintLiveAgentRunToken({
        captureId: 'cap1',
        workspaceId: 'w1',
        userId: 'u1',
        currentMemberId: null,
        turnType: 'copilot',
        model: 'deepseek-v4-flash',
        isEvalCapture: false,
        allowAutoArchive: false,
      }),
  },
  utility: {
    secretHeader: UTILITY_SECRET_HEADER,
    tokenHeader: UTILITY_TOKEN_HEADER,
    secret: SECRETS.UTILITY_INTERNAL_SECRET,
    mint: () => mintUtilityToken({ kind: 'generate_title', workspaceId: 'w1', userId: 'u1', model: 'chatgpt-plan/gpt-6-luna', params: {} }),
  },
  skill_run: {
    secretHeader: RUN_SKILL_SECRET_HEADER,
    tokenHeader: RUN_SKILL_TOKEN_HEADER,
    secret: SECRETS.RUN_SKILL_INTERNAL_SECRET,
    mint: () =>
      mintRunToken({
        workspaceId: 'w1',
        runAsUserId: 'u1',
        skillId: 's1',
        mode: 'report',
        hasCapture: false,
        outputContract: 'prose',
        model: 'deepseek-v4-flash',
      }),
  },
}

function call(headers: Record<string, string>, url = PROXY_URL): Request {
  return new Request(url, { method: 'POST', headers })
}

const env = { ...process.env }
beforeEach(() => {
  Object.assign(process.env, SECRETS)
  Object.assign(bound, { chat: true, skill_run: true, live_agent: true, agent_run: true, member: true, user: true })
  // The resolvers log where each secret came from; keep the run quiet.
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('planCallerFrom', () => {
  it.each(Object.keys(FAMILIES) as PlanCallerFamily[])('vouches for a %s run: its own secret and its own token', async (family) => {
    const f = FAMILIES[family]
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret, [f.tokenHeader]: f.mint() }))).toEqual({ family, userId: 'u1' })
  })

  it.each(Object.keys(FAMILIES) as PlanCallerFamily[])('refuses a %s call with a wrong secret', async (family) => {
    const f = FAMILIES[family]
    expect(await planCallerFrom(call({ [f.secretHeader]: 'not-the-secret', [f.tokenHeader]: f.mint() }))).toBeNull()
  })

  it.each(Object.keys(FAMILIES) as PlanCallerFamily[])('refuses a %s call with no token header', async (family) => {
    const f = FAMILIES[family]
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret }))).toBeNull()
  })

  it('refuses a call with no family secret header at all, whatever token it carries', async () => {
    const f = FAMILIES.chat
    expect(await planCallerFrom(call({ [f.tokenHeader]: f.mint() }))).toBeNull()
    expect(await planCallerFrom(call({}))).toBeNull()
  })

  it('never reads a token from the URL', async () => {
    const f = FAMILIES.utility
    const token = encodeURIComponent(f.mint())
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret }, `${PROXY_URL}?token=${token}`))).toBeNull()
  })

  it("refuses a token from another family under this family's secret", async () => {
    const agentRun = FAMILIES.agent_run
    const chatToken = FAMILIES.chat.mint()
    expect(await planCallerFrom(call({ [agentRun.secretHeader]: agentRun.secret, [agentRun.tokenHeader]: chatToken }))).toBeNull()
  })

  it('refuses a utility token with no person: a workspace task has no plan to run on', async () => {
    const f = FAMILIES.utility
    const token = mintUtilityToken({ kind: 'knowledge_brief', workspaceId: 'w1', userId: null, model: 'chatgpt-plan/gpt-6-luna', params: {} })
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret, [f.tokenHeader]: token }))).toBeNull()
  })

  it('refuses an expired token', async () => {
    vi.useFakeTimers()
    const f = FAMILIES.chat
    const token = f.mint()
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret, [f.tokenHeader]: token }))).toBeNull()
  })

  it.each(['chat', 'skill_run', 'live_agent', 'agent_run'] as const)(
    'refuses a %s token whose claims do not bind to live rows (a forged token spends nobody\'s plan)',
    async (family) => {
      bound[family] = false
      const f = FAMILIES[family]
      expect(await planCallerFrom(call({ [f.secretHeader]: f.secret, [f.tokenHeader]: f.mint() }))).toBeNull()
    },
  )

  it("refuses an agent_run token whose person isn't a member of the run's workspace", async () => {
    bound.member = false
    const f = FAMILIES.agent_run
    expect(await planCallerFrom(call({ [f.secretHeader]: f.secret, [f.tokenHeader]: f.mint() }))).toBeNull()
  })

  describe('utility tokens: bound as far as their claims allow (no row of their own)', () => {
    const f = FAMILIES.utility
    const utility = (claims: Partial<Parameters<typeof mintUtilityToken>[0]> = {}) =>
      planCallerFrom(
        call({
          [f.secretHeader]: f.secret,
          [f.tokenHeader]: mintUtilityToken({ kind: 'generate_title', workspaceId: 'w1', userId: 'u1', model: 'chatgpt-plan/gpt-6-luna', params: {}, ...claims }),
        }),
      )

    it("refuses one whose person isn't a member of the workspace it names", async () => {
      bound.member = false
      expect(await utility()).toBeNull()
    })

    it('with no workspace, vouches for a person who exists, and refuses one who does not', async () => {
      bound.member = false
      expect(await utility({ workspaceId: null })).toEqual({ family: 'utility', userId: 'u1' })
      bound.user = false
      expect(await utility({ workspaceId: null })).toBeNull()
    })

    it('refuses a token minted for a Gateway call, or for a model that is not a plan model', async () => {
      expect(await utility({ model: 'deepseek-v4-flash' })).toBeNull()
      expect(await utility({ model: 'chatgpt-plan/gpt-6-astra' })).toBeNull()
      expect(await utility({ model: 'chatgpt-plan/' })).toBeNull()
    })
  })

  it('names each family by the headers its agent sends (the agents copy these)', () => {
    for (const [family, f] of Object.entries(FAMILIES)) {
      expect(PLAN_CALLER_HEADERS[family as PlanCallerFamily]).toEqual({ secret: f.secretHeader, token: f.tokenHeader })
    }
  })
})
