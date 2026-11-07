import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const db = vi.hoisted(() => ({
  client: null as unknown,
  progress: {} as Record<string, unknown>,
  google: [] as Array<{ account_email: string }>,
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
vi.mock('@/lib/live-agent/live-turn-gate', () => ({ isLiveCallTurn: vi.fn(async () => false) }))

import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const NOW = Date.parse('2026-11-02T18:00:00.000Z')

const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
  if (q.table === 'member' && q.columns === 'display_name, onboarding_progress') {
    if (db.memberError) return { data: null, error: { message: db.memberError } }
    return { data: { display_name: 'Owner', onboarding_progress: db.progress }, error: null }
  }
  if (q.table === 'connected_account' && q.columns === 'account_email') return { data: db.google, error: null }
  if (q.table === 'company') return { data: [], error: null }
  if (q.table === 'connected_account') return { data: null, error: null, count: 0 } as FakeResult
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
const TEXT_TURN = claims({ server: 'channel_turn', surface: 'sms' })
const keys = (spec: { turnContext?: Array<{ key: string }> }) => spec.turnContext?.map((s) => s.key)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fake.log.length = 0
  db.progress = { text_signup: { started_at: '2026-11-02T15:00:00.000Z' } }
  db.google = []
  db.memberError = null
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * The chat spec's `text-setup` section (src/lib/onboarding/text-setup.ts),
 * over a fake service client and the real loader. Unlike getting started, a
 * TEXT turn reads it: that's where an owner who signed up by text is. Its
 * tools ride up front; a failed read holds it; a finished one sends nothing.
 */
describe('rebuildChatSpec — the text-setup section', () => {
  it('a text turn carries it after now, with connect_link, save_business_profile and research_my_company up front', async () => {
    const spec = await rebuildChatSpec(TEXT_TURN, {}, SPLIT)
    expect(keys(spec)).toContain('text-setup')
    expect(keys(spec)!.indexOf('text-setup')).toBeGreaterThan(keys(spec)!.indexOf('now'))
    const section = spec.turnContext?.find((s) => s.key === 'text-setup')
    expect(section?.markdown).toContain('Setup by text: This owner signed up by texting this number')
    expect(section?.markdown).toContain('Google not connected')
    expect(spec.systemPrompt).not.toContain('Setup by text')
    for (const tool of ['connect_link', 'save_business_profile', 'research_my_company']) expect(spec.coreToolNames, tool).toContain(tool)
  })

  it('once Google is connected the section says as whom', async () => {
    db.google = [{ account_email: 'jane@brightweave.com' }]
    const spec = await rebuildChatSpec(TEXT_TURN, {}, SPLIT)
    expect(spec.turnContext?.find((s) => s.key === 'text-setup')?.markdown).toContain('Google connected (jane@brightweave.com)')
  })

  it('finished: no section, nothing held, no setup tool up front', async () => {
    db.progress = { text_signup: { started_at: '2026-11-02T15:00:00.000Z', finished_at: '2026-11-02T17:00:00.000Z' } }
    const spec = await rebuildChatSpec(TEXT_TURN, {}, SPLIT)
    expect(keys(spec)).not.toContain('text-setup')
    expect(spec.turnContextHeld ?? []).not.toContain('text-setup')
    expect(spec.coreToolNames).not.toContain('save_business_profile')
  })

  it('a failed read holds the key (never a clear mid-setup) and keeps the tools', async () => {
    db.memberError = 'member down'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spec = await rebuildChatSpec(TEXT_TURN, {}, SPLIT)
    expect(spec.turnContextHeld).toContain('text-setup')
    expect(spec.coreToolNames).toContain('connect_link')
  })

  it('a web sign-up (no text_signup) never gets it', async () => {
    const app = { systemContext: { timeZone: 'America/New_York' } as never }
    // The same app turn carries it for a text sign-up...
    expect(keys(await rebuildChatSpec(claims(), app, SPLIT))).toContain('text-setup')
    // ...and never for a web sign-up.
    db.progress = { research: { status: 'done' } }
    expect(keys(await rebuildChatSpec(claims(), app, SPLIT))).not.toContain('text-setup')
  })
})
