/**
 * Team chat by email while you are away (src/lib/team-chat/email.ts, the
 * `team-chat-email` Inngest function): one email per PERSON, its sections the
 * conversations still unread, bounded; a conversation read meanwhile drops
 * out (nothing left: nothing sent); at an app, or in quiet hours, it waits;
 * a message is never emailed twice; it says the words as they are now, and
 * only what the person may still read, asked again right before it goes
 * (mentioned, then removed from the private channel: nothing of it is sent);
 * push (no adapter yet) comes before email and falls through.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: (opts: unknown, fn: unknown) => ({ opts, fn }), send: vi.fn() } }))

import {
  parseTeamChatEmailRequest,
  planTeamChatEmail,
  teamChatAwayChannel,
  teamChatEmailContent,
  teamChatEmailEvent,
  teamChatMessageLink,
  TEAM_CHAT_EMAIL_EVENT,
  TEAM_CHAT_EMAIL_MAX_CONVERSATIONS,
  TEAM_CHAT_EMAIL_MAX_PER_CONVERSATION,
  type TeamChatEmailDecision,
  type TeamChatEmailDeps,
  type TeamChatEmailItem,
  type TeamChatEmailNotice,
  type TeamChatEmailRequest,
  type TeamChatLiveMessage,
} from '../email'
import { runTeamChatEmail, teamChatEmail } from '@/lib/inngest/team-chat-reach'

const USER = '22222222-2222-4222-8222-222222222222'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const MEMBER_2 = '44444444-4444-4444-8444-444444444444'
const WS = '11111111-1111-4111-8111-111111111111'
const WS_2 = '99999999-9999-4999-8999-999999999999'
const CH = '55555555-5555-4555-8555-555555555555'
const CH_2 = '66666666-6666-4666-8666-666666666666'
const NOW = Date.parse('2026-11-11T20:00:00.000Z')

const req: TeamChatEmailRequest = { key: USER, userId: USER, workspaceId: WS }
const outcomeOf = (d: TeamChatEmailDecision) => (d.kind === 'done' ? d.outcome : d.kind)

const hex = (n: number) => n.toString(16).padStart(12, '0')
function notice(n: number, over: Partial<TeamChatEmailNotice> = {}): TeamChatEmailNotice {
  return {
    id: `a0000000-0000-4000-8000-${hex(n)}`,
    created_at: new Date(NOW - (60 - n) * 60_000).toISOString(),
    recipient_id: MEMBER,
    workspace_id: WS,
    group_key: `team_chat:${CH}`,
    title: 'Ana Ruiz in #launch',
    target_id: `b0000000-0000-4000-8000-${hex(n)}`,
    metadata: { author_name: 'Ana Ruiz', place: '#launch', thread_root_id: null },
    ...over,
  }
}

function deps(over: Partial<TeamChatEmailDeps> & { notices?: TeamChatEmailNotice[]; words?: Map<string, TeamChatLiveMessage> } = {}) {
  const claims = new Set<string>()
  const sent: Array<{ to: string; subject: string; html: string; text: string }> = []
  const notices = over.notices ?? [notice(1), notice(2), notice(3)]
  // The messages as they are now: their own words, unless a test says otherwise.
  const words = over.words ?? new Map(notices.map((n) => [n.target_id!, { body: `message ${n.target_id!.slice(-2)}`, files: 0 }]))
  const readableCalls: Array<{ memberId: string; ids: string[] }> = []
  const d: TeamChatEmailDeps = {
    now: () => NOW,
    unread: async () => notices,
    claimed: async ({ ids }) => new Set(ids.filter((id) => [...claims].some((c) => c.endsWith(`:${id}`)))),
    readable: async (input) => {
      readableCalls.push(input)
      return new Map(input.ids.filter((id) => words.has(id)).map((id) => [id, words.get(id)!]))
    },
    presence: async () => [],
    // Pacific: noon there, out of quiet hours.
    timeZone: async () => 'America/Los_Angeles',
    pushTarget: async () => false,
    address: async () => 'ana@example.test',
    claim: async ({ notificationId, channel }) => {
      const k = `${channel}:${notificationId}`
      if (claims.has(k)) return 'taken'
      claims.add(k)
      return 'claimed'
    },
    sendEmail: async (input) => {
      sent.push(input)
      return true
    },
    link: (id, ws) => teamChatMessageLink(id, ws, 'https://app.example.test'),
    ...over,
  }
  return { d, sent, claims, readableCalls, words }
}

describe('planTeamChatEmail', () => {
  it('a burst is ONE email carrying every unread message, with the words as they are now, linked into its workspace', async () => {
    const { d, sent } = deps()
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'sent', messages: 3 })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ana@example.test')
    expect(sent[0].subject).toBe('3 new messages: #launch')
    for (const n of ['01', '02', '03']) expect(sent[0].text).toContain(`Ana Ruiz: message ${n}`)
    expect(sent[0].text).toContain(`https://app.example.test/account?team_chat_message=${notice(3).target_id}&workspace=${WS}`)
  })

  it('one email per person: several conversations (in two workspaces) are sections of the same email', async () => {
    const notices = [
      notice(1),
      notice(2, { group_key: `team_chat_thread:${CH}`, metadata: { author_name: 'Ben Ortiz', place: '#launch', thread_root_id: CH } }),
      notice(3, { recipient_id: MEMBER_2, workspace_id: WS_2, group_key: `team_chat:${CH_2}`, title: 'Rosa Lind', metadata: { author_name: 'Rosa Lind', place: null, thread_root_id: null } }),
    ]
    const { d, sent, readableCalls } = deps({ notices })
    expect(outcomeOf(await planTeamChatEmail(req, d))).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('3 new messages in 3 conversations')
    expect(sent[0].text).toContain('A thread in #launch')
    expect(sent[0].text).toContain('Rosa Lind, directly to you')
    expect(sent[0].text).toContain(`workspace=${WS_2}`)
    // What each member may read is asked as that member.
    expect(new Set(readableCalls.map((c) => c.memberId))).toEqual(new Set([MEMBER, MEMBER_2]))
  })

  it('bounded: a few conversations and a few messages each, then "and N more"', () => {
    const items: TeamChatEmailItem[] = []
    for (let c = 0; c < TEAM_CHAT_EMAIL_MAX_CONVERSATIONS + 2; c++) {
      for (let m = 0; m < (c === 0 ? TEAM_CHAT_EMAIL_MAX_PER_CONVERSATION + 3 : 1); m++) {
        // The first conversation is the newest (sections run newest first), so it is shown, cut.
        const n = c === 0 ? 200 + m : c * 20 + m + 1
        items.push({ ...notice(n, { group_key: `team_chat:c${c}`, metadata: { author_name: 'Ana', place: `#c${c}`, thread_root_id: null } }), words: `words ${n}` })
      }
    }
    const { text } = teamChatEmailContent({ items, link: (id) => `https://x.test/${id}` })
    expect(text).toContain('and 3 more messages')
    expect(text).toContain('and 2 more conversations')
    expect((text.match(/^#c\d$/gm) ?? []).length).toBe(TEAM_CHAT_EMAIL_MAX_CONVERSATIONS)
  })

  it('a conversation read meanwhile drops out; everything read: nothing sent (the cancel)', async () => {
    const { d, sent } = deps({ notices: [] })
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'read', messages: 0 })
    expect(sent).toHaveLength(0)
  })

  it('never twice: a second run finds every message claimed', async () => {
    const { d, sent } = deps()
    await planTeamChatEmail(req, d)
    expect(outcomeOf(await planTeamChatEmail(req, d))).toBe('read')
    expect(sent).toHaveLength(1)
  })

  it('pasted a secret, then edited it out: the email says the words now, never the notification’s', async () => {
    const words = new Map([[notice(1).target_id!, { body: 'nothing to see here', files: 0 }]])
    const { d, sent } = deps({ notices: [notice(1)], words })
    await planTeamChatEmail(req, d)
    expect(sent[0].text).toContain('nothing to see here')
    expect(sent[0].text).not.toContain('secret')
  })

  it('a deleted message, or one they may no longer read, is left out', async () => {
    const words = new Map([[notice(1).target_id!, { body: 'still here', files: 0 }]])
    const { d, sent } = deps({ words })
    expect((await planTeamChatEmail(req, d)).messages).toBe(1)
    expect(sent[0].text).toContain('still here')
    expect(sent[0].text).not.toContain('message 02')
  })

  it('mentioned, then removed from the private channel before the email goes: access is asked again right before sending, and nothing is sent', async () => {
    const { d, sent, words, readableCalls } = deps({ notices: [notice(1)] })
    // Removed between the plan and the send (right after the claims).
    const claim = d.claim
    d.claim = async (input) => {
      const out = await claim(input)
      words.clear()
      return out
    }
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'gone', messages: 0 })
    expect(sent).toHaveLength(0)
    expect(readableCalls).toHaveLength(2)
  })

  it('at an app: no email now, look again later', async () => {
    const { d, sent } = deps({ presence: async () => [{ client_id: 'c', surface: 'desktop', state: 'active', active_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW).toISOString() }] })
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'present', messages: 3 })
    expect(sent).toHaveLength(0)
  })

  it('quiet hours in their zone: wait until they end', async () => {
    const { d, sent } = deps({ timeZone: async () => 'Europe/Berlin', now: () => Date.parse('2026-11-11T22:30:00.000Z') })
    const out = await planTeamChatEmail(req, d)
    expect(out.kind).toBe('wait')
    // 08:05 the next morning in Berlin (07:05 UTC).
    expect(out.kind === 'wait' && new Date(out.untilMs).toISOString()).toBe('2026-11-12T07:05:00.000Z')
    expect(sent).toHaveLength(0)
  })

  it('no address: nothing sent; a failed send stays claimed (at most once)', async () => {
    expect(outcomeOf(await planTeamChatEmail(req, deps({ address: async () => null }).d))).toBe('no_address')
    const failing = deps({ sendEmail: async () => false })
    expect(outcomeOf(await planTeamChatEmail(req, failing.d))).toBe('failed')
    expect(failing.claims.size).toBe(3)
  })

  it('push comes first once it has an adapter (the router’s order), and a push that doesn’t go falls through to email', async () => {
    expect(teamChatAwayChannel({ push: false })).toBe('email')
    expect(teamChatAwayChannel({ push: true })).toBe('push')
    const pushed = deps({ pushTarget: async () => true, sendPush: async () => true })
    expect(await planTeamChatEmail(req, pushed.d)).toEqual({ kind: 'done', outcome: 'pushed', messages: 3 })
    expect(pushed.sent).toHaveLength(0)
    const fell = deps({ pushTarget: async () => true, sendPush: async () => false })
    expect(outcomeOf(await planTeamChatEmail(req, fell.d))).toBe('sent')
  })
})

describe('teamChatEmailContent', () => {
  const link = (id: string) => `https://x.test/${id}`
  const item = (n: number, over: Partial<TeamChatEmailItem> = {}): TeamChatEmailItem => ({ ...notice(n), words: `message ${n}`, ...over })
  it('one message: its own title; a thread’s: where; a DM’s: who; the words are escaped', () => {
    expect(teamChatEmailContent({ items: [item(1)], link }).subject).toBe('Ana Ruiz in #launch')
    const thread = [item(1), item(2)].map((n) => ({ ...n, metadata: { ...n.metadata, thread_root_id: 'r' } }))
    expect(teamChatEmailContent({ items: thread, link }).subject).toBe('2 new messages: A thread in #launch')
    const dm = [item(1), item(2)].map((n) => ({ ...n, metadata: { author_name: 'Ana Ruiz', place: null } }))
    expect(teamChatEmailContent({ items: dm, link }).subject).toBe('2 new messages: Ana Ruiz, directly to you')
    const html = teamChatEmailContent({ items: [item(1, { words: '<script>alert(1)</script>' })], link }).html
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('the request', () => {
  it('keyed by the person; a malformed event is nothing', () => {
    expect(teamChatEmailEvent({ userId: USER, workspaceId: WS })).toEqual({ name: TEAM_CHAT_EMAIL_EVENT, data: { key: USER, userId: USER, workspaceId: WS } })
    expect(parseTeamChatEmailRequest({ userId: USER, workspaceId: WS })).toEqual(req)
    expect(parseTeamChatEmailRequest({ userId: USER, workspaceId: 'nope' })).toBeNull()
    expect(parseTeamChatEmailRequest(null)).toBeNull()
  })

  it('the function waits for team chat to be quiet for the person, and a newer request cancels a waiting run, on the same key', () => {
    const opts = (teamChatEmail as unknown as { opts: Record<string, unknown> }).opts
    expect(opts.debounce).toEqual({ key: 'event.data.key', period: '3m', timeout: '10m' })
    expect(opts.cancelOn).toEqual([{ event: TEAM_CHAT_EMAIL_EVENT, match: 'data.key' }])
  })

  it('a link names its message and its workspace', () => {
    expect(teamChatMessageLink('m-1', WS, 'https://app.example.test/')).toBe(`https://app.example.test/account?team_chat_message=m-1&workspace=${WS}`)
  })
})

describe('runTeamChatEmail', () => {
  function step(decisions: unknown[]) {
    const slept: string[] = []
    return {
      slept,
      run: async (_id: string) => decisions.shift(),
      sleep: async (id: string) => void slept.push(id),
      sleepUntil: async (id: string) => void slept.push(id),
    }
  }
  const event = { data: { userId: USER, workspaceId: WS } }

  it('at an app it looks again every while, then sends once they leave', async () => {
    const s = step([{ kind: 'present', messages: 2 }, { kind: 'present', messages: 2 }, { kind: 'done', outcome: 'sent', messages: 2 }])
    expect(await runTeamChatEmail({ event, step: s as never })).toEqual({ status: 'done', outcome: 'sent', messages: 2 })
    expect(s.slept).toEqual(['recheck-1', 'recheck-2'])
  })

  it('an hour at an app and never read: the in-app notice was all', async () => {
    const s = step(Array.from({ length: 12 }, () => ({ kind: 'present', messages: 1 })))
    expect((await runTeamChatEmail({ event, step: s as never })).outcome).toBe('present_unread')
    expect(s.slept).toHaveLength(6)
  })

  it('quiet hours: waits once, then sends', async () => {
    const s = step([{ kind: 'wait', untilMs: NOW + 3_600_000, messages: 1 }, { kind: 'done', outcome: 'sent', messages: 1 }])
    expect((await runTeamChatEmail({ event, step: s as never })).outcome).toBe('sent')
    expect(s.slept).toEqual(['quiet-1'])
  })

  it('a malformed event does nothing', async () => {
    expect(await runTeamChatEmail({ event: { data: {} }, step: step([]) as never })).toEqual({ status: 'skipped', reason: 'bad_event' })
  })
})
