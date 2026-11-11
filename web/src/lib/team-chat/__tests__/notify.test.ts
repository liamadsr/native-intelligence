/**
 * Who a team chat message notifies (src/lib/team-chat/notify.ts, migration
 * 560): each rule (a DM, a mention, a thread's people, a channel set to all,
 * the agent's reply to the person who asked), the never-notify cases (the
 * author, someone who may not read the channel, someone who muted it,
 * someone who already read past it), mentions-only and muted, one
 * notification per message per person, and the fan-out that writes them.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  defaultNotifyLevel,
  notifyLevelOf,
  notifyTeamChatMessage,
  requestTeamChatNotify,
  teamChatGroupKey,
  teamChatNotificationCopy,
  teamChatNotifyEvent,
  teamChatRecipients,
  type TeamChatNotifyCandidate,
} from '../notify'

const WS = '11111111-1111-4111-8111-111111111111'
const CH = '55555555-5555-4555-8555-555555555555'
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ANA = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const CY = '66666666-6666-4666-8666-666666666666'
const DEE = '77777777-7777-4777-8777-777777777777'

function cand(member: string, over: Partial<TeamChatNotifyCandidate> = {}): TeamChatNotifyCandidate {
  return {
    member_id: member,
    user_id: `u-${member}`,
    is_author: false,
    in_dm: false,
    mentioned: false,
    in_thread: false,
    asked: false,
    notify_level: null,
    can_read: true,
    read_past: false,
    ...over,
  }
}

const channelMsg = { author_kind: 'member' as const, thread_root_id: null }
const threadMsg = { author_kind: 'member' as const, thread_root_id: ROOT }
const agentMsg = { author_kind: 'agent' as const, thread_root_id: null }
const who = (list: ReturnType<typeof teamChatRecipients>) => list.map((r) => `${r.memberId}:${r.reason}`)

describe('levels', () => {
  it('a channel is mentions only, a DM every message, unless the member chose', () => {
    expect(defaultNotifyLevel('channel')).toBe('mentions')
    expect(defaultNotifyLevel('dm')).toBe('all')
    expect(notifyLevelOf('channel', null)).toBe('mentions')
    expect(notifyLevelOf('dm', 'muted')).toBe('muted')
    expect(notifyLevelOf('channel', 'loud')).toBe('mentions')
  })

  it('a conversation is the channel’s own messages, or one thread', () => {
    expect(teamChatGroupKey({ channel_id: CH, thread_root_id: null })).toBe(`team_chat:${CH}`)
    expect(teamChatGroupKey({ channel_id: CH, thread_root_id: ROOT })).toBe(`team_chat_thread:${ROOT}`)
  })
})

describe('teamChatRecipients', () => {
  it('a DM: the other person, never the author', () => {
    expect(who(teamChatRecipients(channelMsg, 'dm', [cand(ANA, { is_author: true, in_dm: true }), cand(BEN, { in_dm: true })]))).toEqual([`${BEN}:dm`])
  })

  it('a DM someone set to mentions only, or muted: nothing for a plain message; a mention still reaches mentions only', () => {
    expect(teamChatRecipients(channelMsg, 'dm', [cand(BEN, { in_dm: true, notify_level: 'mentions' })])).toEqual([])
    expect(teamChatRecipients(channelMsg, 'dm', [cand(BEN, { in_dm: true, notify_level: 'muted' })])).toEqual([])
    expect(who(teamChatRecipients(channelMsg, 'dm', [cand(BEN, { in_dm: true, notify_level: 'mentions', mentioned: true })]))).toEqual([`${BEN}:mention`])
  })

  it('a channel: the people it mentions; without a mention, only who set it to all', () => {
    const list = teamChatRecipients(channelMsg, 'channel', [cand(BEN, { mentioned: true }), cand(CY, { notify_level: 'all' }), cand(DEE)])
    expect(who(list)).toEqual([`${BEN}:mention`, `${CY}:all`])
  })

  it('mentions only (the default) is quiet for a plain channel message', () => {
    expect(teamChatRecipients(channelMsg, 'channel', [cand(BEN, { notify_level: 'mentions' }), cand(CY)])).toEqual([])
  })

  it('muted: not even a mention notifies (the badge still counts it)', () => {
    expect(teamChatRecipients(channelMsg, 'channel', [cand(BEN, { mentioned: true, notify_level: 'muted' })])).toEqual([])
    expect(teamChatRecipients(threadMsg, 'channel', [cand(BEN, { in_thread: true, notify_level: 'muted' })])).toEqual([])
  })

  it('a thread’s reply: the thread’s people and anyone it mentions; all on the channel is for its own messages only', () => {
    const list = teamChatRecipients(threadMsg, 'channel', [
      cand(ANA, { in_thread: true }),
      cand(BEN, { mentioned: true }),
      cand(CY, { notify_level: 'all' }),
      cand(DEE, { in_thread: true, notify_level: 'mentions' }),
    ])
    expect(who(list)).toEqual([`${ANA}:thread`, `${BEN}:mention`, `${DEE}:thread`])
  })

  it('a reply in a DM’s thread reaches the other person of the DM', () => {
    expect(who(teamChatRecipients(threadMsg, 'dm', [cand(BEN, { in_dm: true })]))).toEqual([`${BEN}:dm`])
  })

  it('the agent’s reply: only the person who asked, whatever else matches', () => {
    const list = teamChatRecipients(agentMsg, 'channel', [cand(ANA, { asked: true }), cand(BEN, { mentioned: true }), cand(CY, { notify_level: 'all' })])
    expect(who(list)).toEqual([`${ANA}:agent_reply`])
    // Muted is muted, even for their own agent.
    expect(teamChatRecipients(agentMsg, 'channel', [cand(ANA, { asked: true, notify_level: 'muted' })])).toEqual([])
  })

  it('never the author, never someone who may not read the channel, never someone who already read past it', () => {
    expect(teamChatRecipients(channelMsg, 'channel', [cand(ANA, { is_author: true, mentioned: true })])).toEqual([])
    expect(teamChatRecipients(channelMsg, 'channel', [cand(BEN, { mentioned: true, can_read: false })])).toEqual([])
    expect(teamChatRecipients(channelMsg, 'channel', [cand(BEN, { mentioned: true, read_past: true })])).toEqual([])
    expect(teamChatRecipients(channelMsg, 'channel', [cand(BEN, { mentioned: true, user_id: null })])).toEqual([])
  })

  it('one per person however many rules match (the mention wins)', () => {
    const list = teamChatRecipients(threadMsg, 'channel', [cand(BEN, { mentioned: true, in_thread: true, notify_level: 'all' }), cand(BEN, { in_thread: true })])
    expect(who(list)).toEqual([`${BEN}:mention`])
  })
})

describe('teamChatNotificationCopy', () => {
  it('who and where, then the first words on one line', () => {
    expect(teamChatNotificationCopy({ authorName: 'Ana Ruiz', place: '#launch', inThread: false, body: 'ship\n\nit', files: 0 })).toEqual({ title: 'Ana Ruiz in #launch', body: 'ship it' })
    expect(teamChatNotificationCopy({ authorName: 'Ana Ruiz', place: '#launch', inThread: true, body: 'yes', files: 0 }).title).toBe('Ana Ruiz in a thread in #launch')
    expect(teamChatNotificationCopy({ authorName: 'Ana Ruiz', place: null, inThread: false, body: 'hi', files: 0 }).title).toBe('Ana Ruiz')
    expect(teamChatNotificationCopy({ authorName: '', agentName: 'Juniper', place: '#launch', inThread: false, body: 'done', files: 0 }).title).toBe('Juniper (your agent) in #launch')
    expect(teamChatNotificationCopy({ authorName: 'Ana', place: null, inThread: false, body: '', files: 2 }).body).toBe('Sent 2 files')
    expect(teamChatNotificationCopy({ authorName: 'Ana', place: null, inThread: false, body: 'x'.repeat(300), files: 0 }).body).toHaveLength(140)
  })
})

describe('requestTeamChatNotify', () => {
  it('one event per message, its id the message’s (a retried send is dropped by Inngest); never throws', async () => {
    const sent: unknown[] = []
    await requestTeamChatNotify(MSG, async (e) => void sent.push(e))
    expect(sent).toEqual([teamChatNotifyEvent(MSG)])
    expect(teamChatNotifyEvent(MSG)).toEqual({ name: 'team-chat/notify.requested', id: `team-chat-notify-${MSG}`, data: { messageId: MSG } })
    await requestTeamChatNotify(MSG, async () => {
      throw new Error('down')
    })
    await requestTeamChatNotify('nope', async (e) => void sent.push(e))
    expect(sent).toHaveLength(1)
  })
})

describe('notifyTeamChatMessage (the fan-out)', () => {
  function svc(candidates: TeamChatNotifyCandidate[], message: Record<string, unknown> = {}) {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      team_chat_message: [
        { id: MSG, channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, agent_for_member_id: null, agent_name: null, thread_root_id: null, body: 'launch @Ben Ortiz?', attachments: [], deleted_at: null, ...message },
      ],
      team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', archived_at: null }],
      member: [{ id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' }],
      notification: [],
    }
    const db = memoryDb(tables, { notification: (a, b) => a.type === b.type && a.recipient_id === b.recipient_id && a.target_id === b.target_id })
    const rpc = vi.fn(async () => ({ data: candidates, error: null }))
    return { db: Object.assign(db, { rpc }) as unknown as SupabaseClient, tables, rpc }
  }

  it('writes one notification each, targeting the message in its channel, grouped by the conversation, and hands on ids only', async () => {
    const { db, tables, rpc } = svc([cand(BEN, { mentioned: true, user_id: 'u-ben' }), cand(ANA, { is_author: true })])
    const out = await notifyTeamChatMessage(db, MSG)
    expect(rpc).toHaveBeenCalledWith('team_chat_notify_candidates', { msg: MSG })
    expect(out).toEqual({ outcome: 'notified', notified: [{ memberId: BEN, userId: 'u-ben', workspaceId: WS, groupKey: `team_chat:${CH}` }] })
    expect(tables.notification).toHaveLength(1)
    expect(tables.notification[0]).toMatchObject({
      workspace_id: WS,
      recipient_id: BEN,
      type: 'team_chat_message',
      title: 'Ana Ruiz in #launch',
      body: 'launch @Ben Ortiz?',
      actor_id: ANA,
      target_type: 'team_chat_message',
      target_id: MSG,
      context_type: 'team_chat_channel',
      context_id: CH,
      group_key: `team_chat:${CH}`,
      metadata: { channel_id: CH, message_id: MSG, thread_root_id: null, reason: 'mention', author_name: 'Ana Ruiz', place: '#launch' },
    })
  })

  it('run twice (a retry), nobody is told twice, and everyone with one is still handed to the email (a partial failure left none behind)', async () => {
    const { db, tables } = svc([cand(BEN, { mentioned: true, user_id: 'u-ben' }), cand(CY, { mentioned: true, user_id: 'u-cy' })])
    // An earlier try wrote Ben's, then failed.
    tables.notification.push({ id: 'n-ben', type: 'team_chat_message', target_type: 'team_chat_message', target_id: MSG, recipient_id: BEN })
    const out = await notifyTeamChatMessage(db, MSG)
    expect(tables.notification.filter((n) => n.recipient_id === BEN)).toHaveLength(1)
    expect(out.outcome).toBe('notified')
    expect(out.notified.map((n) => n.memberId).sort()).toEqual([BEN, CY].sort())
    expect(await notifyTeamChatMessage(db, MSG)).toEqual({
      outcome: 'already',
      notified: expect.arrayContaining([expect.objectContaining({ memberId: BEN }), expect.objectContaining({ memberId: CY })]),
    })
    expect(tables.notification).toHaveLength(2)
  })

  it('the database wrote nothing (the message was deleted as the fan-out ran): nobody is handed on', async () => {
    const { db, tables } = svc([cand(BEN, { mentioned: true })])
    // 560's trigger refuses the row of a message deleted meanwhile: the insert answers, but nothing is there.
    ;(db as unknown as { from: (t: string) => unknown }).from = ((orig) => (t: string) => {
      const b = orig(t) as Record<string, unknown>
      if (t === 'notification') b.insert = async () => ({ data: null, error: null })
      return b
    })((db as unknown as { from: (t: string) => unknown }).from.bind(db))
    expect(await notifyTeamChatMessage(db, MSG)).toEqual({ outcome: 'gone', notified: [] })
    expect(tables.notification).toHaveLength(0)
  })

  it('a deleted message, or one in an archived channel, notifies nobody', async () => {
    const gone = svc([cand(BEN, { mentioned: true })], { deleted_at: '2026-11-11T00:00:00Z' })
    expect(await notifyTeamChatMessage(gone.db, MSG)).toEqual({ outcome: 'gone', notified: [] })
    expect(gone.rpc).not.toHaveBeenCalled()
    const archived = svc([cand(BEN, { mentioned: true })])
    archived.tables.team_chat_channel[0].archived_at = '2026-11-11T00:00:00Z'
    expect((await notifyTeamChatMessage(archived.db, MSG)).outcome).toBe('gone')
  })

  it('nobody to tell: nothing written', async () => {
    const { db, tables } = svc([cand(BEN, { notify_level: 'mentions' })])
    expect(await notifyTeamChatMessage(db, MSG)).toEqual({ outcome: 'nobody', notified: [] })
    expect(tables.notification).toHaveLength(0)
  })

  it('the agent’s reply speaks as the person’s own agent, with no actor; a thread’s reply is its thread’s', async () => {
    const { db, tables } = svc([cand(BEN, { asked: true })], { author_kind: 'agent', author_member_id: null, agent_for_member_id: BEN, agent_name: 'Juniper', thread_root_id: ROOT })
    await notifyTeamChatMessage(db, MSG)
    expect(tables.notification[0]).toMatchObject({ title: 'Juniper (your agent) in a thread in #launch', actor_id: null, group_key: `team_chat_thread:${ROOT}`, metadata: { reason: 'agent_reply' } })
  })

  it('a failed candidates read throws (the step retries)', async () => {
    const { db } = svc([])
    ;(db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: 'down' } })
    await expect(notifyTeamChatMessage(db, MSG)).rejects.toThrow(/candidates read failed/)
  })
})
