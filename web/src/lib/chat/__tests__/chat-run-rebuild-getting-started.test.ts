/**
 * The chat spec's `getting-started` section (docs/plans/getting-started-skill.md;
 * src/lib/onboarding/getting-started.ts), over a fake service client and the
 * real loader.
 *
 * Pinned: while the person is getting started, the main chat's turns carry it
 * in TURN_CONTEXT_KEYS order (right after `now`, before `log`), never in the
 * stable prompt, with finish_getting_started up front; the home thread's
 * background turns carry it too (they share its session); a channel turn
 * holds it; a finished or expired one sends nothing, holds nothing and seeds
 * no tool; a failed read holds the key and keeps the tool; a teammate chat,
 * the device ask, a live call's turn, the check-in and the full-prompt
 * variant never read it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const db = vi.hoisted(() => ({
  client: null as unknown,
  progress: {} as Record<string, unknown>,
  memberError: null as string | null,
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => db.client }))
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: vi.fn(async () => ({ section: null, folderCount: 0, kind: null })),
}))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async () => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [
      { key: 'time', markdown: 'Current date and time: CLOCK' },
      { key: 'about', markdown: 'ABOUT' },
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
vi.mock('@/lib/log/log-section', () => ({
  buildLogSection: vi.fn(async () => ({ key: 'log', heading: 'Log', entries: [{ id: '1', line: 'x' }], markdown: 'Log\nx' })),
}))
vi.mock('@/lib/now/now-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/now/now-section')>()),
  nowForChatSpec: vi.fn(async () => ({ section: { key: 'now', markdown: 'NOW' }, held: false })),
}))
vi.mock('@/lib/chat/recent-section', () => ({ buildRecentSection: vi.fn(async () => null) }))
vi.mock('@/lib/agent-events/away-section', () => ({ buildAwaySection: vi.fn(async () => null) }))
vi.mock('@/lib/agent-events/member-time-zone', () => ({
  readMemberTimeZone: vi.fn(async () => ({ timeZone: 'Europe/Berlin', source: 'member' })),
  saveMemberTimeZone: vi.fn(async () => true),
}))
vi.mock('@/lib/live-agent/live-turn-gate', () => ({ isLiveCallTurn: vi.fn(async () => true) }))

import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const NOW = Date.parse('2026-10-27T18:00:00.000Z')

const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
  if (q.table === 'member' && q.columns === 'display_name, onboarding_completed_at, onboarding_progress') {
    if (db.memberError) return { data: null, error: { message: db.memberError } }
    return { data: { display_name: 'Liam', onboarding_completed_at: '2026-10-27T15:00:00.000Z', onboarding_progress: db.progress }, error: null }
  }
  if (q.table === 'captures') return { data: [], error: null, count: 0 } as FakeResult
  if (q.table === 'connected_account') return { data: null, error: null, count: 0 } as FakeResult
  if (q.table === 'recipe' && q.columns === 'system_prompt') return { data: { system_prompt: 'THE STEPS' }, error: null }
  return { data: null, error: null }
})
db.client = fake.client as SupabaseClient

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})
const SPLIT = { splitTurnContext: true }
const APP_TURN = { systemContext: { timeZone: 'America/New_York' } as never }
const memberReads = () => fake.log.filter((q) => q.table === 'member' && q.columns === 'display_name, onboarding_completed_at, onboarding_progress')
const keys = (spec: { turnContext?: Array<{ key: string }> }) => spec.turnContext?.map((s) => s.key)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fake.log.length = 0
  db.progress = { research: { status: 'done', seededSummary: { projectName: 'Dial8 Launch', actionCount: 3 } } }
  db.memberError = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rebuildChatSpec — the getting-started section', () => {
  it("rides the person's turn right after now, out of the stable prompt, with finish_getting_started up front", async () => {
    const spec = await rebuildChatSpec(claims(), APP_TURN, SPLIT)
    expect(keys(spec)).toEqual(['time', 'now', 'getting-started', 'log', 'about'])
    const section = spec.turnContext?.find((s) => s.key === 'getting-started')
    expect(section?.markdown).toContain('Getting started: Liam is new to Dial8.')
    expect(section?.markdown).toContain('starter project “Dial8 Launch” (3 first actions)')
    expect(section?.markdown).toContain('THE STEPS')
    expect(spec.systemPrompt).not.toContain('THE STEPS')
    expect(spec.coreToolNames).toContain('finish_getting_started')
    expect(spec).not.toHaveProperty('turnContextHeld')
  })

  it("the home thread's background turns carry it too: they share its session", async () => {
    for (const homeTurnReason of ['helper_report', 'event', 'digest', 'agent_answer'] as const) {
      const spec = await rebuildChatSpec(claims({ server: 'home_turn', homeTurnReason }), {}, SPLIT)
      expect(keys(spec), homeTurnReason).toContain('getting-started')
    }
  })

  it('a text and a Slack message hold it, reading nothing', async () => {
    for (const surface of ['sms', 'slack'] as const) {
      const spec = await rebuildChatSpec(claims({ server: 'channel_turn', surface }), {}, SPLIT)
      expect(keys(spec)?.includes('getting-started'), surface).toBe(false)
      expect(spec.turnContextHeld, surface).toEqual(['getting-started'])
    }
    expect(memberReads()).toEqual([])
  })

  it('once finished, it sends nothing, holds nothing and seeds no tool (an earlier one is cleared)', async () => {
    db.progress = { ...db.progress, getting_started: { finished_at: '2026-10-27T17:00:00.000Z', finished_by: 'done' } }
    const spec = await rebuildChatSpec(claims(), APP_TURN, SPLIT)
    expect(keys(spec)).toEqual(['time', 'now', 'log', 'about'])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(spec.coreToolNames).not.toContain('finish_getting_started')
  })

  it('a failed read holds the key, so the walk-through is never cleared by one slow read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.memberError = 'timeout'
    const spec = await rebuildChatSpec(claims(), APP_TURN, SPLIT)
    expect(keys(spec)).toEqual(['time', 'now', 'log', 'about'])
    expect(spec.turnContextHeld).toEqual(['getting-started'])
    // The tool list stays put through a held turn.
    expect(spec.coreToolNames).toContain('finish_getting_started')
    warn.mockRestore()
  })

  it('a teammate chat, the device ask, a live call’s turn, the check-in and the full-prompt variant never read or carry it', async () => {
    const specs = [
      await rebuildChatSpec(claims({ teammateId: 'tm-1' }), APP_TURN, SPLIT),
      await rebuildChatSpec(claims({ surface: 'device_ask' }), {}, SPLIT),
      await rebuildChatSpec(claims(), { systemContext: { timeZone: 'America/New_York', liveCaptureId: 'cap-1' } as never }, SPLIT),
      await rebuildChatSpec(claims({ server: 'home_turn', homeTurnReason: 'check_in' }), {}, SPLIT),
    ]
    for (const spec of specs) {
      expect(keys(spec)?.includes('getting-started')).toBe(false)
      expect(spec.coreToolNames).not.toContain('finish_getting_started')
    }
    const full = await rebuildChatSpec(claims(), APP_TURN)
    expect(full.turnContext).toBeUndefined()
    expect(full.systemPrompt).not.toContain('THE STEPS')
    expect(memberReads()).toEqual([])
  })
})
