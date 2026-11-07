import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SeededSummary } from '../research-progress'

/**
 * Locks the researcher-side home brief writer (conversational onboarding, P1 —
 * the agent-tree mirror of src/lib/chat/home-message-writer.ts):
 *   - composeBriefMessage keeps the researcher's authored brief as the body,
 *     adds a seeded line ONLY when seededSummary is present (never fakes a
 *     project on a light run), and ALWAYS ends on an invitation (Beat 1);
 *   - writeBriefToHome resolves the home conversation via the DDL-free pointer
 *     resolver (home-conversation-pointer.ts mirror, mocked here) and upserts the
 *     brief with the stable id `onboarding-brief-<workspaceId>` +
 *     ignoreDuplicates (idempotent across finish_research re-runs);
 *   - tenancy is the caller-supplied (userId, workspaceId).
 */

const resolveHomeConversation = vi.fn(
  async (
    ..._a: unknown[]
  ): Promise<{ conversationId: string; created: boolean } | null> => ({
    conversationId: 'home-1',
    created: true,
  }),
)

vi.mock('../home-conversation-pointer.js', () => ({
  resolveHomeConversation: (...a: unknown[]) => resolveHomeConversation(...(a as [])),
}))

import {
  composeBriefMessage,
  composeActivityMessage,
  writeBriefToHome,
} from '../home-brief-writer'
import type { ResearchActivityEntry } from '../research-progress'

interface Recorded {
  table: string
  op: 'upsert' | 'update'
  payload?: Record<string, unknown>
  options?: Record<string, unknown>
}

function makeService(script: { messageUpsertError?: { message: string } | null }) {
  const recorded: Recorded[] = []
  function makeQuery(table: string) {
    const q: Record<string, unknown> = {
      upsert(payload: Record<string, unknown>, options?: Record<string, unknown>) {
        recorded.push({ table, op: 'upsert', payload, options })
        return Promise.resolve({ error: script.messageUpsertError ?? null })
      },
      update(payload: Record<string, unknown>) {
        recorded.push({ table, op: 'update', payload })
        const chain: Record<string, unknown> = {
          eq: () => chain,
          then: (onFulfilled?: (v: { error: unknown }) => unknown) =>
            Promise.resolve({ error: null }).then(onFulfilled),
        }
        return chain
      },
    }
    return q
  }
  return { from: (table: string) => makeQuery(table), _recorded: recorded }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveHomeConversation.mockResolvedValue({ conversationId: 'home-1', created: true })
})

describe('composeBriefMessage', () => {
  const brief = "Hey Priya — welcome in. You're at Northwind Labs, the CI-caching company."

  it('adds a seeded line naming the project and ends on an invitation', () => {
    const summary: SeededSummary = { projectName: 'Founder priorities', actionCount: 3 }
    const msg = composeBriefMessage(brief, summary)
    expect(msg).toContain(brief)
    expect(msg).toContain('**Founder priorities**')
    expect(msg).toContain('3 first steps')
    // Ends on an invitation, not a full stop.
    expect(msg).toMatch(/I'll be right here\.$/)
  })

  it('uses singular "step" for a single seeded action', () => {
    const msg = composeBriefMessage(brief, { projectName: 'Kickoff', actionCount: 1 })
    expect(msg).toContain('1 first step')
    expect(msg).not.toContain('1 first steps')
  })

  it('omits the seeded line entirely on a light run (no seededSummary)', () => {
    const msg = composeBriefMessage(brief, undefined)
    expect(msg).toContain(brief)
    // Never names or references a project that does not exist.
    expect(msg).not.toMatch(/project called/)
    expect(msg).not.toMatch(/on the board/)
    // Still ends on an invitation.
    expect(msg).toMatch(/I'll be right here\.$/)
  })

  it('drops the "with N steps" clause when actionCount is 0', () => {
    const msg = composeBriefMessage(brief, { projectName: 'Empty', actionCount: 0 })
    expect(msg).toContain('**Empty**')
    expect(msg).not.toMatch(/first step/)
  })
})

describe('composeActivityMessage', () => {
  const web = (callId: string, label: string): ResearchActivityEntry => ({
    callId,
    toolName: 'web_search',
    label,
  })
  const fetchE = (callId: string, label: string): ResearchActivityEntry => ({
    callId,
    toolName: 'web_fetch',
    label,
  })
  const setup = (callId: string, label: string): ResearchActivityEntry => ({
    callId,
    toolName: 'save_starter_content',
    label,
  })

  it('returns null when there is no trail (gated on real data)', () => {
    expect(composeActivityMessage(undefined)).toBeNull()
    expect(composeActivityMessage([])).toBeNull()
  })

  it('groups web + setup entries and de-…s the labels', () => {
    const log = [
      web('c1', 'Searching the web for Acme…'),
      fetchE('c2', 'Reading acme.com…'),
      setup('c3', 'Creating your first project — Q3 launch…'),
    ]
    const msg = composeActivityMessage(log)!
    expect(msg).toContain('Here')
    expect(msg).toContain('**Around the web**')
    expect(msg).toContain('- Searching the web for Acme')
    expect(msg).toContain('- Reading acme.com')
    expect(msg).not.toContain('…') // trailing ellipses stripped
    expect(msg).toContain('**Setting up your workspace**')
    expect(msg).toContain('- Creating your first project — Q3 launch')
  })

  it('dedups identical labels within a group', () => {
    const log = [
      fetchE('c1', 'Reading acme.com…'),
      fetchE('c2', 'Reading acme.com…'),
      fetchE('c3', 'Reading acme.com/about…'),
    ]
    const msg = composeActivityMessage(log)!
    const occurrences = msg.split('- Reading acme.com\n').length - 1
    // "Reading acme.com" appears once (the /about line is distinct text).
    expect(occurrences).toBeLessThanOrEqual(1)
    expect(msg).toContain('- Reading acme.com/about')
  })

  it('caps the web group and reports the overflow count', () => {
    const log = Array.from({ length: 12 }, (_, i) => web(`c${i}`, `Searching the web for topic ${i}…`))
    const msg = composeActivityMessage(log)!
    expect(msg).toContain('…and 4 more') // 12 - 8 cap
  })

  it('omits the web group entirely when only setup entries exist', () => {
    const msg = composeActivityMessage([setup('c1', 'Naming your workspace Acme…')])!
    expect(msg).not.toContain('**Around the web**')
    expect(msg).toContain('**Setting up your workspace**')
  })
})

describe('writeBriefToHome — activity recap', () => {
  it('writes the recap BEFORE the brief, with the stable id + earlier created_at', async () => {
    const service = makeService({})
    const activityLog: ResearchActivityEntry[] = [
      { callId: 'c1', toolName: 'web_search', label: 'Searching the web for Acme…' },
      { callId: 'c2', toolName: 'web_fetch', label: 'Reading acme.com…' },
    ]
    const res = await writeBriefToHome(service as never, {
      userId: 'u1',
      workspaceId: 'w1',
      brief: 'hello',
      activityLog,
    })
    expect(res.written).toBe(true)

    const upserts = service._recorded.filter(
      (r) => r.table === 'chat_messages' && r.op === 'upsert',
    )
    expect(upserts).toHaveLength(2)
    const recap = upserts[0]
    const brief = upserts[1]
    expect((recap.payload?.ui_message as { id: string }).id).toBe('onboarding-activity-w1')
    expect((brief.payload?.ui_message as { id: string }).id).toBe('onboarding-brief-w1')
    const recapMeta = (recap.payload?.ui_message as { metadata: Record<string, unknown> }).metadata
    expect(recapMeta).toMatchObject({ onboarding_activity: true })
    // The main agent's own messages: no persona stamp (getting started, not a guide).
    expect(recapMeta).not.toHaveProperty('onboarding_guide_agent_id')
    expect((brief.payload?.ui_message as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty('onboarding_guide_agent_id')
    // Recap sorts above the brief.
    const recapAt = Date.parse(recap.payload?.created_at as string)
    const briefAt = Date.parse(brief.payload?.created_at as string)
    expect(recapAt).toBeLessThan(briefAt)
  })

  it('writes ONLY the brief when the trail is empty (no recap message)', async () => {
    const service = makeService({})
    await writeBriefToHome(service as never, {
      userId: 'u1',
      workspaceId: 'w1',
      brief: 'hello',
      activityLog: [],
    })
    const upserts = service._recorded.filter(
      (r) => r.table === 'chat_messages' && r.op === 'upsert',
    )
    expect(upserts).toHaveLength(1)
    expect((upserts[0].payload?.ui_message as { id: string }).id).toBe('onboarding-brief-w1')
  })
})

describe('writeBriefToHome', () => {
  it('resolves the home conversation and writes the brief with the stable id', async () => {
    const service = makeService({})
    const res = await writeBriefToHome(service as never, {
      userId: 'u1',
      workspaceId: 'w1',
      brief: 'hello',
      seededSummary: { projectName: 'P', actionCount: 2 },
    })
    expect(res.written).toBe(true)
    expect(res.conversationId).toBe('home-1')
    expect(res.created).toBe(true)

    // Tenancy forwarded to the pointer resolver (positional: service, userId, wsId).
    expect(resolveHomeConversation).toHaveBeenCalledWith(service, 'u1', 'w1')

    const msgUpsert = service._recorded.find(
      (r) => r.table === 'chat_messages' && r.op === 'upsert',
    )
    const ui = msgUpsert?.payload?.ui_message as { id: string; metadata: Record<string, unknown> }
    expect(ui.id).toBe('onboarding-brief-w1')
    expect(ui.metadata).toMatchObject({ onboarding_brief: true })
    expect(msgUpsert?.options).toMatchObject({
      onConflict: 'conversation_id,ui_message_id',
      ignoreDuplicates: true,
    })
    expect(msgUpsert?.payload).toMatchObject({ user_id: 'u1', workspace_id: 'w1', role: 'assistant' })
  })

  it('no-ops (written:false) when the home conversation cannot be resolved', async () => {
    resolveHomeConversation.mockResolvedValueOnce(null)
    const service = makeService({})
    const res = await writeBriefToHome(service as never, {
      userId: 'u1',
      workspaceId: 'w1',
      brief: 'hello',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('no_conversation')
    expect(service._recorded.some((r) => r.table === 'chat_messages')).toBe(false)
  })

  it('returns error (never throws) when the message upsert fails', async () => {
    const service = makeService({ messageUpsertError: { message: 'nope' } })
    const res = await writeBriefToHome(service as never, {
      userId: 'u1',
      workspaceId: 'w1',
      brief: 'hello',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('error')
  })
})
