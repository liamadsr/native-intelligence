/**
 * The `recent` turn-context section (A3, src/lib/chat/recent-section.ts).
 *
 * Pinned: the section renders the last messages' text only (no tool parts, no
 * teammate report), each capped, fenced as untrusted; it reads the token's own
 * conversation, owner-scoped, newest three; the main chat's split spec carries
 * it right after `log` in TURN_CONTEXT_KEYS order; a teammate chat, the device
 * ask and the full-prompt variant never read or carry it; a failed read
 * leaves it out without holding it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RECENT_MESSAGES, RECENT_MESSAGE_MAX_CHARS, renderRecentSection } from '../recent-section'
import { teammateReportMessageId } from '../teammate-report'

const state = vi.hoisted(() => ({
  buildRecentSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  buildLogSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
// The chat's environment (environment-section.ts) is read by user on
// every turn; the stub service client can't, so: none.
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
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: state.buildLogSection }))
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
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: state.buildRecentSection,
}))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})
const SPLIT = { splitTurnContext: true }
const RECENT = { key: 'recent', markdown: 'Recent exchange: …' }
const LOG = { key: 'log', heading: 'Log', entries: [{ id: '1', line: 'x' }], markdown: 'Log\nx' }

const text = (role: string, t: string) => ({ role, ui_message: { parts: [{ type: 'text', text: t }] } })

describe('renderRecentSection', () => {
  it('renders text only, fenced as untrusted, oldest first', () => {
    const section = renderRecentSection([
      text('user', 'Draft the Acme reply'),
      { role: 'assistant', ui_message: { parts: [{ type: 'tool-list_emails', text: 'TOOL' }, { type: 'text', text: 'Here is the draft.' }] } },
    ])!
    expect(section.key).toBe('recent')
    expect(section.markdown).toContain('[UNTRUSTED CHAT CONTENT')
    expect(section.markdown).toContain('User: Draft the Acme reply\nAssistant: Here is the draft.')
    expect(section.markdown).not.toContain('TOOL')
    expect(section.markdown).toContain('[END UNTRUSTED CONTENT]')
  })

  it('caps a long message to its tail, and is null when nothing has text', () => {
    const long = renderRecentSection([text('assistant', `${'a'.repeat(3000)}THE END`)])!
    expect(long.markdown).toContain('THE END')
    expect(long.markdown.length).toBeLessThan(RECENT_MESSAGE_MAX_CHARS + 600)
    expect(renderRecentSection([{ role: 'assistant', ui_message: { parts: [{ type: 'tool-x' }] } }])).toBeNull()
    expect(renderRecentSection([])).toBeNull()
  })

  it('leaves out a teammate report', () => {
    const id = teammateReportMessageId({ runId: 'run-1', workItemId: 'item-1', status: 'needs_review' })
    const report = { role: 'assistant', ui_message: { id, role: 'assistant', parts: [{ type: 'text', text: 'REPORT' }], metadata: { kind: 'teammate_report' } } }
    const section = renderRecentSection([text('user', 'hi'), report])!
    expect(section.markdown).not.toContain('REPORT')
  })
})

describe('buildRecentSection', () => {
  it('reads the newest few of the token’s own conversation, owner-scoped', async () => {
    const eqs: Array<[string, unknown]> = []
    let limit = 0
    let ascending: boolean | undefined
    const rows = [text('assistant', 'second'), text('user', 'first')] // newest first, as the read returns
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = (k: string, v: unknown) => (eqs.push([k, v]), c)
    c.order = (_k: string, o: { ascending: boolean }) => ((ascending = o.ascending), c)
    c.limit = (n: number) => ((limit = n), Promise.resolve({ data: rows, error: null }))
    const { buildRecentSection } = await vi.importActual<typeof import('../recent-section')>('../recent-section')
    const section = await buildRecentSection({ from: () => c } as never, { conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ws-1' })
    expect(eqs).toEqual([['conversation_id', 'conv-1'], ['user_id', 'user-1'], ['workspace_id', 'ws-1']])
    expect(limit).toBe(RECENT_MESSAGES)
    expect(ascending).toBe(false)
    expect(section!.markdown).toContain('User: first\nAssistant: second')
  })
})

describe('rebuildChatSpec — the recent section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.buildRecentSection.mockResolvedValue(RECENT)
    state.buildLogSection.mockResolvedValue(LOG)
  })

  it("rides the main chat's split spec right after log, read for the token's own conversation", async () => {
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(state.buildRecentSection).toHaveBeenCalledWith({ marker: 'service' }, { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' })
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'log', 'recent', 'about'])
    expect(spec.systemPrompt).not.toContain('Recent exchange')
  })

  it('is never read or carried for a teammate chat, the device ask, or the full-prompt variant', async () => {
    const teammate = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    const full = await rebuildChatSpec(claims(), {})
    expect(state.buildRecentSection).not.toHaveBeenCalled()
    expect(teammate.turnContext?.some((s) => s.key === 'recent')).toBe(false)
    expect(device.turnContext?.some((s) => s.key === 'recent')).toBe(false)
    expect(full.turnContext).toBeUndefined()
  })

  it('a failed read leaves it out and holds nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.buildRecentSection.mockRejectedValueOnce(new Error('recent messages read failed: boom'))
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'log', 'about'])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(warn).toHaveBeenCalledWith('[chat-spec] recent section skipped:', 'recent messages read failed: boom')
    warn.mockRestore()
  })
})
