/**
 * The chat spec's `environment` rider (docs/plans/environments.md §4 "The turn
 * context"; src/lib/chat/environment-section.ts): the chat's environment.
 *
 * Pinned: the main chat's split spec carries it, in TURN_CONTEXT_KEYS order,
 * read from the database by the TOKEN's user, workspace and conversation,
 * never from systemContext, so a home turn the server started (no
 * systemContext) has it too; a teammate chat, the device ask and the
 * full-prompt variant never read it; a failed read holds the key
 * (turnContextHeld: no `cleared`); the five local-agent tools ride up front
 * from the desktop app or whenever one of the person's Macs has a folder, and
 * start_cloud_coding_run with a cloud environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  buildEnvironmentSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ section: null, folderCount: 0, kind: null })),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async () => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [
      { key: 'time', markdown: 'Current date and time: CLOCK' },
      { key: 'uploads', markdown: 'UPLOADS' },
      { key: 'teammates', markdown: 'TEAMMATES' },
    ],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: null,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: null,
  })),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })) }))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: vi.fn(async () => null) }))
// The person's Now file (src/lib/now/now-section.ts): none here; chat-run-rebuild-now.test.ts pins it.
vi.mock('@/lib/now/now-section', () => ({ NOW_SECTION_KEY: 'now', nowForChatSpec: vi.fn(async () => ({ section: null, held: false })) }))
// Getting started (src/lib/onboarding/getting-started.ts): none here; chat-run-rebuild-getting-started.test.ts pins it.
vi.mock('@/lib/onboarding/getting-started', () => ({
  GETTING_STARTED_SECTION_KEY: 'getting-started',
  FINISH_GETTING_STARTED_TOOL: 'finish_getting_started',
  gettingStartedForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
// Setup by text (src/lib/onboarding/text-setup.ts): none here.
vi.mock('@/lib/onboarding/text-setup', () => ({
  TEXT_SETUP_SECTION_KEY: 'text-setup',
  TEXT_SETUP_TOOLS: ['connect_link', 'save_business_profile', 'research_my_company'],
  textSetupForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
vi.mock('@/lib/chat/recent-section', () => ({ buildRecentSection: vi.fn(async () => null) }))
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: state.buildEnvironmentSection,
}))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'
import { LOCAL_AGENT_TOOL_NAMES } from '@/lib/ai/tools/local-agent'
import { CLOUD_CODING_TOOL_NAMES } from '@/lib/ai/tools/cloud-coding'
import { TURN_CONTEXT_KEYS } from '@/lib/ai/chat-system-prompt'

const CONV = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: CONV,
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})

const SECTION = { key: 'environment', markdown: 'This chat’s environment, where you send work: the person’s Mac "Liam’s MacBook Pro" (online). (…)' }
const MAC_ENV = { section: SECTION, folderCount: 1, kind: 'mac' as const }

const SPLIT = { splitTurnContext: true }

beforeEach(() => {
  vi.clearAllMocks()
  state.buildEnvironmentSection.mockResolvedValue(MAC_ENV)
})

describe('rebuildChatSpec — the environment rider', () => {
  it('is a registered turn-context key, right after the uploads; the folders key is gone', () => {
    const keys = TURN_CONTEXT_KEYS as readonly string[]
    expect(keys.indexOf('environment')).toBe(keys.indexOf('uploads') + 1)
    expect(keys).not.toContain('folders')
  })

  it("rides the main chat's split spec, in key order, read for the token's own user, workspace and conversation", async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: {} }, SPLIT)
    expect(state.buildEnvironmentSection).toHaveBeenCalledTimes(1)
    expect(state.buildEnvironmentSection).toHaveBeenCalledWith({ marker: 'service' }, { userId: 'user-1', workspaceId: 'ws-1', conversationId: CONV })
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'uploads', 'environment', 'teammates'])
    expect(spec.turnContext?.find((s) => s.key === 'environment')).toEqual(SECTION)
    expect(spec.systemPrompt).not.toContain('where you send work')
    expect(spec).not.toHaveProperty('turnContextHeld')
  })

  it('a home turn the server started (no systemContext) still carries it: it never comes from the client', async () => {
    const spec = await rebuildChatSpec(claims({ server: 'home_turn' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    expect(spec.turnContext?.some((s) => s.key === 'environment')).toBe(true)
    // A client-sent "environment" is never read.
    await rebuildChatSpec(claims(), { systemContext: { environment: { id: 'evil' } } as never }, SPLIT)
    for (const call of state.buildEnvironmentSection.mock.calls) expect(call[1]).toEqual({ userId: 'user-1', workspaceId: 'ws-1', conversationId: CONV })
  })

  it('is never read for a teammate chat, the device ask, or the full-prompt variant', async () => {
    await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    const full = await rebuildChatSpec(claims(), {})
    expect(state.buildEnvironmentSection).not.toHaveBeenCalled()
    expect(full.systemPrompt).not.toContain('where you send work')
  })

  it('a failed read leaves it out and HOLDS it, so the agent keeps the version it has (never a cleared)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.buildEnvironmentSection.mockRejectedValueOnce(new Error('folders read failed: boom'))
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.turnContext?.some((s) => s.key === 'environment')).toBe(false)
    expect(spec.turnContextHeld).toEqual(['environment'])
    expect(warn).toHaveBeenCalledWith('[chat-spec] environment section held:', 'folders read failed: boom')
    warn.mockRestore()
  })

  it('no environment at all: no section, nothing held (an earlier version is cleared)', async () => {
    state.buildEnvironmentSection.mockResolvedValueOnce({ section: null, folderCount: 0, kind: null })
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'uploads', 'teammates'])
    expect(spec).not.toHaveProperty('turnContextHeld')
  })
})

describe('rebuildChatSpec — the local-agent tools up front', () => {
  const core = (spec: { coreToolNames: string[] }) => new Set(spec.coreToolNames)

  it('a Mac with a folder seeds all five, a home turn too, and the cloud tool its offline fallback calls', async () => {
    for (const c of [claims(), claims({ server: 'home_turn' } as Partial<ChatRunTokenClaims>)]) {
      const spec = await rebuildChatSpec(c, {}, SPLIT)
      for (const name of LOCAL_AGENT_TOOL_NAMES) expect([name, core(spec).has(name)]).toEqual([name, true])
      for (const name of CLOUD_CODING_TOOL_NAMES) expect([name, core(spec).has(name)]).toEqual([name, true])
    }
  })

  it('a cloud environment seeds start_cloud_coding_run (and the local-agent tools only once a Mac has a folder)', async () => {
    state.buildEnvironmentSection.mockResolvedValue({ section: { key: 'environment', markdown: 'cloud' }, folderCount: 0, kind: 'cloud' })
    const spec = await rebuildChatSpec(claims(), { systemContext: {} }, SPLIT)
    for (const name of CLOUD_CODING_TOOL_NAMES) expect([name, core(spec).has(name)]).toEqual([name, true])
    for (const name of LOCAL_AGENT_TOOL_NAMES) expect([name, core(spec).has(name)]).toEqual([name, false])
  })

  it('the desktop app seeds them with no folder yet; the web with none does not', async () => {
    state.buildEnvironmentSection.mockResolvedValue({ section: null, folderCount: 0, kind: null })
    const desktop = await rebuildChatSpec(claims(), { systemContext: { isDesktopClient: true } }, SPLIT)
    const web = await rebuildChatSpec(claims(), { systemContext: {} }, SPLIT)
    for (const name of LOCAL_AGENT_TOOL_NAMES) {
      expect([name, core(desktop).has(name)]).toEqual([name, true])
      expect([name, core(web).has(name)]).toEqual([name, false])
    }
  })

  it('the ceiling still fences the seed: a teammate chat and the device ask never get one', async () => {
    const teammate = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), { systemContext: { isDesktopClient: true } }, SPLIT)
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), { systemContext: { isDesktopClient: true } }, SPLIT)
    for (const name of [...LOCAL_AGENT_TOOL_NAMES, ...CLOUD_CODING_TOOL_NAMES]) {
      expect([name, core(teammate).has(name)]).toEqual([name, false])
      expect([name, core(device).has(name)]).toEqual([name, false])
      expect([name, device.ceilingTools.some((t) => t.name === name)]).toEqual([name, false])
    }
  })
})
