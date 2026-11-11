/**
 * A person's pushes (src/lib/push/send.ts) over fake deps, and what a push
 * says (src/lib/push/compose.ts): with the settings unset push is off and
 * nothing is read; on, every live install of the person's gets one push
 * with their badge, an install Apple says is gone is disabled, and the push
 * went when one install took it. An install the phone hasn't registered in
 * 30 days is no target (it stopped asking: the person must get the text,
 * Slack or email instead). A run of several pushes reads the installs and
 * counts the badge once. A team chat push names its conversation
 * and the ids the app opens it at; the agent's push says who and what.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApnsConfig, ApnsResult } from '../apns'
import { freshTokens, hasPushTarget, pushToPerson, voipToPerson, PUSH_TOKEN_FRESH_MS, type PushDeps, type PushTokenRow } from '../send'
import { homeMessagePush, pushLine, teamChatPush, PUSH_BODY_CHARS } from '../compose'

const CONFIG: ApnsConfig = { keyId: 'K', teamId: 'T', privateKey: 'pem', bundleId: 'com.example.app' }
const USER = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-11-11T20:00:00.000Z')
const row = (n: number, environment: 'sandbox' | 'production' = 'production', seenDaysAgo = 1): PushTokenRow => ({
  id: `t${n}`,
  token: String(n).repeat(64),
  environment,
  last_seen_at: new Date(NOW - seenDaysAgo * 24 * 60 * 60_000).toISOString(),
})

function fake(over: Partial<PushDeps> & { rows?: PushTokenRow[]; answers?: ApnsResult[] } = {}) {
  const answers = [...(over.answers ?? [])]
  const disabled: Array<{ id: string; reason: string }> = []
  const sent: Array<{ token: string; environment: string; badge?: number; title: string }> = []
  const voip: Array<{ token: string; environment: string; data: Record<string, unknown>; expiresAtMs: number }> = []
  const deps: PushDeps = {
    config: CONFIG,
    now: () => NOW,
    tokens: vi.fn(async () => over.rows ?? [row(1)]),
    disable: vi.fn(async (id, reason) => void disabled.push({ id, reason })),
    badge: vi.fn(async () => 4),
    send: vi.fn(async (_config, input) => {
      sent.push({ token: input.token, environment: input.environment, badge: input.notification.badge, title: input.notification.title })
      return answers.shift() ?? ({ ok: true, apnsId: null } as ApnsResult)
    }),
    sendVoip: vi.fn(async (_config, input) => {
      voip.push({ token: input.token, environment: input.environment, data: input.push.data, expiresAtMs: input.push.expiresAtMs })
      return answers.shift() ?? ({ ok: true, apnsId: null } as ApnsResult)
    }),
    ...over,
  }
  return { deps, disabled, sent, voip }
}

const note = { title: 'Ana Ruiz in #launch', body: 'Ready' }

describe('push off', () => {
  it('the settings unset: no target and nothing sent, without a single read', async () => {
    const { deps, sent } = fake({ config: null })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('off')
    expect(deps.tokens).not.toHaveBeenCalled()
    expect(deps.badge).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('on, but no live install: no target', async () => {
    const { deps } = fake({ rows: [] })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('no_target')
    expect(deps.tokens).toHaveBeenCalledWith(USER, 'com.example.app', 'alert')
  })

  it('a failed read is no target (the router falls through), never a throw', async () => {
    const { deps } = fake({ tokens: async () => Promise.reject(new Error('down')) })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('failed')
  })
})

describe('push on', () => {
  it('every live install gets it, with the person’s badge, in its own environment', async () => {
    const { deps, sent } = fake({ rows: [row(1, 'production'), row(2, 'sandbox')] })
    expect(await hasPushTarget(deps, USER)).toBe(true)
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('sent')
    expect(sent).toEqual([
      { token: '1'.repeat(64), environment: 'production', badge: 4, title: note.title },
      { token: '2'.repeat(64), environment: 'sandbox', badge: 4, title: note.title },
    ])
  })

  it('an install Apple says is gone is disabled; the push went if another took it', async () => {
    const { deps, disabled } = fake({ rows: [row(1), row(2)], answers: [{ ok: false, gone: true, status: 410, reason: 'Unregistered' }, { ok: true, apnsId: 'x' }] })
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('sent')
    expect(disabled).toEqual([{ id: 't1', reason: 'Unregistered' }])
  })

  it('every install refusing is a failure (the caller falls through); a passing refusal disables nothing', async () => {
    const { deps, disabled } = fake({ rows: [row(1)], answers: [{ ok: false, gone: false, status: 500, reason: 'InternalServerError' }] })
    expect(await pushToPerson(deps, { userId: USER, notifications: [note] })).toBe('failed')
    expect(disabled).toEqual([])
  })

  it('an install not seen in 30 days is no target: the router and the email fall through to what the person will see', async () => {
    const stale = fake({ rows: [row(1, 'production', 31)] })
    expect(await hasPushTarget(stale.deps, USER)).toBe(false)
    expect(await pushToPerson(stale.deps, { userId: USER, notifications: [note] })).toBe('no_target')
    expect(stale.sent).toHaveLength(0)
    const mixed = fake({ rows: [row(1, 'production', 31), row(2, 'production', 2)] })
    expect(await pushToPerson(mixed.deps, { userId: USER, notifications: [note] })).toBe('sent')
    expect(mixed.sent.map((x) => x.token)).toEqual(['2'.repeat(64)])
    expect(freshTokens([row(1, 'production', 29), row(2, 'production', 31)], NOW).map((r) => r.id)).toEqual(['t1'])
    expect(PUSH_TOKEN_FRESH_MS).toBe(30 * 24 * 60 * 60_000)
  })

  it('a run of several pushes reads the installs and counts the badge once', async () => {
    const { deps, sent } = fake({ rows: [row(1), row(2)] })
    expect(await pushToPerson(deps, { userId: USER, notifications: [note, { ...note, title: 'Ben Okafor' }, { ...note, title: 'Mara Chen' }] })).toBe('sent')
    expect(deps.tokens).toHaveBeenCalledTimes(1)
    expect(deps.badge).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(6)
    expect(new Set(sent.map((x) => x.badge))).toEqual(new Set([4]))
  })

  it('an install Apple says is gone is not tried again in the same run', async () => {
    const { deps, sent, disabled } = fake({ rows: [row(1), row(2)], answers: [{ ok: false, gone: true, status: 410, reason: 'Unregistered' }] })
    await pushToPerson(deps, { userId: USER, notifications: [note, note] })
    expect(sent.map((x) => x.token)).toEqual(['1'.repeat(64), '2'.repeat(64), '2'.repeat(64)])
    expect(disabled).toHaveLength(1)
  })

  it('no badge when it can’t be counted: the icon is left as it is', async () => {
    const { deps, sent } = fake({ badge: async () => null })
    await pushToPerson(deps, { userId: USER, notifications: [note] })
    expect(sent[0].badge).toBeUndefined()
  })
})

describe('a VoIP push (a team call’s ring or its cancel)', () => {
  const ring = { data: { kind: 'team_call_ring', ring_id: 'r1' }, expiresAtMs: NOW + 30_000 }

  it('goes to the person’s VoIP installs only (an alert never reads them, a ring never reads alert tokens)', async () => {
    const { deps, voip, sent } = fake({ rows: [row(1, 'production'), row(2, 'sandbox')] })
    expect(await voipToPerson(deps, { userId: USER, push: ring })).toBe('sent')
    expect(deps.tokens).toHaveBeenCalledWith(USER, 'com.example.app', 'voip')
    expect(voip).toEqual([
      { token: '1'.repeat(64), environment: 'production', data: ring.data, expiresAtMs: ring.expiresAtMs },
      { token: '2'.repeat(64), environment: 'sandbox', data: ring.data, expiresAtMs: ring.expiresAtMs },
    ])
    expect(sent).toHaveLength(0)
    expect(deps.badge).not.toHaveBeenCalled()
    await pushToPerson(deps, { userId: USER, notifications: [note] })
    expect(deps.tokens).toHaveBeenLastCalledWith(USER, 'com.example.app', 'alert')
  })

  it('push off: nothing read, nothing sent', async () => {
    const { deps, voip } = fake({ config: null })
    expect(await voipToPerson(deps, { userId: USER, push: ring })).toBe('off')
    expect(deps.tokens).not.toHaveBeenCalled()
    expect(voip).toHaveLength(0)
  })

  it('no fresh VoIP install: no target, nothing sent', async () => {
    const none = fake({ rows: [] })
    expect(await voipToPerson(none.deps, { userId: USER, push: ring })).toBe('no_target')
    const stale = fake({ rows: [row(1, 'production', 31)] })
    expect(await voipToPerson(stale.deps, { userId: USER, push: ring })).toBe('no_target')
    expect([...none.voip, ...stale.voip]).toHaveLength(0)
  })

  it('the phone that answered gets no cancel; with only it, nobody is pushed', async () => {
    const { deps, voip } = fake({ rows: [row(1), row(2)] })
    expect(await voipToPerson(deps, { userId: USER, push: ring, exceptTokens: ['1'.repeat(64).toUpperCase()] })).toBe('sent')
    expect(voip.map((v) => v.token)).toEqual(['2'.repeat(64)])
    const only = fake({ rows: [row(1)] })
    expect(await voipToPerson(only.deps, { userId: USER, push: ring, exceptTokens: ['1'.repeat(64)] })).toBe('no_target')
  })

  it('an install Apple says is gone is disabled', async () => {
    const { deps, disabled } = fake({ rows: [row(1)], answers: [{ ok: false, gone: true, status: 410, reason: 'Unregistered' }] })
    expect(await voipToPerson(deps, { userId: USER, push: ring })).toBe('failed')
    expect(disabled).toEqual([{ id: 't1', reason: 'Unregistered' }])
  })
})

describe('what a push says', () => {
  const target = { workspaceId: 'w1', channelId: 'c1', messageId: 'm3', threadRootId: null }

  it('one message: the notification’s own title and words, grouped and collapsed by its conversation', () => {
    expect(teamChatPush({ groupKey: 'team_chat:c1', target, newest: { title: 'Ana Ruiz in #launch', body: 'The deck is ready', authorName: 'Ana Ruiz', place: '#launch' }, count: 1 })).toEqual({
      title: 'Ana Ruiz in #launch',
      body: 'The deck is ready',
      threadId: 'team_chat:c1',
      collapseId: 'team_chat:c1',
      data: { kind: 'team_chat', workspace_id: 'w1', channel_id: 'c1', message_id: 'm3', thread_root_id: null },
    })
  })

  it('several: how many and where, over the newest one’s words', () => {
    const p = teamChatPush({ groupKey: 'team_chat:c1', target, newest: { title: 'Ana Ruiz in #launch', body: 'Third', authorName: 'Ana Ruiz', place: '#launch' }, count: 3 })
    expect(p.title).toBe('3 new messages in #launch')
    expect(p.body).toBe('Ana Ruiz: Third')
    const thread = teamChatPush({ groupKey: 'team_chat_thread:r1', target: { ...target, threadRootId: 'r1' }, newest: { title: 'x', body: 'Yes', authorName: 'Ana Ruiz', place: '#launch' }, count: 2 })
    expect(thread.title).toBe('2 new replies in a thread in #launch')
    expect(thread.data?.thread_root_id).toBe('r1')
    const dm = teamChatPush({ groupKey: 'team_chat:d1', target, newest: { title: 'Ana Ruiz', body: 'Hi', authorName: 'Ana Ruiz', place: null }, count: 2 })
    expect(dm.title).toBe('2 new messages from Ana Ruiz')
  })

  it('files alone still say something', () => {
    expect(teamChatPush({ groupKey: 'g', target, newest: { title: 'Ana Ruiz', body: null, authorName: 'Ana Ruiz', place: null }, count: 1 }).body).toBe('New message')
  })

  it('the excerpt is one line, bounded', () => {
    expect(pushLine('a\n\nb   c')).toBe('a b c')
    const long = pushLine('x'.repeat(500))
    expect(long).toHaveLength(PUSH_BODY_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('the agent’s message: its name, its words and what waits on the person; opens the chat', () => {
    expect(homeMessagePush({ workspaceId: 'w1', conversationId: 'h1', agentName: 'Juniper', text: 'Your 3pm moved to 4pm.', approvals: [] })).toEqual({
      title: 'Juniper',
      body: 'Your 3pm moved to 4pm.',
      threadId: 'home:h1',
      collapseId: 'home:h1',
      data: { kind: 'home_message', workspace_id: 'w1', conversation_id: 'h1' },
    })
    expect(homeMessagePush({ workspaceId: 'w1', conversationId: 'h1', agentName: '', text: '', approvals: [{ title: 'Cancel the call with Ken' }] })).toMatchObject({
      title: 'Your agent',
      body: 'Waiting on you: Cancel the call with Ken',
    })
  })
})
