/**
 * Team chat by email while you are away (src/lib/team-chat/email.ts, the
 * `team-chat-email` Inngest function): a burst in one conversation is one
 * email; reading it first cancels it; at an app, or in quiet hours, it waits;
 * a message is never emailed twice, nor a deleted one; push (no adapter yet)
 * comes before email in the router's order and falls through.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: (opts: unknown, fn: unknown) => ({ opts, fn }), send: vi.fn() } }))

import {
  hasUnreadTeamChatNotices,
  parseTeamChatEmailRequest,
  planTeamChatEmail,
  sendTeamChatRead,
  teamChatAwayChannel,
  teamChatEmailContent,
  teamChatEmailKey,
  teamChatMessageLink,
  TEAM_CHAT_EMAIL_EVENT,
  TEAM_CHAT_READ_EVENT,
  type TeamChatEmailDecision,
  type TeamChatEmailDeps,
  type TeamChatEmailNotice,
  type TeamChatEmailRequest,
} from '../email'
import { runTeamChatEmail, teamChatEmail } from '@/lib/inngest/team-chat-reach'

const USER = '22222222-2222-4222-8222-222222222222'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const WS = '11111111-1111-4111-8111-111111111111'
const CH = '55555555-5555-4555-8555-555555555555'
const GROUP = `team_chat:${CH}`
const NOW = Date.parse('2026-11-11T20:00:00.000Z')

const req: TeamChatEmailRequest = { key: teamChatEmailKey(USER, GROUP), userId: USER, memberId: MEMBER, workspaceId: WS, groupKey: GROUP }

function notice(n: number, over: Partial<TeamChatEmailNotice> = {}): TeamChatEmailNotice {
  return {
    id: `n0000000-0000-4000-8000-00000000000${n}`,
    created_at: new Date(NOW - (10 - n) * 60_000).toISOString(),
    title: 'Ana Ruiz in #launch',
    body: `message ${n}`,
    target_id: `m0000000-0000-4000-8000-00000000000${n}`,
    metadata: { author_name: 'Ana Ruiz', place: '#launch', thread_root_id: null },
    ...over,
  }
}

function deps(over: Partial<TeamChatEmailDeps> & { notices?: TeamChatEmailNotice[] } = {}) {
  const claims = new Set<string>()
  const sent: Array<{ to: string; subject: string; html: string; text: string }> = []
  const notices = over.notices ?? [notice(1), notice(2), notice(3)]
  const d: TeamChatEmailDeps = {
    now: () => NOW,
    unread: async () => notices,
    claimed: async ({ ids }) => new Set(ids.filter((id) => [...claims].some((c) => c.endsWith(`:${id}`)))),
    liveMessages: async (ids) => new Set(ids),
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
    link: (id) => teamChatMessageLink(id, 'https://app.example.test'),
    ...over,
  }
  return { d, sent, claims }
}

const outcomeOf = (d: TeamChatEmailDecision) => (d.kind === 'done' ? d.outcome : d.kind)

describe('planTeamChatEmail', () => {
  it('a burst in one conversation is ONE email carrying every unread message, linked to the newest', async () => {
    const { d, sent } = deps()
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'sent', messages: 3 })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ana@example.test')
    expect(sent[0].subject).toBe('3 new messages in #launch')
    for (const n of [1, 2, 3]) expect(sent[0].text).toContain(`Ana Ruiz: message ${n}`)
    expect(sent[0].text).toContain(`https://app.example.test/account?team_chat_message=${notice(3).target_id}`)
  })

  it('read first: nothing unread, nothing sent (the cancel)', async () => {
    const { d, sent } = deps({ notices: [] })
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'read', messages: 0 })
    expect(sent).toHaveLength(0)
  })

  it('never twice: a second run finds every message claimed', async () => {
    const { d, sent } = deps()
    await planTeamChatEmail(req, d)
    expect(await planTeamChatEmail(req, d)).toEqual({ kind: 'done', outcome: 'read', messages: 0 })
    expect(sent).toHaveLength(1)
  })

  it('a message deleted since is left out', async () => {
    const { d, sent } = deps({ liveMessages: async (ids) => new Set(ids.filter((id) => id !== notice(2).target_id)) })
    expect((await planTeamChatEmail(req, d)).messages).toBe(2)
    expect(sent[0].text).not.toContain('message 2')
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
  it('one message: its own title; a thread’s: replies; a DM’s: who wrote; the words are escaped', () => {
    expect(teamChatEmailContent({ notices: [notice(1)], link: 'https://x.test' }).subject).toBe('Ana Ruiz in #launch')
    const thread = [notice(1), notice(2)].map((n) => ({ ...n, metadata: { ...n.metadata, thread_root_id: 'r' } }))
    expect(teamChatEmailContent({ notices: thread, link: 'https://x.test' }).subject).toBe('2 new replies in a thread in #launch')
    const dm = [notice(1), notice(2)].map((n) => ({ ...n, metadata: { author_name: 'Ana Ruiz', place: null } }))
    expect(teamChatEmailContent({ notices: dm, link: 'https://x.test' }).subject).toBe('2 new messages from Ana Ruiz')
    const html = teamChatEmailContent({ notices: [notice(1, { body: '<script>alert(1)</script>' })], link: 'https://x.test' }).html
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('the request and the cancel', () => {
  it('keys one email per person and conversation; a malformed event is nothing', () => {
    expect(parseTeamChatEmailRequest({ userId: USER, memberId: MEMBER, workspaceId: WS, groupKey: GROUP })).toEqual(req)
    expect(parseTeamChatEmailRequest({ userId: USER, memberId: MEMBER, workspaceId: WS, groupKey: 'team_chat:nope' })).toBeNull()
    expect(parseTeamChatEmailRequest(null)).toBeNull()
  })

  it('the function waits for a quiet conversation, and reading it (or a newer request) cancels a waiting run, on the same key', () => {
    const opts = (teamChatEmail as unknown as { opts: Record<string, unknown> }).opts
    expect(opts.debounce).toEqual({ key: 'event.data.key', period: '3m', timeout: '10m' })
    expect(opts.cancelOn).toEqual([
      { event: TEAM_CHAT_READ_EVENT, match: 'data.key' },
      { event: TEAM_CHAT_EMAIL_EVENT, match: 'data.key' },
    ])
  })

  it('reading sends the cancel, keyed as the email is', async () => {
    const sent: unknown[] = []
    await sendTeamChatRead({ userId: USER, groupKey: GROUP }, async (e) => void sent.push(e))
    expect(sent).toEqual([{ name: TEAM_CHAT_READ_EVENT, data: { key: req.key } }])
  })

  it('whether there is anything to cancel is read from the person’s own unread notifications of that conversation', async () => {
    const calls: Array<[string, unknown]> = []
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) builder[m] = (...a: unknown[]) => (calls.push([m, a]), builder)
    builder.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'n1' }], error: null }).then(ok)
    const supabase = { from: () => builder } as never
    expect(await hasUnreadTeamChatNotices(supabase, { memberId: MEMBER, groupKey: GROUP })).toBe(true)
    expect(calls).toContainEqual(['eq', ['group_key', GROUP]])
    expect(calls).toContainEqual(['eq', ['is_read', false]])
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
  const event = { data: { userId: USER, memberId: MEMBER, workspaceId: WS, groupKey: GROUP } }

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
