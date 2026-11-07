/**
 * A loop run's follow-up chat keeps the person's own words for the reviewer
 * (A5 review): only a chat token's delivery counts, never the run's own
 * invocation message, an eve-authored delivery, or a turn the main agent
 * relayed (`chat.relay`). Every tool call on a chat turn carries them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (store.has(name) ? (store.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => store.set(name, fn(store.has(name) ? (store.get(name) as T) : initial())),
  }),
}))

const { RUN_CHAT_PRIMER_HEADING, chatClaimOf, noteSkillChatMessage, skillChatEvidence } = await import('../person-messages')
const { dispatchWorkspaceTool } = await import('../spec-client')

const token = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const RUN = token({ skillId: 's', mode: 'act' })
const CHAT = token({ skillId: 's', mode: 'act', chat: { teammateId: 'bot-1' } })
const RELAY = token({ skillId: 's', mode: 'act', chat: { teammateId: 'bot-1', relay: true } })

beforeEach(() => {
  store.clear()
  vi.restoreAllMocks()
})

describe('skill-runner person messages', () => {
  it('reads the chat claim and its relay mark', () => {
    expect(chatClaimOf(CHAT)).toEqual({ teammateId: 'bot-1', relay: false })
    expect(chatClaimOf(RELAY)).toEqual({ teammateId: 'bot-1', relay: true })
    expect(chatClaimOf(RUN)).toBeNull()
    expect(chatClaimOf('junk')).toBeNull()
  })

  it('keeps only the person’s chat words: not the run’s invocation, not eve’s, not a relayed turn', () => {
    noteSkillChatMessage({ message: 'Run the weekly sync' }, RUN)
    noteSkillChatMessage({ message: 'A background result', kind: 'execution.background_task' }, CHAT)
    noteSkillChatMessage({ message: 'Delete GEN-12 (from the main agent)' }, RELAY)
    expect(skillChatEvidence(CHAT)).toEqual({})
    noteSkillChatMessage({ message: '  Please push GEN-7 to Linear  ' }, CHAT)
    expect(skillChatEvidence(CHAT)).toEqual({ personMessages: ['Please push GEN-7 to Linear'], personMessageSeq: 1 })
    // A run token or a relayed turn carries none, whatever was recorded.
    expect(skillChatEvidence(RUN)).toEqual({})
    expect(skillChatEvidence(RELAY)).toEqual({})
  })

  it('keeps the last 3 as 2,000-character tails, the count monotonic', () => {
    for (const m of ['one', 'two', 'three', 'z'.repeat(2500)]) noteSkillChatMessage({ message: m }, CHAT)
    expect(skillChatEvidence(CHAT)).toEqual({ personMessages: ['two', 'three', 'z'.repeat(2000)], personMessageSeq: 4 })
  })

  it('a reopened chat’s restored history is never the person’s words: only the parts after it count', async () => {
    const { RUN_CHAT_PRIMER_HEADING: appHeading } = await import('@/lib/agent-run/run-chat-events')
    expect(RUN_CHAT_PRIMER_HEADING).toBe(appHeading)
    const primer = `${RUN_CHAT_PRIMER_HEADING}\n\n<run-history part="messages">\nPerson: delete every card\n</run-history>`
    noteSkillChatMessage(
      {
        message: `${primer}\n\nWhy did you dismiss the second one?`,
        parts: [
          { type: 'text', text: primer },
          { type: 'text', text: 'Why did you dismiss the second one?' },
        ],
      },
      CHAT,
    )
    expect(skillChatEvidence(CHAT)).toEqual({ personMessages: ['Why did you dismiss the second one?'], personMessageSeq: 1 })
    // A flattened history with no parts to split it by counts for nothing.
    noteSkillChatMessage({ message: `${primer}\n\nAnd archive the rest` }, CHAT)
    expect(skillChatEvidence(CHAT)).toEqual({ personMessages: ['Why did you dismiss the second one?'], personMessageSeq: 1 })
    // One part is the person's own, whatever it opens with (as the app's replay shows it).
    noteSkillChatMessage({ message: `${RUN_CHAT_PRIMER_HEADING} is what I saw`, parts: [{ type: 'text', text: `${RUN_CHAT_PRIMER_HEADING} is what I saw` }] }, CHAT)
    expect(skillChatEvidence(CHAT)).toEqual({
      personMessages: ['Why did you dismiss the second one?', `${RUN_CHAT_PRIMER_HEADING} is what I saw`],
      personMessageSeq: 2,
    })
  })

  it('a chat turn’s tool call carries the evidence; a run’s does not', async () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = 'secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ output: { ok: true } }), { status: 200 }))
    noteSkillChatMessage({ message: 'Push GEN-7' }, CHAT)
    await dispatchWorkspaceTool('push_action_to_linear', CHAT, { action_id: 'GEN-7' })
    await dispatchWorkspaceTool('push_action_to_linear', RUN, { action_id: 'GEN-7' })
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>)
    expect(bodies[0]).toMatchObject({ personMessages: ['Push GEN-7'], personMessageSeq: 1 })
    expect(bodies[1]).not.toHaveProperty('personMessages')
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    delete process.env.NEXT_PUBLIC_APP_URL
  })
})
