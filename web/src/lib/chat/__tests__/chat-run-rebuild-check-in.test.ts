/**
 * The check-in's spec (docs/plans/now-file.md "The check-in";
 * src/lib/chat/chat-run-rebuild.ts): a home turn's token minted for reason
 * 'check_in', in a fresh session of its own. Pinned: it is the one home turn
 * that reads and sends the `now` section; its context is the base prompt and
 * the person's profile, the clock and the note, nothing of the home thread
 * (no teammate reports, suggestions, log, recent exchange, environment or
 * away lines; buildChatSystemPrompt gets no conversation) and nothing from
 * outside (no connected servers, web guidance, workspace brief, skills or
 * canon); it advertises only its allow-list, its two writes up front, with
 * no helper roster; and it runs on the main chat's model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const db = vi.hoisted(() => ({
  client: null as unknown,
  note: null as { content: string; revision: number } | null,
  noteError: null as string | null,
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => db.client }))
const envSection = vi.hoisted(() => vi.fn(async () => ({ section: { key: 'environment', markdown: 'ENV' }, folderCount: 2, kind: 'mac' as const })))
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: envSection,
}))
const promptBuilder = vi.hoisted(() =>
  vi.fn(async (_input: { conversationId?: string }) => ({
    stable: [
      { key: 'base', markdown: 'SYSTEM_PROMPT' },
      { key: 'web-access', markdown: 'WEB_GUIDANCE' },
      { key: 'mcp', markdown: 'CONNECTED_SERVERS' },
      { key: 'words', markdown: 'EDITION_WORDS' },
      { key: 'workspace-brief', markdown: 'WORKSPACE_BRIEF' },
      { key: 'profile', markdown: 'PROFILE_FACTS' },
    ],
    turnContext: [
      { key: 'time', markdown: 'Current date and time: CLOCK' },
      { key: 'teammates', markdown: 'TEAMMATE_REPORTS' },
      { key: 'suggestions', markdown: 'SUGGESTIONS' },
    ],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: null,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: null,
  })),
)
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: promptBuilder,
}))
const externalTools = vi.hoisted(() => vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })))
vi.mock('@/lib/mcp-client/adapter', () => ({ CONFIRM_TOOL_NAME: 'mcp_confirm_call', createExternalMcpTools: externalTools }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })) }))
const logSection = vi.hoisted(() => vi.fn(async () => ({ key: 'log', heading: 'Log', entries: [{ id: '1', line: 'x' }], markdown: 'Log\nx' })))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: logSection }))
const recentSection = vi.hoisted(() => vi.fn(async () => ({ key: 'recent', markdown: 'RECENT' })))
vi.mock('@/lib/chat/recent-section', () => ({ buildRecentSection: recentSection }))
const awaySection = vi.hoisted(() => vi.fn(async () => ({ key: 'away', markdown: 'AWAY' })))
vi.mock('@/lib/agent-events/away-section', () => ({ buildAwaySection: awaySection }))
vi.mock('@/lib/agent-events/member-time-zone', () => ({
  readMemberTimeZone: vi.fn(async () => ({ timeZone: 'Europe/Berlin', source: 'member' })),
  saveMemberTimeZone: vi.fn(async () => true),
}))
const canon = vi.hoisted(() => vi.fn(async () => '\n\nCANON_REGISTRY'))
vi.mock('@/lib/documents/canon-registry', () => ({ canonRegistrySection: canon }))

import { createFakeSupabase, eqValue, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'
import { serverTurnMayCall } from '../chat-ceiling'
import { gatewayModelSlug, MAIN_MODEL } from '@/lib/ai/models'

const NOTE = ['## In flight', '- A helper is drafting the Acme follow-up (Oct 26)'].join('\n')

const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
  if (q.table === 'member' && q.columns === 'id, display_name') return { data: { id: 'm-1', display_name: 'Liam' }, error: null }
  if (q.table === 'document' && eqValue(q, 'kind') === 'now') {
    if (db.noteError) return { data: null, error: { message: db.noteError } }
    return {
      data: db.note ? { id: 'doc-now', workspace_id: 'ws-1', created_by: 'm-1', content: db.note.content, revision: db.note.revision, frontmatter: { now: { tracks: [] } }, updated_at: '2026-10-27T09:10:00.000Z' } : null,
      error: null,
    }
  }
  return { data: null, error: null }
})
db.client = fake.client as SupabaseClient

const CHECK_IN: ChatRunTokenClaims = {
  conversationId: 'home-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  server: 'home_turn',
  homeTurnReason: 'check_in',
}
const FULL = { splitTurnContext: true, includeSkills: true, includeSchemas: true }
const keys = (spec: { turnContext?: Array<{ key: string }> }) => spec.turnContext?.map((s) => s.key)

beforeEach(() => {
  vi.clearAllMocks()
  fake.log.length = 0
  db.note = { content: NOTE, revision: 5 }
  db.noteError = null
})

describe('rebuildChatSpec — the check-in', () => {
  it('reads and sends the now section (the one home turn that does), beside the clock alone', async () => {
    const spec = await rebuildChatSpec(CHECK_IN, {}, FULL)
    expect(keys(spec)).toEqual(['time', 'now'])
    expect(spec.turnContext?.find((s) => s.key === 'now')?.markdown).toContain(' 2 - A helper is drafting the Acme follow-up (Oct 26)')
    expect(spec).not.toHaveProperty('turnContextHeld')
  })

  it('nothing of the home thread: no conversation layers, log, recent exchange, environment or away lines', async () => {
    const spec = await rebuildChatSpec(CHECK_IN, {}, FULL)
    expect(promptBuilder).toHaveBeenCalledOnce()
    expect(promptBuilder.mock.calls[0][0]).not.toHaveProperty('conversationId')
    for (const loader of [logSection, recentSection, envSection, awaySection]) expect(loader).not.toHaveBeenCalled()
    expect(JSON.stringify(spec)).not.toMatch(/TEAMMATE_REPORTS|SUGGESTIONS|RECENT|AWAY|"ENV"/)
  })

  it('nothing from outside in its stable prompt: the base and the profile only, no servers, web guidance, brief, skills or canon', async () => {
    const spec = await rebuildChatSpec(CHECK_IN, {}, FULL)
    expect(spec.systemPrompt).toContain('SYSTEM_PROMPT')
    expect(spec.systemPrompt).toContain('PROFILE_FACTS')
    // A check-in speaks to the person: in a service business, about jobs (the edition's words).
    expect(spec.systemPrompt).toContain('EDITION_WORDS')
    expect(spec.systemPrompt).not.toMatch(/WEB_GUIDANCE|CONNECTED_SERVERS|WORKSPACE_BRIEF|CANON_REGISTRY|Available skills/)
    expect(externalTools).not.toHaveBeenCalled()
    expect(canon).not.toHaveBeenCalled()
    expect(spec.skills).toBeUndefined()
    expect(spec.packs).toBeUndefined()
    // Its one helper's model is fixed in code: no roster to choose from.
    expect(spec.systemPrompt).not.toContain('## Models for helpers')
  })

  it('advertises only its allow-list, with its two writes up front', async () => {
    const spec = await rebuildChatSpec(CHECK_IN, {}, FULL)
    const names = spec.ceilingTools.map((t) => t.name)
    for (const name of names) expect([name, serverTurnMayCall(name, 'home_turn', 'check_in')]).toEqual([name, true])
    expect(names).toEqual(expect.arrayContaining(['update_now', 'start_helper', 'list_actions', 'get_action']))
    for (const name of ['remember', 'get_document', 'find', 'read_email', 'answer_guest', 'ask_agent', 'local_agents', 'create_action']) expect(names).not.toContain(name)
    // Its ceiling is never inherit-all: the same allow-list.
    expect(spec.ceiling).not.toBeNull()
    for (const name of spec.ceiling ?? []) expect([name, serverTurnMayCall(name, 'home_turn', 'check_in')]).toEqual([name, true])
    expect(spec.coreToolNames).toEqual(expect.arrayContaining(['update_now', 'start_helper']))
    for (const name of spec.coreToolNames) expect(names).toContain(name)
  })

  it('runs on the main chat’s model, like every server turn (decision 11)', async () => {
    const spec = await rebuildChatSpec(CHECK_IN, {}, FULL)
    expect(spec.model).toBe(gatewayModelSlug(MAIN_MODEL))
  })

  it('a failed note read holds the key; no note sends the empty section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.noteError = 'timeout'
    const held = await rebuildChatSpec(CHECK_IN, {}, FULL)
    expect(keys(held)).toEqual(['time'])
    expect(held.turnContextHeld).toEqual(['now'])
    warn.mockRestore()
    db.noteError = null
    db.note = null
    expect(keys(await rebuildChatSpec(CHECK_IN, {}, FULL))).toEqual(['time', 'now'])
  })

  it('every other home turn still holds the key, reads nothing, and keeps its full spec', async () => {
    const spec = await rebuildChatSpec({ ...CHECK_IN, homeTurnReason: 'event' }, {}, FULL)
    expect(spec.turnContextHeld).toEqual(['now'])
    expect(keys(spec)).toContain('teammates')
    expect(spec.systemPrompt).toContain('WORKSPACE_BRIEF')
    expect(promptBuilder.mock.calls[0][0]).toHaveProperty('conversationId', 'home-1')
    expect(spec.ceilingTools.map((t) => t.name)).toContain('remember')
  })
})
