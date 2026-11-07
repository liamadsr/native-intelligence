/**
 * Two linked agents talking (./exchange.ts), followed through real rows: an
 * ask lands in the other half's thread and requests its turn, the reply comes
 * back as the next message and an agent_answer turn, the caps hold, only the
 * person's own turn starts one, and a link turned off sends nothing.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(), createFunction: vi.fn() } }))
vi.mock('@/lib/chat/home-message-writer', () => ({
  resolveHomeConversation: async (_supabase: unknown, { userId }: { userId: string }) => ({ conversationId: `home-${userId}`, created: false }),
}))

import { memoryDb } from './memory-db'
import { acceptLink, cardContextForHalf, requestLink } from '../store'
import { askAgent, gatherAgentAnswers, markAgentAnswersDelivered, matchLinked, recordLinkReply } from '../exchange'
import { agentAnswerTurnLines } from '../answer-lines'
import { guestCeiling } from '@/lib/guests/guest-turn'
import { toGuest } from '@/lib/guests/store'
import { AGENT_LINK_ACTIVITY_PART_TYPE, AGENT_LINK_EXCHANGE_MAX_MESSAGES, AGENT_LINK_EXCHANGES_PER_DAY } from '../views'

const LIAM = '00000000-0000-4000-8000-00000000001a'
const DANA = '00000000-0000-4000-8000-00000000003c'
const ACME = '00000000-0000-4000-8000-0000000000ac'
const NORTHWIND = '00000000-0000-4000-8000-0000000000bd'

type Row = Record<string, unknown>

async function linked(opts: { northwindOutside?: boolean; checks?: NonNullable<Parameters<typeof memoryDb>[0]>['checks'] } = {}) {
  const db = memoryDb({ checks: opts.checks })
  db.table('workspace').push({ id: ACME, name: 'Acme', settings: {} }, { id: NORTHWIND, name: 'Northwind', settings: {} })
  db.table('member').push({ user_id: LIAM, workspace_id: ACME, display_name: 'Liam A' }, { user_id: DANA, workspace_id: NORTHWIND, display_name: 'Dana Kim' })
  await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'dana@northwind.test', displayName: 'Dana', preset: 'colleague', resolveEmail: async () => DANA })
  const link = db.table('agent_link')[0]
  const accepted = await acceptLink(db.supabase, { linkId: link.id as string, userId: DANA, workspaceId: NORTHWIND, preset: 'colleague' })
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.reason}`)
  if (opts.northwindOutside === false) db.table('workspace')[1].settings = { outside_agent_links: false }
  const danasHalf = db.table('agent_guest').find((g) => g.owner_user_id === DANA) as Row
  const sent: Array<{ name: string; id: string; data: Row }> = []
  const persisted: Row[] = []
  const deps = {
    send: async (e: { name: string; id: string; data: unknown }) => void sent.push(e as never),
    persist: (async (_s: unknown, opts: Row) => {
      persisted.push(opts)
      return { written: true, conversationActivityFired: false }
    }) as never,
  }
  return { db, link, danasHalf, sent, persisted, deps }
}

const liamTyped = { userId: LIAM, workspaceId: ACME, mayStart: true }

describe('askAgent', () => {
  it("leaves nothing behind when the other half's thread can't be made (no exchange, no ask, no turn)", async () => {
    // 428's check before 437: a guest's thread could only be 'sms'.
    const w = await linked({ checks: { chat_conversations: (row) => row.outside_channel !== 'dial8' } })
    await expect(askAgent(w.db.supabase, { ...liamTyped, callKey: 'call-1' }, { to: 'Dana', message: 'Is Dana free Thursday?' }, w.deps)).rejects.toThrow(/guest thread create failed/)
    expect(w.db.table('agent_link_exchange')).toHaveLength(0)
    expect(w.db.table('agent_link_message')).toHaveLength(0)
    expect(w.sent).toHaveLength(0)
    expect(w.persisted).toHaveLength(0)
  })

  it('starts an exchange: the ask is written, put in Dana’s half’s thread as their agent’s message, and that half’s turn requested', async () => {
    const w = await linked()
    const out = await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:c1' }, { to: 'Dana', message: 'Is Dana free Thursday at 2?' }, w.deps)
    expect(out).toMatchObject({ success: true, sent: true, room_left: AGENT_LINK_EXCHANGE_MAX_MESSAGES - 1 })
    const [exchange] = w.db.table('agent_link_exchange')
    expect(exchange).toMatchObject({ link_id: w.link.id, started_by_user_id: LIAM, topic: 'Is Dana free Thursday at 2?', state: 'open', message_count: 1 })
    expect(w.db.table('agent_link_message')).toEqual([expect.objectContaining({ exchange_id: exchange.id, from_user_id: LIAM, kind: 'ask' })])
    // Dana's half's own thread, marked their agent; the message carries the link, never the owner's id as a guest.
    const [thread] = w.db.table('chat_conversations')
    expect(thread).toMatchObject({ user_id: DANA, workspace_id: NORTHWIND, agent_guest_id: w.danasHalf.id, outside_channel: 'dial8' })
    expect(w.persisted[0]).toMatchObject({ conversationId: thread.id, userId: DANA, workspaceId: NORTHWIND, role: 'user', metadata: { kind: 'channel_message', channel: 'dial8', guest_id: w.danasHalf.id } })
    expect(w.sent).toEqual([
      expect.objectContaining({ name: 'agent-link/turn.requested', data: { conversationId: thread.id, userId: DANA, workspaceId: NORTHWIND, workItemIds: [], reason: 'agent_ask', guestId: w.danasHalf.id } }),
    ])
    // One line per exchange in each home thread.
    const lines = w.db.table('chat_messages').map((m) => [m.user_id, (m.ui_message as { parts: Array<{ type: string; data: { summary: string } }> }).parts[0]])
    expect(lines).toEqual([
      [LIAM, expect.objectContaining({ type: AGENT_LINK_ACTIVITY_PART_TYPE, data: expect.objectContaining({ summary: "Asked Dana Kim's agent: Is Dana free Thursday at 2?", count: 1 }) })],
      [DANA, expect.objectContaining({ type: AGENT_LINK_ACTIVITY_PART_TYPE, data: expect.objectContaining({ summary: "Liam A's agent asked: Is Dana free Thursday at 2?" }) })],
    ])
  })

  it('a retried call sends once', async () => {
    const w = await linked()
    await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:c1' }, { to: 'Dana', message: 'Free Thursday?' }, w.deps)
    await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:c1' }, { to: 'Dana', message: 'Free Thursday?' }, w.deps)
    expect(w.db.table('agent_link_exchange')).toHaveLength(1)
    expect(w.db.table('agent_link_message')).toHaveLength(1)
    expect(w.db.table('agent_link_exchange')[0].message_count).toBe(1)
  })

  it('only the person’s own turn starts one; an answer’s turn may only follow up', async () => {
    const w = await linked()
    const away = { userId: LIAM, workspaceId: ACME, mayStart: false }
    expect(await askAgent(w.db.supabase, away, { to: 'Dana', message: 'Hi' }, w.deps)).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    const started = await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:1' }, { to: 'Dana', message: 'Free Thursday?' }, w.deps)
    const followUp = await askAgent(w.db.supabase, { ...away, callKey: 's:t:2' }, { exchange_id: started.exchange_id as string, message: 'And Friday?' }, w.deps)
    expect(followUp).toMatchObject({ success: true, exchange_id: started.exchange_id })
  })

  it('only over this person’s own links, from the workspace they answer from', async () => {
    const w = await linked()
    expect(await askAgent(w.db.supabase, { ...liamTyped, workspaceId: NORTHWIND }, { to: 'Dana', message: 'Hi' }, w.deps)).toMatchObject({ code: 'NOT_LINKED' })
    expect(await askAgent(w.db.supabase, liamTyped, { to: 'Sam', message: 'Hi' }, w.deps)).toMatchObject({ code: 'NOT_LINKED', message: expect.stringContaining('Linked: Dana Kim.') })
    const started = await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:1' }, { to: 'Dana', message: 'Hi' }, w.deps)
    // Someone not on the link can't follow up in its exchange.
    const stranger = { userId: '00000000-0000-4000-8000-0000000000ff', workspaceId: ACME, mayStart: true }
    expect(await askAgent(w.db.supabase, stranger, { exchange_id: started.exchange_id as string, message: 'Hi' }, w.deps)).toMatchObject({ code: 'EXCHANGE_NOT_FOUND' })
  })

  it('nothing goes when Dana’s half no longer takes Liam’s agent, or her workspace turned outside links off', async () => {
    const off = await linked({ northwindOutside: false })
    expect(await askAgent(off.db.supabase, liamTyped, { to: 'Dana', message: 'Hi' }, off.deps)).toMatchObject({ code: 'LINK_OFF' })
    const removed = await linked()
    removed.danasHalf.channels = ['sms']
    expect(await askAgent(removed.db.supabase, liamTyped, { to: 'Dana', message: 'Hi' }, removed.deps)).toMatchObject({ code: 'LINK_OFF' })
    expect([...off.sent, ...removed.sent]).toEqual([])
  })

  it(`holds ${AGENT_LINK_EXCHANGE_MAX_MESSAGES} messages an exchange (room for each answer), and ${AGENT_LINK_EXCHANGES_PER_DAY} exchanges a day`, async () => {
    const w = await linked()
    const started = await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:0' }, { to: 'Dana', message: 'Q0' }, w.deps)
    const exchangeId = started.exchange_id as string
    w.db.table('agent_link_exchange')[0].message_count = AGENT_LINK_EXCHANGE_MAX_MESSAGES - 1
    expect(await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:9' }, { exchange_id: exchangeId, message: 'One more?' }, w.deps)).toMatchObject({ code: 'EXCHANGE_FULL' })
    for (let i = 1; i < AGENT_LINK_EXCHANGES_PER_DAY; i++) {
      w.db.table('agent_link_exchange').push({ id: `x${i}`, link_id: w.link.id, created_at: new Date().toISOString(), state: 'done', message_count: 2 })
    }
    expect(await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:new' }, { to: 'Dana', message: 'New topic' }, w.deps)).toMatchObject({ code: 'DAILY_LIMIT' })
  })
})

describe('askAgent: the check before the person\'s card, and handing off an action item (Liam, 2026-10-26)', () => {
  it('a check says it could go, and to whom, and writes and sends nothing', async () => {
    const w = await linked()
    expect(await askAgent(w.db.supabase, { ...liamTyped, check: true }, { to: 'Dana', message: 'Free Thursday?' }, w.deps)).toEqual({ success: true, sendable: true, peer_name: 'Dana Kim' })
    expect(w.db.table('agent_link_exchange')).toHaveLength(0)
    expect(w.db.table('agent_link_message')).toHaveLength(0)
    expect(w.db.table('chat_conversations')).toHaveLength(0)
    expect(w.sent).toHaveLength(0)
    // Its refusals are the send's own.
    expect(await askAgent(w.db.supabase, { ...liamTyped, check: true }, { to: 'Sam', message: 'Hi' }, w.deps)).toMatchObject({ code: 'NOT_LINKED' })
  })

  it('a hand-off goes only to an agent that takes tasks', async () => {
    const w = await linked()
    const takesTasks = guestCeiling(toGuest(w.danasHalf as never)).has('create_action')
    const out = await askAgent(w.db.supabase, { ...liamTyped, check: true }, { to: 'Dana', message: 'From our call: can you send Acme the pricing?', hand_off: { title: 'Send Acme the pricing' } }, w.deps)
    expect(out).toMatchObject(takesTasks ? { success: true, sendable: true } : { success: false, code: 'NO_TASKS' })
    w.danasHalf.tools = (w.danasHalf.tools as string[] | undefined ?? []).filter((name) => name !== 'create_action')
    expect(await askAgent(w.db.supabase, { ...liamTyped, check: true }, { to: 'Dana', message: 'x', hand_off: { title: 'y' } }, w.deps)).toMatchObject({ success: false, code: 'NO_TASKS' })
  })
})

describe('recordLinkReply and the agent_answer turn', () => {
  it('Dana’s half’s reply is the next message, and Liam’s home thread gets an agent_answer turn carrying it once', async () => {
    const w = await linked()
    const started = await askAgent(w.db.supabase, { ...liamTyped, callKey: 's:t:1' }, { to: 'Dana', message: 'Free Thursday at 2?' }, w.deps)
    const turn = { ownerUserId: DANA, workspaceId: NORTHWIND, guestId: w.danasHalf.id as string, rowId: 'row-1' }
    const recorded = await recordLinkReply(w.db.supabase, turn, { kind: 'answer', body: 'Dana is free Thursday 2 to 4.' }, { send: w.deps.send as never })
    expect(recorded.recorded).toBe(true)
    // A retried step records it once.
    await recordLinkReply(w.db.supabase, turn, { kind: 'answer', body: 'Dana is free Thursday 2 to 4.' }, { send: w.deps.send as never })
    expect(w.db.table('agent_link_message').map((m) => [m.from_user_id, m.kind])).toEqual([
      [LIAM, 'ask'],
      [DANA, 'answer'],
    ])
    expect(w.db.table('agent_link_exchange')[0].message_count).toBe(2)
    expect(w.sent.filter((e) => e.name === 'home/turn.requested').map((e) => e.data)).toContainEqual({ conversationId: `home-${LIAM}`, userId: LIAM, workspaceId: ACME, workItemIds: [], reason: 'agent_answer' })

    const gathered = await gatherAgentAnswers(w.db.supabase, { userId: LIAM, workspaceId: ACME })
    expect(gathered?.answers).toEqual([
      expect.objectContaining({ exchangeId: started.exchange_id, peerName: 'Dana Kim', workspaceName: 'Northwind', kind: 'answer', body: 'Dana is free Thursday 2 to 4.', topic: 'Free Thursday at 2?', left: 6 }),
    ])
    expect(agentAnswerTurnLines(gathered!.answers)[0]).toBe(
      `exchange ${started.exchange_id} · Dana Kim's agent (Northwind) answered (about: Free Thursday at 2?; room for 3 more questions): Dana is free Thursday 2 to 4.`,
    )
    // Dana never gets her own answer back, and once carried it is not carried again.
    expect(await gatherAgentAnswers(w.db.supabase, { userId: DANA, workspaceId: NORTHWIND })).toBeNull()
    await markAgentAnswersDelivered(w.db.supabase, { messageIds: gathered!.messageIds, homeTurnId: 'turn-1' })
    expect(await gatherAgentAnswers(w.db.supabase, { userId: LIAM, workspaceId: ACME })).toBeNull()
  })

  it('records nothing for a half no link stands behind', async () => {
    const w = await linked()
    const result = await recordLinkReply(w.db.supabase, { ownerUserId: DANA, workspaceId: NORTHWIND, guestId: w.danasHalf.id as string, rowId: 'r' }, { kind: 'answer', body: 'Hi' }, { send: w.deps.send as never })
    expect(result).toEqual({ recorded: false, reason: 'no_ask' })
    w.db.table('agent_link')[0].state = 'ended'
    expect(await recordLinkReply(w.db.supabase, { ownerUserId: DANA, workspaceId: NORTHWIND, guestId: w.danasHalf.id as string, rowId: 'r' }, { kind: 'answer', body: 'Hi' })).toEqual({ recorded: false, reason: 'no_link' })
  })
})

describe('cardContextForHalf', () => {
  it('names the link and the person on the other side for a held call’s card, only while the link stands', async () => {
    const w = await linked()
    const half = { id: w.danasHalf.id as string, ownerUserId: DANA, peerUserId: LIAM }
    expect(await cardContextForHalf(w.db.supabase, half)).toEqual({ linkId: w.link.id, peerName: 'Liam A', workspaceName: 'Acme' })
    expect(await cardContextForHalf(w.db.supabase, { ...half, id: 'someone-else' })).toBeNull()
    w.db.table('agent_link')[0].state = 'ended'
    expect(await cardContextForHalf(w.db.supabase, half)).toBeNull()
  })
})

describe('matchLinked', () => {
  const people = [{ name: 'Dana Kim' }, { name: 'Dan Ruiz' }, { name: 'Marco Ruiz' }]
  it('an exact name, else one first-name or partial match, never a guess', () => {
    expect(matchLinked(people, 'dana kim')).toEqual({ name: 'Dana Kim' })
    expect(matchLinked(people, 'Marco')).toEqual({ name: 'Marco Ruiz' })
    expect(matchLinked(people, 'Ruiz')).toBe('ambiguous')
    expect(matchLinked(people, 'Sam')).toBeNull()
  })
})
