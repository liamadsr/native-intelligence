/**
 * The agent's inbox writers (A6 slice 1): the one writer (record.ts) and the
 * producers that hand it events: work moves (work.ts, and the recorder
 * calling it), the mail seam (email.ts, with the known-sender flag) and
 * the notice tap (notice.ts). Meetings starting soon: meetings.test.ts.
 *
 * Pinned: one row per (workspace, user, dedupe key), never twice; facts are
 * templated (clipped, cleaned, capped, unknown keys dropped); the router is
 * woken once per person per write; a failed write never throws into the
 * caller; each producer's kind, ref and dedupe key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('pass a client') } }))

import { agentEventRow, cleanFacts, findUnroutedPeople, recordAgentEvents } from '../record'
import { workAgentEvent } from '../work'
import { emailEventInputs, recordDraftPassEvents, recordEmailEvent, threadsAwaitingReply } from '../email'
import { recordNoticeEvent } from '../notice'
import { AGENT_EVENT_CREATED, noticeEventKind } from '../types'

let db: FakeSupabase
let send: ReturnType<typeof vi.fn>

beforeEach(() => {
  db = makeFakeSupabase()
  send = vi.fn(async () => {})
})

const base = { workspaceId: 'w1', userId: 'u1' }

describe('cleanFacts: an arrived email', () => {
  it('keeps its kind from the seven words and its two answers as booleans only', () => {
    expect(cleanFacts({ from: 'a@b.com', emailKind: 'meeting', shouldKnow: true, needsInput: false })).toEqual({ from: 'a@b.com', emailKind: 'meeting', shouldKnow: true, needsInput: false })
    expect(cleanFacts({ emailKind: 'gossip' as never, shouldKnow: 'yes' as never })).toEqual({})
  })
})

describe('cleanFacts: a capture of someone getting started', () => {
  it('keeps firstRun only as a flag', () => {
    expect(cleanFacts({ title: 'Hello', firstRun: true })).toEqual({ title: 'Hello', firstRun: true })
    expect(cleanFacts({ firstRun: 'yes' as never })).toEqual({})
  })
})

describe('cleanFacts: a meeting change', () => {
  it('keeps the change from its three words, the new start as ISO, and the head count as a whole number', () => {
    expect(cleanFacts({ title: 'Board prep', change: 'moved', movedTo: '2026-10-20T21:30:00Z', attendeeCount: 3 })).toEqual({
      title: 'Board prep', change: 'moved', movedTo: '2026-10-20T21:30:00.000Z', attendeeCount: 3,
    })
    expect(cleanFacts({ change: 'deleted' as never, movedTo: 'tomorrow', attendeeCount: -1 })).toEqual({})
  })
})

describe('cleanFacts / agentEventRow', () => {
  it('clips and cleans strings, keeps flags only as booleans, drops unknown keys', () => {
    const facts = cleanFacts({
      title: `  <b>Acme</b>​ ${'x'.repeat(200)}`,
      notified: 'yes' as unknown as boolean,
      prepReady: true,
      body: 'never stored',
      meetingRef: 'elsewhere' as never,
    } as never)
    expect(facts.title!.startsWith('‹b›Acme‹/b›')).toBe(true)
    expect(Array.from(facts.title!).length).toBeLessThanOrEqual(80)
    expect(facts.title!.endsWith('…')).toBe(true)
    expect(facts).not.toHaveProperty('notified')
    expect(facts.prepReady).toBe(true)
    expect(facts).not.toHaveProperty('body')
    expect(facts).not.toHaveProperty('meetingRef')
  })

  it('files the kind under its source, clamps the priority, refuses a row with no owner, bad kind or key', () => {
    const row = agentEventRow({ ...base, kind: 'email.drafted', priority: 9, dedupeKey: ' k ' })!
    expect(row).toMatchObject({ source: 'email', kind: 'email.drafted', priority: 3, dedupe_key: 'k', workspace_id: 'w1', user_id: 'u1' })
    expect(agentEventRow({ ...base, userId: '', kind: 'mention', dedupeKey: 'k' })).toBeNull()
    expect(agentEventRow({ ...base, kind: 'nope' as never, dedupeKey: 'k' })).toBeNull()
    expect(agentEventRow({ ...base, kind: 'mention', dedupeKey: 'k'.repeat(301) })).toBeNull()
  })
})

describe('recordAgentEvents', () => {
  it('writes each event once per dedupe key and wakes the router once per person', async () => {
    const events = [
      { ...base, kind: 'email.drafted' as const, dedupeKey: 'email:draft:d1', facts: { title: 'Re: Pricing' } },
      { ...base, kind: 'email.drafted' as const, dedupeKey: 'email:draft:d2', facts: { title: 'Re: Demo' } },
      { workspaceId: 'w1', userId: 'u2', kind: 'mention' as const, dedupeKey: 'mention:n1' },
    ]
    expect(await recordAgentEvents(events, db as never, { send })).toBe(3)
    expect(await recordAgentEvents(events, db as never, { send })).toBe(0)
    expect(db.rows('agent_event')).toHaveLength(3)
    // Woken on the duplicate pass too (a lost first send still wakes it).
    expect(send).toHaveBeenCalledTimes(4)
    expect(send.mock.calls[0][0]).toEqual({ name: AGENT_EVENT_CREATED, data: { workspaceId: 'w1', userId: 'u1', personKey: 'w1:u1' } })
  })

  it('never throws: a failed write is skipped (and wakes nobody), a failed send is logged', async () => {
    db.failNextInsert('agent_event', { message: 'relation does not exist' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await recordAgentEvents([{ ...base, kind: 'mention', dedupeKey: 'm' }], db as never, { send })).toBe(0)
    expect(send).not.toHaveBeenCalled()
    const failing = vi.fn(async () => { throw new Error('inngest down') })
    expect(await recordAgentEvents([{ ...base, kind: 'mention', dedupeKey: 'm2' }], db as never, { send: failing })).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('work events (the recorder producer)', () => {
  const target = { workItemId: 'job-1', workspaceId: 'w1', userId: 'u1', title: 'Reply drafts', area: 'mail', kind: 'work_run' }

  it('maps the moves that matter, keyed as the log keys them', () => {
    const at = '2026-10-14T10:00:00.000Z'
    expect(workAgentEvent(target, { type: 'work_needs_input', at }, { notified: true })).toMatchObject({
      kind: 'work.needs_input',
      priority: 2,
      refType: 'work_item',
      refId: 'job-1',
      dedupeKey: `work:job-1:needs_input:${Date.parse(at)}`,
      facts: { title: 'Reply drafts', workKind: 'work_run', area: 'mail', notified: true },
    })
    expect(workAgentEvent(target, { type: 'work_failed', at }, { notified: false })).toMatchObject({ kind: 'work.failed', dedupeKey: 'work:job-1:failed', facts: { notified: false } })
    // Finished work sends no notice of its own.
    expect(workAgentEvent(target, { type: 'work_done', at }, { notified: true })!.facts!.notified).toBe(false)
    expect(workAgentEvent(target, { type: 'work_started', at }, { notified: false })).toBeNull()
    expect(workAgentEvent(target, { type: 'work_canceled', at }, { notified: false })).toBeNull()
  })

  it('a finish collapses to one row per item per LOCAL day; a routine’s per flow (each fire is its own item)', () => {
    const at = '2026-10-14T19:00:00.000Z'
    expect(workAgentEvent(target, { type: 'work_done', at }, { notified: false })!.dedupeKey).toBe('work:job-1:done:2026-10-14')
    // 08:00 the next day in Auckland.
    expect(workAgentEvent(target, { type: 'work_done', at }, { notified: false, timeZone: 'Pacific/Auckland' })!.dedupeKey).toBe('work:job-1:done:2026-10-15')
    expect(workAgentEvent(target, { type: 'work_done', at }, { notified: false, timeZone: 'Not/AZone' })!.dedupeKey).toBe('work:job-1:done:2026-10-14')
    const fire = { ...target, workItemId: 'fire-7', kind: 'flow_run', flowId: 'flow-1' }
    expect(workAgentEvent(fire, { type: 'work_done', at }, { notified: false })).toMatchObject({ refId: 'fire-7', dedupeKey: 'work:flow:flow-1:done:2026-10-14' })
    // The other moves keep one row per move.
    expect(workAgentEvent(fire, { type: 'work_failed', at }, { notified: true })!.dedupeKey).toBe('work:fire-7:failed')
  })

  it('the email-drafts pass speaks only through its failure (its drafts come through the mail seam)', () => {
    const at = '2026-10-14T05:00:00.000Z'
    const pass = { ...target, kind: 'email_drafts' }
    expect(workAgentEvent(pass, { type: 'work_needs_review', at }, { notified: true })).toBeNull()
    expect(workAgentEvent(pass, { type: 'work_done', at, delivered: 3 }, { notified: false })).toBeNull()
    expect(workAgentEvent(pass, { type: 'work_failed', at }, { notified: true })!.kind).toBe('work.failed')
  })
})

describe('the unrouted sweep', () => {
  it('names each person once with rows left new for over 5 minutes; fresh and routed rows are not', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const ago = (m: number) => new Date(now - m * 60_000).toISOString()
    const db = makeFakeSupabase()
    db.seed('agent_event', [
      { id: '1', workspace_id: 'w1', user_id: 'u1', state: 'new', created_at: ago(20) },
      { id: '2', workspace_id: 'w1', user_id: 'u1', state: 'new', created_at: ago(10) },
      { id: '3', workspace_id: 'w1', user_id: 'u2', state: 'new', created_at: ago(2) },
      { id: '4', workspace_id: 'w2', user_id: 'u3', state: 'routed', created_at: ago(60) },
      { id: '5', workspace_id: 'w2', user_id: 'u4', state: 'new', created_at: ago(6) },
    ])
    expect(await findUnroutedPeople(db as never, now)).toEqual([
      { workspaceId: 'w1', userId: 'u1', personKey: 'w1:u1' },
      { workspaceId: 'w2', userId: 'u4', personKey: 'w2:u4' },
    ])
  })
})

describe('the mail seam', () => {
  it('records one event per draft and per thread waiting on a reply, templated', async () => {
    const inputs = emailEventInputs({
      ...base,
      drafted: [{ draftId: 'd1', from: 'dana@acme.com', contactId: 'c1' }],
      needsReply: [{ accountId: 'acc', providerThreadId: 't1', providerMessageId: 'm9', from: 'dana@acme.com', reason: 'cap' }],
    })
    expect(inputs.map((i) => [i.kind, i.dedupeKey, i.refType])).toEqual([
      ['email.drafted', 'email:draft:d1', 'email_draft'],
      ['email.needs_reply', 'email:acc:t1:m9', 'email_thread'],
    ])
    // Pointers and an address: never a subject (no stored mail).
    expect(inputs.map((i) => i.facts)).toEqual([
      { from: 'dana@acme.com', contactId: 'c1' },
      { from: 'dana@acme.com', reason: 'cap' },
    ])
    expect(await recordEmailEvent({ ...base, drafted: [{ draftId: 'd1' }] }, db as never, { send })).toBe(1)
    expect(await recordEmailEvent({ ...base }, db as never, { send })).toBe(0)
    expect(await recordEmailEvent({ workspaceId: '', userId: 'u1', drafted: [{ draftId: 'd1' }] }, db as never, { send })).toBe(0)
  })

  it('finds threads still needing a reply: candidates in the window, less drafted ones and pending drafts', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const recent = '2026-10-14T09:00:00.000Z'
    db.seed('email_thread_index', [
      { id: 'th1', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p1', provider_message_id: 'm1', from_email: 'dana@acme.com', linked_contact_id: 'c1', last_message_at: recent },
      { id: 'th2', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'important', account_id: 'acc', provider_thread_id: 'p2', subject: 'Drafted now', last_message_at: recent },
      { id: 'th3', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p3', subject: 'Has a draft', last_message_at: recent },
      { id: 'th4', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'newsletter', account_id: 'acc', provider_thread_id: 'p4', last_message_at: recent },
      { id: 'th5', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p5', last_message_at: '2026-10-10T09:00:00.000Z' },
      { id: 'th6', user_id: 'u2', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p6', last_message_at: recent },
    ])
    db.seed('email_draft', [{ email_thread_id: 'th3', status: 'pending_review' }])
    const found = await threadsAwaitingReply(db as never, { userId: 'u1', workspaceId: 'w1', draftedThreadIds: ['th2'], nowMs: now })
    expect(found).toEqual([
      { accountId: 'acc', providerThreadId: 'p1', providerMessageId: 'm1', from: 'dana@acme.com', contactId: 'c1', reason: 'not_drafted', at: recent, known: true },
    ])
  })

  it('a thread the gate asked about waits with its own reason (unsure), over the pass\'s (E3)', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const recent = '2026-10-14T09:00:00.000Z'
    db.seed('email_thread_index', [
      { id: 'th1', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p1', provider_message_id: 'm1', from_email: 'dana@acme.com', last_message_at: recent },
      { id: 'th2', user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc', provider_thread_id: 'p2', provider_message_id: 'm2', from_email: 'sam@acme.com', last_message_at: recent },
    ])
    const found = await threadsAwaitingReply(db as never, { userId: 'u1', workspaceId: 'w1', reasons: { p1: 'unsure' }, nowMs: now })
    expect(Object.fromEntries(found.map((t) => [t.providerThreadId, t.reason]))).toEqual({ p1: 'unsure', p2: 'not_drafted' })
  })

  describe('recordDraftPassEvents (both drafting paths)', () => {
    const now = Date.parse('2026-10-15T12:00:00.000Z')
    const fresh = '2026-10-15T11:30:00.000Z'
    const older = '2026-10-15T08:00:00.000Z'
    const thread = (id: string, at: string, over: Record<string, unknown> = {}) => ({
      id, user_id: 'u1', workspace_id: 'w1', needs_reply: true, auto_classified: 'personal', account_id: 'acc',
      provider_thread_id: `p-${id}`, provider_message_id: `m-${id}`, from_email: 'dana@acme.com', last_message_at: at, ...over,
    })

    it('arrival: the drafts, and only the handed threads left without one, with the gate as the reason', async () => {
      db.seed('email_thread_index', [thread('a', fresh), thread('b', fresh), thread('c', fresh)])
      const n = await recordDraftPassEvents(db as never, {
        userId: 'u1',
        workspaceId: 'w1',
        drafts: [{ id: 'd1', created_at: fresh, email_thread_id: 'a' }],
        providerThreadIds: ['p-a', 'p-b'],
        reason: 'cap',
        nowMs: now,
      }, { send })
      expect(n).toBe(2)
      const rows = db.rows('agent_event')
      expect(rows.map((r) => [r.kind, r.dedupe_key])).toEqual([
        ['email.drafted', 'email:draft:d1'],
        ['email.needs_reply', 'email:acc:p-b:m-b'],
      ])
      expect(rows[1].facts).toEqual({ from: 'dana@acme.com', reason: 'cap' })
    })

    it('the same thread revision reported by both paths lands one row', async () => {
      db.seed('email_thread_index', [thread('b', older)])
      const args = { userId: 'u1', workspaceId: 'w1', drafts: [], nowMs: now }
      expect(await recordDraftPassEvents(db as never, { ...args, providerThreadIds: ['p-b'], reason: 'paused' }, { send })).toBe(1)
      expect(await recordDraftPassEvents(db as never, { ...args, lastMessageBefore: '2026-10-15T10:00:00.000Z' }, { send })).toBe(0)
      expect(db.rows('agent_event')).toHaveLength(1)
    })

    it('the safety net leaves fresh threads (inside its margin) to arrival, and an edited draft counts as a draft', async () => {
      db.seed('email_thread_index', [thread('fresh', fresh), thread('old', older), thread('edited', older)])
      db.seed('email_draft', [{ email_thread_id: 'edited', status: 'edited' }])
      await recordDraftPassEvents(db as never, {
        userId: 'u1', workspaceId: 'w1', drafts: [], lastMessageBefore: '2026-10-15T10:00:00.000Z', nowMs: now,
      }, { send })
      expect(db.rows('agent_event').map((r) => r.dedupe_key)).toEqual(['email:acc:p-old:m-old'])
    })

    it('an empty thread list reports nothing', async () => {
      db.seed('email_thread_index', [thread('a', fresh)])
      expect(await recordDraftPassEvents(db as never, { userId: 'u1', workspaceId: 'w1', drafts: [], providerThreadIds: [], nowMs: now }, { send })).toBe(0)
    })
  })
})

describe('the notice tap', () => {
  it('maps each notification type to the kind it records, and the rest to none', () => {
    expect(noticeEventKind('comment_reply')).toBe('mention')
    expect(noticeEventKind('capture_shared')).toBe('mention')
    expect(noticeEventKind('action_status_changed')).toBe('activity')
    expect(noticeEventKind('cycle_started')).toBe('activity')
    expect(noticeEventKind('reminder')).toBe('reminder.due')
    expect(noticeEventKind('contact_followup_due')).toBe('contact.followup_due')
    for (const type of ['work_failed', 'work_needs_you', 'meeting_starting_soon', 'agent_digest', 'flow_run_output', 'feedback_requested', 'constructor', 'toString']) {
      expect(noticeEventKind(type)).toBeNull()
    }
  })

  it('records a mention for the recipient’s user, keyed on the notification, with its target', async () => {
    db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    const notice = { notificationId: 'n1', workspaceId: 'w1', recipientMemberId: 'm1', type: 'comment_added', title: 'Dana commented on GEN-4', targetType: 'action', targetId: 'a1' }
    expect(await recordNoticeEvent(notice, db as never, { send })).toBe(1)
    expect(db.rows('agent_event')[0]).toMatchObject({
      kind: 'mention',
      source: 'mention',
      priority: 1,
      user_id: 'u1',
      ref_type: 'notification',
      ref_id: 'n1',
      dedupe_key: 'mention:n1',
      facts: { title: 'Dana commented on GEN-4', notificationType: 'comment_added', targetType: 'action', targetId: 'a1' },
    })
    expect(await recordNoticeEvent({ ...notice, type: 'work_failed', notificationId: 'n2' }, db as never, { send })).toBe(0)
    expect(await recordNoticeEvent({ ...notice, recipientMemberId: 'nobody', notificationId: 'n3' }, db as never, { send })).toBe(0)
  })

  it('records the other notices under their own kinds, sources and priorities', async () => {
    db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    const notice = { workspaceId: 'w1', recipientMemberId: 'm1' }
    await recordNoticeEvent({ ...notice, notificationId: 'n1', type: 'action_unassigned', title: 'Sam unassigned you from GEN-4' }, db as never, { send })
    await recordNoticeEvent({ ...notice, notificationId: 'n2', type: 'reminder', title: 'Ship the deck', targetType: 'action', targetId: 'a1' }, db as never, { send })
    await recordNoticeEvent({ ...notice, notificationId: 'n3', type: 'contact_followup_due', title: 'Follow up with Jane' }, db as never, { send })
    await recordNoticeEvent({ ...notice, notificationId: 'n4', type: 'flow_run_output', kind: 'sequence.failed', title: 'Sequence send failed: Q4' }, db as never, { send })
    const rows = db.rows('agent_event').map((r) => [r.kind, r.source, r.priority, r.dedupe_key])
    expect(rows).toEqual([
      ['activity', 'mention', 0, 'notice:n1'],
      ['reminder.due', 'reminder', 2, 'notice:n2'],
      ['contact.followup_due', 'crm', 0, 'notice:n3'],
      ['sequence.failed', 'work', 2, 'notice:n4'],
    ])
  })
})
