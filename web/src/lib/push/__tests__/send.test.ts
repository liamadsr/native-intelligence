/**
 * A person's pushes (src/lib/push/send.ts) over fake deps, and what a push
 * says (src/lib/push/compose.ts): with the settings unset push is off and
 * nothing is read; on, every live install of the person's gets one push
 * with their badge, an install Apple says is gone is disabled, and the push
 * went when one install took it. A team chat push names its conversation
 * and the ids the app opens it at; the agent's push says who and what.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApnsConfig, ApnsResult } from '../apns'
import { hasPushTarget, pushToPerson, type PushDeps, type PushTokenRow } from '../send'
import { homeMessagePush, pushLine, teamChatPush, PUSH_BODY_CHARS } from '../compose'

const CONFIG: ApnsConfig = { keyId: 'K', teamId: 'T', privateKey: 'pem', bundleId: 'com.example.app' }
const USER = '22222222-2222-4222-8222-222222222222'
const row = (n: number, environment: 'sandbox' | 'production' = 'production'): PushTokenRow => ({ id: `t${n}`, token: String(n).repeat(64), environment })

function fake(over: Partial<PushDeps> & { rows?: PushTokenRow[]; answers?: ApnsResult[] } = {}) {
  const answers = [...(over.answers ?? [])]
  const disabled: Array<{ id: string; reason: string }> = []
  const sent: Array<{ token: string; environment: string; badge?: number; title: string }> = []
  const deps: PushDeps = {
    config: CONFIG,
    tokens: vi.fn(async () => over.rows ?? [row(1)]),
    disable: vi.fn(async (id, reason) => void disabled.push({ id, reason })),
    badge: vi.fn(async () => 4),
    send: vi.fn(async (_config, input) => {
      sent.push({ token: input.token, environment: input.environment, badge: input.notification.badge, title: input.notification.title })
      return answers.shift() ?? ({ ok: true, apnsId: null } as ApnsResult)
    }),
    ...over,
  }
  return { deps, disabled, sent }
}

const note = { title: 'Ana Ruiz in #launch', body: 'Ready' }

describe('push off', () => {
  it('the settings unset: no target and nothing sent, without a single read', async () => {
    const { deps, sent } = fake({ config: null })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('off')
    expect(deps.tokens).not.toHaveBeenCalled()
    expect(deps.badge).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('on, but no live install: no target', async () => {
    const { deps } = fake({ rows: [] })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('no_target')
    expect(deps.tokens).toHaveBeenCalledWith(USER, 'com.example.app')
  })

  it('a failed read is no target (the router falls through), never a throw', async () => {
    const { deps } = fake({ tokens: async () => Promise.reject(new Error('down')) })
    expect(await hasPushTarget(deps, USER)).toBe(false)
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('failed')
  })
})

describe('push on', () => {
  it('every live install gets it, with the person’s badge, in its own environment', async () => {
    const { deps, sent } = fake({ rows: [row(1, 'production'), row(2, 'sandbox')] })
    expect(await hasPushTarget(deps, USER)).toBe(true)
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('sent')
    expect(sent).toEqual([
      { token: '1'.repeat(64), environment: 'production', badge: 4, title: note.title },
      { token: '2'.repeat(64), environment: 'sandbox', badge: 4, title: note.title },
    ])
  })

  it('an install Apple says is gone is disabled; the push went if another took it', async () => {
    const { deps, disabled } = fake({ rows: [row(1), row(2)], answers: [{ ok: false, gone: true, status: 410, reason: 'Unregistered' }, { ok: true, apnsId: 'x' }] })
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('sent')
    expect(disabled).toEqual([{ id: 't1', reason: 'Unregistered' }])
  })

  it('every install refusing is a failure (the caller falls through); a passing refusal disables nothing', async () => {
    const { deps, disabled } = fake({ rows: [row(1)], answers: [{ ok: false, gone: false, status: 500, reason: 'InternalServerError' }] })
    expect(await pushToPerson(deps, { userId: USER, notification: note })).toBe('failed')
    expect(disabled).toEqual([])
  })

  it('no badge when it can’t be counted: the icon is left as it is', async () => {
    const { deps, sent } = fake({ badge: async () => null })
    await pushToPerson(deps, { userId: USER, notification: note })
    expect(sent[0].badge).toBeUndefined()
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
