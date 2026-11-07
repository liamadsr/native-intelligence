/**
 * Tests for the eve-turn persist function (src/lib/chat/persist-eve-turn.ts),
 * driven by the cookie-authed /api/account/chat/eve-persist route.
 *
 * Asserts: tenancy is READ FROM the claims (not the body); the knowledge hook
 * fires ONCE per newly-inserted turn and NOT on a dedup no-op; client-reported
 * usage is NEVER billed (the chat-agent's usage meter bills server-side via
 * /api/internal/chat/usage); an untitled conversation gets the panel's model-free fallback name
 * (no title model call on this path), an already-named one is left alone;
 * and body parsing rejects a missing messageId / non-array parts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { DEFAULT_CONVERSATION_TITLE, fallbackChatTitle } from '@/lib/chat/chat-title'

// ── Mock the writer + side effects ───────────────────────────────────────────
const persistState: { written: boolean; activityFired: boolean; reason?: string } = {
  written: true,
  activityFired: true,
}
const persistSpy = vi.fn(async (..._a: unknown[]) => ({
  written: persistState.written,
  conversationId: 'conv-1',
  messageId: 'm-1',
  conversationActivityFired: persistState.activityFired,
  reason: persistState.reason,
}))
vi.mock('@/lib/chat/eve-message-writer', () => ({
  persistEveMessage: (...a: unknown[]) => persistSpy(...a),
  EVE_WRITTEN_METADATA_KEY: 'eve_written',
}))

const inngestSendSpy = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSendSpy(...a) } }))

const logUsageSpy = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/ai/auth', () => ({
  logUsage: (...a: unknown[]) => logUsageSpy(...a),
}))

/**
 * A chainable supabase mock for the title backfill: the row read resolves with
 * `row` (the conversation's current title) and every update payload is recorded.
 */
function titleSupabase(row: { title: string | null } | null) {
  const updates: Array<Record<string, unknown>> = []
  const eqs: Array<[string, unknown]> = []
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (v: Record<string, unknown>) => {
      updates.push(v)
      return chain
    },
    eq: (col: string, val: unknown) => {
      eqs.push([col, val])
      return chain
    },
    maybeSingle: async () => ({ data: row, error: null }),
    then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
  }
  return { client: { from: () => chain } as never, updates, eqs }
}

import { persistEveTurn, parsePersistEveTurnBody } from '@/lib/chat/persist-eve-turn'

const supabase = {} as never
const claims: ChatRunTokenClaims = {
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
}

const goodBody = { messageId: 'm-1', role: 'assistant' as const, parts: [{ type: 'text', text: 'hi' }] }
const usageEvents = [
  { type: 'step.completed', data: { finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } },
] as never[]
// Same turn but with gateway generationIds on the step.completed events — the
// join key back to the Gateway's /v1/report cost rows.
const usageEventsWithGenIds = [
  {
    type: 'step.completed',
    data: {
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: { gateway: { generationId: 'gen_a' } },
    },
  },
  {
    type: 'step.completed',
    data: {
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 3 },
      providerMetadata: { gateway: { generationId: 'gen_b' } },
    },
  },
] as never[]

describe('persistEveTurn', () => {
  beforeEach(() => {
    persistState.written = true
    persistState.activityFired = true
    persistState.reason = undefined
    persistSpy.mockClear()
    inngestSendSpy.mockClear()
    logUsageSpy.mockClear()
  })

  it('passes CLAIMS tenancy (not body) to the writer', async () => {
    await persistEveTurn(supabase, claims, {
      ...goodBody,
      // A malicious body cannot override tenancy — the function reads claims only.
      ...({ userId: 'HACKER', workspaceId: 'HACKER-WS' } as Record<string, unknown>),
    } as never)
    const call = persistSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(call.conversationId).toBe('conv-1')
    expect(call.userId).toBe('user-1')
    expect(call.workspaceId).toBe('ws-1')
  })

  it('fires conversation/activity ONCE when a new row landed', async () => {
    const res = await persistEveTurn(supabase, claims, goodBody)
    expect(res.activityFired).toBe(true)
    expect(inngestSendSpy).toHaveBeenCalledTimes(1)
    const evt = inngestSendSpy.mock.calls[0][0] as { name: string; data: Record<string, unknown> }
    expect(evt.name).toBe('conversation/activity')
    expect(evt.data).toMatchObject({ workspaceId: 'ws-1', userId: 'user-1', conversationId: 'conv-1' })
  })

  it('a user message written when it was sent (onSend) leaves the knowledge hook to the reply', async () => {
    const res = await persistEveTurn(supabase, claims, { messageId: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }], onSend: true })
    expect(res).toMatchObject({ written: true, activityFired: false })
    expect(inngestSendSpy).not.toHaveBeenCalled()
  })

  it('says when the write replaced the reply backup’s provisional row', async () => {
    persistState.written = false
    persistState.activityFired = false
    persistSpy.mockResolvedValueOnce({ written: false, replaced: true, conversationId: 'conv-1', messageId: 'm-1', conversationActivityFired: false, reason: undefined } as never)
    const res = await persistEveTurn(supabase, claims, goodBody)
    expect(res).toMatchObject({ written: false, replaced: true, activityFired: false })
    expect(inngestSendSpy).not.toHaveBeenCalled()
  })

  it('names an untitled conversation from a user message written on its own (the page may die before the reply)', async () => {
    const { client, updates } = titleSupabase({ title: DEFAULT_CONVERSATION_TITLE })
    await persistEveTurn(client, claims, { messageId: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Rewrite the outreach steps' }], onSend: true })
    expect(updates).toEqual([{ title: fallbackChatTitle('Rewrite the outreach steps') }])
  })

  it('does NOT fire conversation/activity on a dedup no-op', async () => {
    persistState.written = false
    persistState.activityFired = false
    const res = await persistEveTurn(supabase, claims, goodBody)
    expect(res.activityFired).toBe(false)
    expect(inngestSendSpy).not.toHaveBeenCalled()
  })

  it('a TEAMMATE chat (bots v2) never signals ingest, even when a new row landed — it never feeds claims', async () => {
    const res = await persistEveTurn(supabase, { ...claims, teammateId: 'tm-1' }, goodBody)
    expect(res.written).toBe(true)
    expect(res.activityFired).toBe(false)
    expect(inngestSendSpy).not.toHaveBeenCalled()
    // …while the projection itself still lands, on the token's own tenancy.
    expect(persistSpy).toHaveBeenCalledWith(supabase, expect.objectContaining({ conversationId: 'conv-1', workspaceId: 'ws-1' }))
  })

  it('a BOT CONVERSATION in the main chat (bots-v4 Phase C, teammateIn chat) is ingested like any main-chat conversation', async () => {
    const res = await persistEveTurn(supabase, { ...claims, conversationId: 'conv-bot', teammateId: 'tm-1', teammateIn: 'chat' }, goodBody)
    expect(res.activityFired).toBe(true)
    expect(inngestSendSpy).toHaveBeenCalledTimes(1)
    expect((inngestSendSpy.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ conversationId: 'conv-bot' })
    // …and a replay still never re-triggers it.
    inngestSendSpy.mockClear()
    persistState.activityFired = false
    expect((await persistEveTurn(supabase, { ...claims, conversationId: 'conv-bot', teammateId: 'tm-1', teammateIn: 'chat' }, goodBody)).activityFired).toBe(false)
    expect(inngestSendSpy).not.toHaveBeenCalled()
  })

  it('writes the turn-opening USER message BEFORE the assistant row (ordering authority)', async () => {
    const { client } = titleSupabase({ title: 'Already named' })

    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'what are my actions today?' }] },
    })

    // Two writes, USER first then assistant — created_at order = reading order.
    expect(persistSpy).toHaveBeenCalledTimes(2)
    const first = persistSpy.mock.calls[0]?.[1] as Record<string, unknown>
    const second = persistSpy.mock.calls[1]?.[1] as Record<string, unknown>
    expect(first).toMatchObject({ role: 'user', messageId: 'u-1' })
    expect(second).toMatchObject({ role: 'assistant', messageId: 'm-1' })
  })

  it('names an UNTITLED conversation with the panel’s fallback name — no model call, no usage row', async () => {
    const { client, updates, eqs } = titleSupabase({ title: DEFAULT_CONVERSATION_TITLE })
    const text = '  what are my   actions today? '.repeat(5)

    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text }] },
    })

    // The exact name the panel falls back to (word-boundary cut), and nothing
    // metered: this path makes no title model call.
    expect(updates).toEqual([{ title: fallbackChatTitle(text) }])
    expect(logUsageSpy).not.toHaveBeenCalled()
    // Owner-scoped AND guarded to the default title (a rename is never clobbered).
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['id', 'conv-1'],
        ['user_id', 'user-1'],
        ['workspace_id', 'ws-1'],
        ['title', DEFAULT_CONVERSATION_TITLE],
      ]),
    )
  })

  it('leaves an already-named conversation alone', async () => {
    const { client, updates } = titleSupabase({ title: 'Named by the panel' })
    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hello there' }] },
    })
    expect(updates).toEqual([])
  })

  it('a panel that names its own chats (panelTitles) opts out: no read, no write — even on a row still titled "New conversation"', async () => {
    // A fast first turn's persist can land BEFORE the panel's own title PATCH, so
    // the row still carries the default title; the panel owns the name.
    const { client, updates, eqs } = titleSupabase({ title: DEFAULT_CONVERSATION_TITLE })
    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hello there' }] },
      panelTitles: true,
    })
    expect(updates).toEqual([])
    expect(eqs.some(([col]) => col === 'title')).toBe(false)
  })

  it.each(['', '   ', ' New conversation '])(
    'a row titled %j (untitled-looking, but NOT the exact default the write matches) is left alone',
    async (title) => {
      const { client, updates } = titleSupabase({ title })
      await persistEveTurn(client, claims, {
        ...goodBody,
        userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hello there' }] },
      })
      expect(updates).toEqual([])
    },
  )

  it('a whitespace-only first message names nothing (no read, no write)', async () => {
    const { client, updates, eqs } = titleSupabase({ title: DEFAULT_CONVERSATION_TITLE })
    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: '   ' }] },
    })
    expect(updates).toEqual([])
    expect(eqs.some(([col]) => col === 'title')).toBe(false)
  })

  it('a title read failure never fails the persist', async () => {
    const client = {
      from: () => {
        throw new Error('db down')
      },
    } as never
    const res = await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'plan the offsite' }] },
    })
    expect(res.written).toBe(true)
  })

  it('the backfill module imports no model client (the title generator stays behind its own route)', () => {
    const src = readFileSync(resolve(__dirname, '../persist-eve-turn.ts'), 'utf8')
    expect(src).not.toMatch(/from 'ai'/)
    expect(src).not.toMatch(/generate-chat-title|generateText|runUtilityTask/)
  })

  it('a user-message write failure never loses the assistant projection', async () => {
    persistSpy.mockImplementationOnce(async () => {
      throw new Error('user write exploded')
    })
    const res = await persistEveTurn(supabase, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] },
    })
    // The assistant projection still ran (second persist call) and succeeded.
    expect(persistSpy).toHaveBeenCalledTimes(2)
    expect(res.written).toBe(true)
  })

  it('NEVER bills client-reported usage — the chat-agent usage meter bills server-side', async () => {
    // Whatever the browser relays (events, model, a tiny wallMs, a gateway id),
    // persist must not turn it into a usage row.
    for (const usage of [
      { events: usageEvents, wallMs: 1234, model: 'claude-haiku-4-5-20251001' },
      { events: usageEventsWithGenIds, wallMs: 1, model: 'kimi-k2.6' },
      { events: usageEvents },
    ]) {
      const res = await persistEveTurn(supabase, claims, { ...goodBody, usage })
      expect(res.written).toBe(true)
    }
    expect(logUsageSpy).not.toHaveBeenCalled()
  })

  it('the persist module no longer imports logUsage at all (structural)', () => {
    const src = readFileSync(resolve(__dirname, '../persist-eve-turn.ts'), 'utf8')
    expect(src).not.toMatch(/from '@\/lib\/ai\/auth'/)
    expect(src).not.toMatch(/\blogUsage\(/)
  })
})

describe('parsePersistEveTurnBody', () => {
  it('accepts a well-formed body and defaults role to assistant', () => {
    const r = parsePersistEveTurnBody({ messageId: 'm', parts: [] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.role).toBe('assistant')
  })
  it('rejects a missing messageId', () => {
    expect(parsePersistEveTurnBody({ parts: [] })).toEqual({ ok: false, error: 'missing messageId' })
  })
  it('rejects non-array parts', () => {
    expect(parsePersistEveTurnBody({ messageId: 'm', parts: 'nope' })).toEqual({
      ok: false,
      error: 'missing parts',
    })
  })
  it('accepts a well-formed userMessage and drops a malformed one', () => {
    const withUser = parsePersistEveTurnBody({
      ...goodBody,
      userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] },
    })
    expect(withUser.ok && withUser.body.userMessage).toEqual({
      messageId: 'u-1',
      parts: [{ type: 'text', text: 'hi' }],
    })
    const badUser = parsePersistEveTurnBody({
      ...goodBody,
      userMessage: { parts: 'nope' },
    })
    expect(badUser.ok && badUser.body.userMessage).toBeUndefined()
  })

  it('rejects a non-object body', () => {
    expect(parsePersistEveTurnBody(null).ok).toBe(false)
  })

  it('carries onSend only when it is literally true', () => {
    const on = parsePersistEveTurnBody({ ...goodBody, role: 'user', onSend: true })
    const off = parsePersistEveTurnBody({ ...goodBody, role: 'user', onSend: 'yes' })
    expect(on.ok && on.body.onSend).toBe(true)
    expect(off.ok && off.body.onSend).toBeUndefined()
  })

  it('carries panelTitles only when it is literally true', () => {
    const on = parsePersistEveTurnBody({ ...goodBody, panelTitles: true })
    expect(on.ok && on.body.panelTitles).toBe(true)
    for (const v of ['true', 1, false, undefined]) {
      const r = parsePersistEveTurnBody({ ...goodBody, panelTitles: v })
      expect(r.ok && 'panelTitles' in r.body).toBe(false)
    }
  })

  // The browser's TTFT telemetry (docs/plans/chat-ttft.md, Phase 0): analytics
  // only, so it is whitelisted and clamped here and can never fail a persist.
  describe('timings', () => {
    const timingsOf = (timings: unknown) => {
      const r = parsePersistEveTurnBody({ ...goodBody, timings })
      expect(r.ok).toBe(true)
      return r.ok ? r.body.timings : undefined
    }

    it('keeps the known keys, rounding spans and clamping them to [0, 600000]', () => {
      expect(
        timingsOf({
          client_first_output_ms: 1840.6,
          client_mint_ms: -5,
          server_thinking_ms: 750_000,
          server_first_output_ms: 0,
          new_session: true,
          prewarmed: false,
          model: 'deepseek/deepseek-v4-flash',
        }),
      ).toEqual({
        client_first_output_ms: 1841,
        client_mint_ms: 0,
        server_thinking_ms: 600_000,
        server_first_output_ms: 0,
        new_session: true,
        prewarmed: false,
        model: 'deepseek/deepseek-v4-flash',
      })
    })

    it('drops unknown keys and wrongly typed values', () => {
      expect(
        timingsOf({
          client_first_text_ms: 390,
          client_create_ms: '200',
          client_register_ms: null,
          server_turn_setup_ms: Number.NaN,
          server_session_setup_ms: Infinity,
          new_session: 'true',
          prewarmed: 1,
          ttft_client_first_output_ms: 5,
          message: 'the user asked about payroll',
        }),
      ).toEqual({ client_first_text_ms: 390 })
    })

    it('accepts a model id of at most 100 chars, and nothing that reads like text', () => {
      expect(timingsOf({ model: 'anthropic/claude-sonnet-4.5' })).toEqual({ model: 'anthropic/claude-sonnet-4.5' })
      for (const model of ['x'.repeat(101), '', 'what is our churn rate', 42]) {
        expect(timingsOf({ model, new_session: false })).toEqual({ new_session: false })
      }
    })

    it('bad timings never fail the persist: a non-object, or one with nothing valid, is simply absent', () => {
      for (const timings of ['fast', 42, null, [1, 2], {}, { unknown: 1 }]) {
        const r = parsePersistEveTurnBody({ ...goodBody, timings })
        expect(r.ok).toBe(true)
        expect(r.ok && 'timings' in r.body).toBe(false)
      }
    })

    it('a body without timings parses exactly as before', () => {
      expect(parsePersistEveTurnBody(goodBody)).toEqual({
        ok: true,
        body: { messageId: 'm-1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
      })
    })
  })

  // UI-2: a message that steered a running reply.
  describe('steer', () => {
    it('keeps the card the user message replied to (checked), beside a steer, and drops one that isn’t a card', () => {
      const card = {
        kind: 'card',
        id: '22222222-2222-4222-8222-222222222222',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        verb: 'Fix',
        sentence: 'the build',
      }
      const ok = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { replyCard: card } } })
      expect(ok.ok && ok.body.userMessage).toEqual({ messageId: 'u-1', parts: [], metadata: { replyCard: card } })
      const both = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { steer: 'applied', replyCard: card } } })
      expect(both.ok && both.body.userMessage).toEqual({ messageId: 'u-1', parts: [], metadata: { steer: 'applied', replyCard: card } })
      const bad = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { replyCard: { ...card, id: 'x' } } } })
      expect(bad.ok && bad.body.userMessage).toEqual({ messageId: 'u-1', parts: [] })
    })

    it('keeps the message the user message replied to (message-reply.ts, parsed again: the quote tidied), and drops one that isn’t a ref', () => {
      const replyTo = { messageId: 'eve-msg-1', role: 'assistant', quote: '  Shall   I send it?  ', part: true, extra: 'x' }
      const ok = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { steer: 'next_turn', replyTo, skillName: 'Scout' } } })
      expect(ok.ok && ok.body.userMessage).toEqual({
        messageId: 'u-1',
        parts: [],
        metadata: { steer: 'next_turn', replyTo: { messageId: 'eve-msg-1', role: 'assistant', quote: 'Shall I send it?', part: true } },
      })
      for (const bad of [{ ...replyTo, messageId: 'a b' }, { ...replyTo, role: 'system' }, { ...replyTo, quote: '' }, 'eve-msg-1']) {
        const res = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { replyTo: bad } } })
        expect(res.ok && res.body.userMessage).toEqual({ messageId: 'u-1', parts: [] })
      }
    })

    it('keeps a reaction turn’s kind and reaction together (message-reactions.ts), and neither alone', () => {
      const reaction = { emoji: '👍', messageId: 'eve-msg-1', bubble: 2, excerpt: 'Shall   I send it?', at: 'x' }
      const ok = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { kind: 'reaction', reaction, createdAt: 'now' } } })
      expect(ok.ok && ok.body.userMessage).toEqual({
        messageId: 'u-1',
        parts: [],
        // The bubble it was on rides too (message-bubbles.ts).
        metadata: { kind: 'reaction', reaction: { emoji: '👍', messageId: 'eve-msg-1', bubble: 2, excerpt: 'Shall I send it?' } },
      })
      for (const metadata of [{ reaction }, { kind: 'reaction' }, { kind: 'other', reaction }, { kind: 'reaction', reaction: { ...reaction, emoji: 'ok' } }]) {
        const res = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata } })
        expect(res.ok && res.body.userMessage).toEqual({ messageId: 'u-1', parts: [] })
      }
    })

    it('keeps the user message’s metadata (steer) and drops a malformed one, never the message', () => {
      const ok = parsePersistEveTurnBody({
        ...goodBody,
        userMessage: { messageId: 'u-1', parts: [], metadata: { steer: 'applied' } },
      })
      expect(ok.ok && ok.body.userMessage).toEqual({ messageId: 'u-1', parts: [], metadata: { steer: 'applied' } })
      const bad = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: ['x'] } })
      expect(bad.ok && bad.body.userMessage).toEqual({ messageId: 'u-1', parts: [] })
      // Only `steer`, and only a known outcome: anything else the client sends is ignored.
      const extra = parsePersistEveTurnBody({
        ...goodBody,
        userMessage: { messageId: 'u-1', parts: [], metadata: { steer: 'applied', eve_written: false, skillName: 'x' } },
      })
      expect(extra.ok && extra.body.userMessage).toEqual({ messageId: 'u-1', parts: [], metadata: { steer: 'applied' } })
      const unknown = parsePersistEveTurnBody({ ...goodBody, userMessage: { messageId: 'u-1', parts: [], metadata: { steer: 'sideways' } } })
      expect(unknown.ok && unknown.body.userMessage).toEqual({ messageId: 'u-1', parts: [] })
    })

    it('parses the steer telemetry: known outcome, bounded spans, known opening; bad fields dropped', () => {
      const r = parsePersistEveTurnBody({
        ...goodBody,
        steer: { outcome: 'applied', held_ms: 812.4, apply_ms: -3, opening: 'before_output', steers_in_turn: 2, sent_now: true, text: 'leak' },
      })
      expect(r.ok && r.body.steer).toEqual({ outcome: 'applied', held_ms: 812, opening: 'before_output', steers_in_turn: 2, sent_now: true })
      const unknown = parsePersistEveTurnBody({ ...goodBody, steer: { outcome: 'edited' } })
      expect(unknown.ok && 'steer' in unknown.body).toBe(false)
    })
  })
})

describe('persistEveTurn — a steering message (UI-2)', () => {
  beforeEach(() => persistSpy.mockClear())

  it('writes the user row with its steer metadata, before the continuation', async () => {
    const { client } = titleSupabase({ title: 'Already named' })
    await persistEveTurn(client, claims, {
      ...goodBody,
      userMessage: { messageId: 'u-2', parts: [{ type: 'text', text: 'shorter' }], metadata: { steer: 'applied' } },
    })
    const first = persistSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(first).toMatchObject({ role: 'user', messageId: 'u-2', metadata: { steer: 'applied' } })
    expect((persistSpy.mock.calls[1]?.[1] as Record<string, unknown>).role).toBe('assistant')
  })
})
