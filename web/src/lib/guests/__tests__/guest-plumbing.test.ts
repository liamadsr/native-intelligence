/**
 * The pieces that carry a guest's text turn end to end: the run token's
 * `guestId` (an SMS channel turn only) and the guest caller class it maps
 * to, the Inngest event's guestId, the home-turn token that carries it, the
 * rule that binds a guest's turn to that guest's thread, the guest's own
 * notices, the guest's texts out, and migration 428.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintChatRunToken, verifyChatRunToken } from '@/lib/chat/chat-run-token'
import { callerClassOf } from '@/lib/safety/caller'
import { parseHomeTurnRequested } from '@/lib/chat/home-turn'
import { guestTurnConversationOk, homeTurnToken, serverTurnConversationOk } from '@/lib/chat/home-turn-server'
import { GUEST_DAILY_OUTBOUND_CAP, SMS_REPLY_MAX_TEXTS, guestTextTurnSkipNotice, textGuest, textTurnSkipNotice, withinBudget } from '@/lib/chat/text-turn-server'
import { formatSmsReply } from '@/lib/twilio/sms-format'

const SECRET = 'test-chat-internal-secret-1234567890'
const GUEST = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const U = '44444444-4444-4444-8444-444444444444'
const W = '55555555-5555-4555-8555-555555555555'
const BASE = { conversationId: C, workspaceId: W, userId: U }

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('the run token’s guestId', () => {
  it('rides an SMS channel turn and maps to the guest class', () => {
    const claims = verifyChatRunToken(mintChatRunToken({ ...BASE, server: 'channel_turn', surface: 'sms', guestId: GUEST }))
    expect(claims?.guestId).toBe(GUEST)
    expect(callerClassOf({ kind: 'chat_run', claims: claims! })).toBe('guest')
  })

  it('a Slack channel turn carries it too (migration 434): a guest messaging on Slack', () => {
    expect(verifyChatRunToken(mintChatRunToken({ ...BASE, server: 'channel_turn', surface: 'slack', guestId: GUEST }))).toMatchObject({ surface: 'slack', guestId: GUEST })
  })

  it('anywhere else the token is refused: a home turn, the browser chat, a bot’s thread', () => {
    for (const extra of [
      { server: 'home_turn' as const },
      {},
      { server: 'channel_turn' as const, surface: 'sms' as const, teammateId: 'tm-1' },
    ]) {
      expect(verifyChatRunToken(mintChatRunToken({ ...BASE, ...extra, guestId: GUEST } as never)), JSON.stringify(extra)).toBeNull()
    }
    expect(verifyChatRunToken(mintChatRunToken({ ...BASE, server: 'channel_turn', surface: 'sms', guestId: '' } as never))).toBeNull()
  })

  it('without it, an SMS channel turn is the person remote, as before', () => {
    const claims = verifyChatRunToken(mintChatRunToken({ ...BASE, server: 'channel_turn', surface: 'sms' }))
    expect(callerClassOf({ kind: 'chat_run', claims: claims! })).toBe('person_remote')
  })
})

describe('the text turn event and its token', () => {
  const data = { conversationId: C, userId: U, workspaceId: W, workItemIds: [], reason: 'text' as const, guestId: GUEST }

  it('the event carries a guest only on a channel turn: by text, or on Slack', () => {
    expect(parseHomeTurnRequested(data)?.guestId).toBe(GUEST)
    expect(parseHomeTurnRequested({ ...data, reason: 'slack' })?.guestId).toBe(GUEST)
    expect(parseHomeTurnRequested({ ...data, reason: 'guest_ask' })).toBeNull()
    expect(parseHomeTurnRequested({ ...data, reason: 'digest', digestDate: '2026-10-25' })).toBeNull()
    expect(parseHomeTurnRequested({ ...data, guestId: 'not-a-uuid' })).toBeNull()
  })

  it('the home-turn token carries the guest, so their agent answers', () => {
    const claims = verifyChatRunToken(homeTurnToken(data))
    expect(claims).toMatchObject({ server: 'channel_turn', surface: 'sms', guestId: GUEST })
  })

  it("a guest's Slack turn carries the guest on the Slack surface", () => {
    expect(verifyChatRunToken(homeTurnToken({ ...data, reason: 'slack' }))).toMatchObject({ server: 'channel_turn', surface: 'slack', guestId: GUEST })
  })

  it("a guest's thread takes a channel turn by either channel, and nothing else", () => {
    const thread = { is_home: null, outside_channel: 'sms', agent_guest_id: GUEST }
    expect(serverTurnConversationOk(thread, 'text')).toBe(true)
    expect(serverTurnConversationOk(thread, 'slack')).toBe(true)
    expect(serverTurnConversationOk({ ...thread, outside_channel: 'slack' }, 'text')).toBe(true)
    expect(serverTurnConversationOk(thread, 'digest')).toBe(false)
    expect(serverTurnConversationOk(thread, 'guest_ask')).toBe(false)
    // A person's Slack thread is still only Slack's.
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'slack', agent_guest_id: null }, 'text')).toBe(false)
  })

  it("a guest's turn runs only in that guest's thread, and a guest's thread only by their turn", () => {
    expect(guestTurnConversationOk({ agent_guest_id: GUEST }, { guestId: GUEST })).toBe(true)
    expect(guestTurnConversationOk({ agent_guest_id: null }, {})).toBe(true)
    expect(guestTurnConversationOk({}, {})).toBe(true)
    // The owner's own text turn never lands in a guest's thread…
    expect(guestTurnConversationOk({ agent_guest_id: GUEST }, {})).toBe(false)
    // …and a guest's never runs in the owner's home thread or another guest's.
    expect(guestTurnConversationOk({ agent_guest_id: null }, { guestId: GUEST })).toBe(false)
    expect(guestTurnConversationOk({ agent_guest_id: 'other' }, { guestId: GUEST })).toBe(false)
  })
})

describe("the guest's notices", () => {
  it('never point a guest at Settings, Billing or the app', () => {
    for (const reason of ['usage_limited', 'not_member', 'busy', 'unfinished', 'held', 'failed', 'question_pending'] as const) {
      const notice = guestTextTurnSkipNotice(reason, 'Liam')
      expect(notice, reason).toBeTruthy()
      expect(notice, reason).not.toMatch(/Settings|Billing|open Dial8|in Dial8/i)
    }
    expect(guestTextTurnSkipNotice('held', 'Liam')).toBe("That needs Liam's OK first. I've asked them.")
    // The person's own wording is unchanged.
    expect(textTurnSkipNotice('held')).toBe("That needs your OK first. It's waiting for you in Dial8.")
  })

  it('a long reply is never cut: every word goes, with no "..." and no link to a Dial8 they don’t have', () => {
    const long = 'word '.repeat(600)
    const texts = formatSmsReply(long, { origin: 'https://dial8.ai' })
    expect(texts.join(' ').split(' ')).toHaveLength(600)
    expect(texts.join(' ')).not.toContain('...')
    expect(texts.join(' ')).not.toContain('dial8.ai')
  })
})

describe('withinBudget: one reply never outruns the day\'s cap or SMS_REPLY_MAX_TEXTS', () => {
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)

  it('a reply that fits goes whole', () => {
    expect(withinBudget(texts(3), 50)).toEqual(texts(3))
  })

  it('past the per-reply limit, the person\'s last text says where the rest is; a guest\'s just stops', () => {
    const person = withinBudget(texts(25), 50, 'The rest is in Dial8.')
    expect(person).toHaveLength(SMS_REPLY_MAX_TEXTS)
    expect(person.at(-1)).toBe('The rest is in Dial8.')
    expect(withinBudget(texts(25), 50)).toEqual(texts(SMS_REPLY_MAX_TEXTS))
  })

  it('never more than the day has left, and always the first text when any is left', () => {
    expect(withinBudget(texts(5), 2, 'rest')).toEqual(['t0', 'rest'])
    expect(withinBudget(texts(5), 1, 'rest')).toEqual(['t0'])
    expect(withinBudget(texts(5), 0)).toEqual(['t0'])
  })
})

describe('textGuest', () => {
  function fakeSupabase(over: { row?: Record<string, unknown> | null; ledger?: Array<{ kind: string }>; sentToday?: number } = {}) {
    const inserts: unknown[] = []
    const from = vi.fn((table: string) => {
      if (table === 'agent_guest') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: over.row === undefined ? { phone_e164: '+15551234567', state: 'active', opted_out_at: null } : over.row, error: null }) }
        return q
      }
      // sms_message: the STOP read, the per-guest count, the ledger insert.
      const q: Record<string, unknown> = {}
      Object.assign(q, {
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) return { eq: () => ({ eq: () => ({ gte: async () => ({ count: over.sentToday ?? 0, error: null }) }) }) }
          return q
        },
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: async () => ({ data: over.ledger ?? [], error: null }),
        insert: async (row: unknown) => {
          inserts.push(row)
          return { error: null }
        },
      })
      return q
    })
    return { supabase: { from } as never, inserts }
  }
  const args = { guestId: GUEST, ownerUserId: U, body: 'Liam is free at 3.', kind: 'guest_reply' as const }

  it('texts an active guest and records it as theirs', async () => {
    const f = fakeSupabase()
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SMout' }))
    expect(await textGuest(f.supabase, args, { send, origin: 'https://dial8.ai' })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith('+15551234567', 'Liam is free at 3.')
    expect(f.inserts).toEqual([expect.objectContaining({ direction: 'out', kind: 'guest_reply', guest_id: GUEST, user_id: null })])
  })

  it('a long reply goes as several texts, in order, each recorded; a refused one stops the rest', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here to make this reply long enough to split.`).join(' ')
    const f = fakeSupabase()
    const send = vi.fn(async () => ({ ok: true as const, sid: `SM${send.mock.calls.length}` }))
    expect(await textGuest(f.supabase, { ...args, body }, { send, origin: 'https://dial8.ai' })).toEqual({ sent: true, sid: 'SM1' })
    const sent = send.mock.calls.map((c) => (c as unknown as [string, string])[1])
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.join(' ')).toBe(body)
    expect(f.inserts).toHaveLength(sent.length)

    const refused = vi.fn(async () => (refused.mock.calls.length === 1 ? { ok: true as const, sid: 'SMa' } : { ok: false as const, reason: 'refused' as const }))
    expect(await textGuest(fakeSupabase().supabase, { ...args, body }, { send: refused })).toEqual({ sent: true, sid: 'SMa' })
    expect(refused).toHaveBeenCalledTimes(2)
  })

  it('never a removed guest, a number that said STOP, or past their daily cap', async () => {
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SMout' }))
    expect(await textGuest(fakeSupabase({ row: { phone_e164: '+15551234567', state: 'removed', opted_out_at: null } }).supabase, args, { send })).toEqual({ sent: false, reason: 'no_phone' })
    expect(await textGuest(fakeSupabase({ row: null }).supabase, args, { send })).toEqual({ sent: false, reason: 'no_phone' })
    expect(await textGuest(fakeSupabase({ ledger: [{ kind: 'stop' }] }).supabase, args, { send })).toEqual({ sent: false, reason: 'opted_out' })
    expect(await textGuest(fakeSupabase({ sentToday: GUEST_DAILY_OUTBOUND_CAP }).supabase, args, { send })).toEqual({ sent: false, reason: 'daily_cap' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('migration 428', () => {
  const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/428_guest_texts.sql'), 'utf8')
  const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ')

  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("an SMS conversation is only ever a guest's thread, never the home thread", () => {
    expect(BODY).toContain("outside_channel is null or ( is_home is null and ( outside_channel = 'slack' or (outside_channel = 'sms' and agent_guest_id is not null) ) )")
  })

  it('every kind the app writes is one the database admits', () => {
    for (const kind of ['guest_text', 'guest_invite', 'guest_join', 'guest_reply', 'guest_welcome', 'guest_notice', 'text', 'limited', 'needs_you']) {
      expect(BODY).toContain(`'${kind}'`)
    }
    expect(BODY).toContain('add column if not exists guest_id uuid null references public.agent_guest(id) on delete set null')
  })
})
