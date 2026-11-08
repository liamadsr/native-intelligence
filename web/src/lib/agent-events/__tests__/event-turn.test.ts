/**
 * The event turn's rows and the bridge's counts (src/lib/agent-events/
 * event-turn.ts, live-followups.ts).
 *
 * Pinned: an event turn names each thread or item with Native Intelligence's phrase and
 * its pointer, never mail text, capped with "…and N more"; a turn marks the
 * rows it carried delivered (only routed, undelivered ones of the person); a
 * report turn delivers its work items' rows; the live agent's open asks and
 * the staged proposals ride a processed meeting as counts, only when the
 * meeting had a live agent.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { EVENT_TURN_MAX_LINES, eventTurnBody, eventTurnLine, markEventsDelivered, markWorkEventsDelivered, type EventTurnRow } from '../event-turn'
import { captureLiveFollowups, isOpenAsk } from '../live-followups'

const r = (over: Partial<EventTurnRow>): EventTurnRow => ({ id: '1', kind: 'email.drafted', facts: {}, occurs_at: '2026-10-14T10:00:00.000Z', ref_type: null, ref_id: null, ...over })

describe('eventTurnLine: a reply Native Intelligence was unsure of (E3)', () => {
  it('tells the agent to ask the person, and to draft only on a yes', () => {
    expect(eventTurnLine(r({ kind: 'email.needs_reply', ref_type: 'email_thread', ref_id: 'p1', facts: { from: 'healy@vendor.example', reason: 'unsure', known: true } }))).toBe(
      "- Maybe a reply from healy@vendor.example: Native Intelligence wasn't sure one is needed, so none was drafted. Ask the person whether they want a reply; draft one only if they say yes. [email_thread p1]",
    )
  })
})

describe('eventTurnLine: an arrived email (E2)', () => {
  it('names what it is and who sent it, and tells the agent to read it live before saying what it is', () => {
    expect(eventTurnLine(r({ kind: 'email.arrived', ref_type: 'email_thread', ref_id: 't1', facts: { emailKind: 'account_or_security', shouldKnow: true, needsInput: false, from: 'no-reply@accounts.google.com' } }))).toBe(
      '- An account or security notice from no-reply@accounts.google.com, worth telling the person about. Read it live before saying what it is. [email_thread t1]',
    )
    expect(eventTurnLine(r({ kind: 'email.arrived', facts: { emailKind: 'conversation', needsInput: true, from: 'dana@acme.example', contactId: 'c1' } }))).toBe(
      '- A message from dana@acme.example [contact c1]. It asks them for something only they can answer. Read it live before saying what it is.',
    )
  })
})

describe('eventTurnLine: a meeting change (E4)', () => {
  const change = (facts: EventTurnRow['facts']) => r({ kind: 'meeting.changed', occurs_at: '2026-10-20T20:00:00.000Z', ref_type: 'calendar_event', ref_id: 'evt-1', facts: { title: 'Board prep', ...facts } })
  it('names what happened and its times in the person\'s zone, with who else was in it and its pointer', () => {
    expect(eventTurnLine(change({ change: 'cancelled', attendeeCount: 2 }), 'America/New_York')).toBe(
      '- A meeting was cancelled: “Board prep” (with 2 other people), which was at 4:00 PM EDT on Tuesday, October 20. [calendar_event evt-1]',
    )
    expect(eventTurnLine(change({ change: 'removed', attendeeCount: 1 }), 'America/New_York')).toBe(
      '- A meeting is no longer on the person\'s calendar: “Board prep” (with 1 other person), which was at 4:00 PM EDT on Tuesday, October 20 (cancelled, or moved more than a day away). [calendar_event evt-1]',
    )
    expect(eventTurnLine(change({ change: 'moved', movedTo: '2026-10-20T21:30:00.000Z', attendeeCount: 1 }), 'America/New_York')).toBe(
      '- A meeting moved: “Board prep” (with 1 other person), from 4:00 PM EDT on Tuesday, October 20 to 5:30 PM EDT on Tuesday, October 20. [calendar_event evt-1]',
    )
    // No zone known: UTC, still named.
    expect(eventTurnLine(change({ change: 'cancelled' }))).toContain('which was at 8:00 PM UTC on Tuesday, October 20')
    expect(eventTurnBody([change({ change: 'cancelled' })], 'America/New_York')?.lines[0]).toContain('4:00 PM EDT')
  })
})

describe('eventTurnLine: the notices the notifications page used to hold', () => {
  it('names each in Native Intelligence’s phrase and points at what the notification points at, never the notification', () => {
    const notice = (over: Partial<EventTurnRow>): EventTurnRow => ({ id: '1', kind: 'mention', facts: {}, occurs_at: '2026-10-20T10:00:00.000Z', ref_type: 'notification', ref_id: 'n-1', ...over })
    expect(eventTurnLine(notice({ facts: { title: 'Dana replied on GEN-4', notificationType: 'comment_reply', targetType: 'action', targetId: 'a-1' } }))).toBe(
      '- A reply to your comment: “Dana replied on GEN-4”. [action a-1]',
    )
    expect(eventTurnLine(notice({ facts: { title: 'Sam shared "Plan" with you', notificationType: 'capture_shared', targetType: 'document', targetId: 'doc-1' } }))).toBe(
      '- Shared with you: “Sam shared "Plan" with you”. [document doc-1]',
    )
    expect(eventTurnLine(notice({ kind: 'reminder.due', facts: { title: 'Ship the deck', targetType: 'action', targetId: 'a-2' } }))).toBe(
      '- A reminder the person set came due: “Ship the deck”. [action a-2]',
    )
    expect(eventTurnLine(notice({ kind: 'sequence.failed', facts: { title: 'Sequence send failed: Q4', targetType: 'sequence', targetId: 's-1' } }))).toBe(
      '- An outreach sequence of theirs had a problem: “Sequence send failed: Q4”. [sequence s-1]',
    )
    // No target: no pointer (the notification itself can't be opened).
    expect(eventTurnLine(notice({ facts: { title: 'Mentioned' } }))).toBe('- A teammate wants them: “Mentioned”.')
    // A work failure keeps its work item's pointer.
    expect(eventTurnLine(notice({ kind: 'work.failed', facts: { title: 'Nightly import' }, ref_type: 'work_item', ref_id: 'job-1' }))).toBe(
      '- A background job failed: “Nightly import”. [work_item job-1]',
    )
  })
})

describe('eventTurnLine / eventTurnBody', () => {
  it('a mail row names the sender\'s address and contact pointer, never a subject; nothing else of the mail', () => {
    expect(eventTurnLine(r({ facts: { from: 'dana@acme.com', contactId: 'c-1', known: true }, ref_type: 'email_draft', ref_id: 'd-1' }))).toBe(
      '- Reply needed from dana@acme.com [contact c-1]. A draft is ready in the review pile (Mail, To review). [email_draft d-1]',
    )
    // An old row's title (a subject) is never rendered.
    expect(eventTurnLine(r({ kind: 'email.needs_reply', facts: { title: 'Intro' }, ref_type: 'email_thread', ref_id: 'pt-1' }))).toBe('- Reply needed. No draft yet. [email_thread pt-1]')
    expect(eventTurnLine(r({ kind: 'capture.processed', facts: { title: 'Acme sync', openAsks: 1, pendingProposals: 3 }, ref_type: 'capture', ref_id: 'cap-1' }))).toBe(
      '- Meeting over: “Acme sync”: 1 open question from the live agent nobody answered in the call; 3 staged proposals waiting for review. [capture cap-1]',
    )
    expect(eventTurnLine(r({ kind: 'work.approval', facts: { title: 'Approve send?', door: 'skill_run' }, ref_type: 'tool_approval', ref_id: 'ap-1' }))).toContain('held by an unattended skill_run')
  })

  it("a first capture while getting started points at its step, and keeps what the live agent left open", () => {
    expect(eventTurnLine(r({ kind: 'capture.processed', facts: { title: 'Talking to myself', firstRun: true }, ref_type: 'capture', ref_id: 'cap-1' }))).toBe(
      '- Their first capture while getting started is processed: “Talking to myself”. Its notes and to-dos are ready: show them what it pulled out (getting-started step 3). [capture cap-1]',
    )
    expect(eventTurnLine(r({ kind: 'capture.processed', facts: { title: 'Talking to myself', firstRun: true, pendingProposals: 2 }, ref_type: 'capture', ref_id: 'cap-1' }))).toBe(
      '- Their first capture while getting started is processed: “Talking to myself”. Its notes and to-dos are ready: show them what it pulled out (getting-started step 3). Also: 2 staged proposals waiting for review. [capture cap-1]',
    )
  })

  it('at most EVENT_TURN_MAX_LINES lines, then how many more; nothing to carry is null', () => {
    const rows = Array.from({ length: EVENT_TURN_MAX_LINES + 2 }, (_, i) => r({ id: String(i + 1), facts: { title: `T${i}` } }))
    const body = eventTurnBody(rows)!
    expect(body.lines).toHaveLength(EVENT_TURN_MAX_LINES + 1)
    expect(body.lines.at(-1)).toBe('- …and 2 more')
    expect(body.eventIds).toHaveLength(EVENT_TURN_MAX_LINES + 2)
    expect(eventTurnBody([])).toBeNull()
  })
})

describe('delivery marks', () => {
  it('an event turn marks only the person\'s routed, undelivered rows it carried', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_event', [
      { id: '1', workspace_id: 'w1', user_id: 'u1', state: 'routed', outcome: 'turn', delivered_at: null },
      { id: '2', workspace_id: 'w1', user_id: 'u1', state: 'delivered', outcome: 'turn', delivered_at: '2026-10-14T09:00:00.000Z', delivered_key: 'away:x' },
      { id: '3', workspace_id: 'w1', user_id: 'u2', state: 'routed', outcome: 'turn', delivered_at: null },
      { id: '4', workspace_id: 'w1', user_id: 'u1', state: 'new', outcome: null, delivered_at: null },
    ])
    expect(await markEventsDelivered(db as never, { workspaceId: 'w1', userId: 'u1', eventIds: ['1', '2', '3', '4'], homeTurnId: 'ht-1' })).toBe(1)
    const rows = db.rows('agent_event')
    expect(rows[0]).toMatchObject({ state: 'delivered', delivered_key: 'home_turn:ht-1', home_turn_id: 'ht-1' })
    expect(rows[1]).toMatchObject({ delivered_key: 'away:x' })
    expect(rows[2]).toMatchObject({ state: 'routed' })
    expect(rows[3]).toMatchObject({ state: 'new' })
  })

  it('a report turn delivers its work items\' rows (question, review, finish), so the away section and the digest stay silent about them', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_event', [
      { id: '1', workspace_id: 'w1', user_id: 'u1', kind: 'work.needs_review', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '2', workspace_id: 'w1', user_id: 'u1', kind: 'work.done', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '3', workspace_id: 'w1', user_id: 'u1', kind: 'work.needs_review', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-other', delivered_at: null },
    ])
    expect(await markWorkEventsDelivered(db as never, { workspaceId: 'w1', userId: 'u1', workItemIds: ['item-a'], homeTurnId: 'ht-2' })).toBe(2)
    expect(db.rows('agent_event').map((x) => x.state)).toEqual(['delivered', 'delivered', 'routed'])
    expect(await markWorkEventsDelivered(db as never, { workspaceId: 'w1', userId: 'u1', workItemIds: [], homeTurnId: 'ht-2' })).toBe(0)
  })
})

describe('captureLiveFollowups (the live chat → main agent bridge)', () => {
  /** A stub over the reads (the fake has no json-path filter). */
  function stub(opts: { conversations: string[]; asks?: unknown[]; proposals?: number; endedAt?: string | null }) {
    const seen: Array<{ table: string; lte?: unknown }> = []
    return {
      seen,
      from: (table: string) => {
        const entry: { table: string; lte?: unknown } = { table }
        seen.push(entry)
        const q: Record<string, unknown> = {}
        for (const k of ['select', 'eq', 'in', 'filter', 'order']) q[k] = () => q
        q.lte = (_k: string, v: unknown) => ((entry.lte = v), q)
        q.maybeSingle = async () => ({ data: table === 'captures' ? { ended_at: opts.endedAt === undefined ? '2026-10-14T11:00:00.000Z' : opts.endedAt } : null, error: null })
        q.limit = async () =>
          table === 'chat_conversations'
            ? { data: opts.conversations.map((id) => ({ id })), error: null }
            : { data: (opts.asks ?? []).map((ui_message) => ({ ui_message })), error: null }
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ count: opts.proposals ?? 0, error: null }).then(resolve)
        return q
      },
    }
  }
  const open = { parts: [{ type: 'tool-ask_user', state: 'input-available' }] }
  const answered = { parts: [{ type: 'tool-ask_user', state: 'output-available' }] }

  it('counts the unanswered asks and the proposals the LIVE agent staged (up to the call\'s end; the batch extraction\'s come after)', async () => {
    const db = stub({ conversations: ['conv-live', 'conv-dup'], asks: [open, answered, open], proposals: 3 })
    expect(await captureLiveFollowups(db as never, { workspaceId: 'w1', captureId: 'cap-1' })).toEqual({ openAsks: 2, pendingProposals: 3 })
    expect(db.seen.find((x) => x.table === 'proposed_change')?.lte).toBe('2026-10-14T11:00:00.000Z')
    expect(await captureLiveFollowups(stub({ conversations: ['conv-live'], asks: [answered] }) as never, { workspaceId: 'w1', captureId: 'cap-1' })).toEqual({})
    // A call with no end recorded: no proposal is counted as the live agent's.
    expect(await captureLiveFollowups(stub({ conversations: ['conv-live'], proposals: 4, endedAt: null }) as never, { workspaceId: 'w1', captureId: 'cap-1' })).toEqual({})
  })

  it('a meeting with no live agent (no conversation of its own) carries nothing, even with proposals', async () => {
    expect(await captureLiveFollowups(stub({ conversations: [], proposals: 5 }) as never, { workspaceId: 'w1', captureId: 'cap-1' })).toEqual({})
    expect(isOpenAsk(open)).toBe(true)
    expect(isOpenAsk(answered)).toBe(false)
    expect(isOpenAsk(null)).toBe(false)
  })
})

describe('quiet turns never hide what waits (A6 review)', () => {
  const seedRows = (db: ReturnType<typeof makeFakeSupabase>) =>
    db.seed('agent_event', [
      { id: '1', workspace_id: 'w1', user_id: 'u1', kind: 'email.drafted', state: 'routed', outcome: 'turn', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '2', workspace_id: 'w1', user_id: 'u1', kind: 'work.approval', state: 'routed', outcome: 'turn', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '3', workspace_id: 'w1', user_id: 'u1', kind: 'work.needs_input', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '4', workspace_id: 'w1', user_id: 'u1', kind: 'work.failed', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
      { id: '5', workspace_id: 'w1', user_id: 'u1', kind: 'work.needs_review', state: 'routed', outcome: 'quiet', ref_type: 'work_item', ref_id: 'item-a', delivered_at: null },
    ])

  it('a quiet event turn marks what it covered (not brought back with the next mail), but an approval stays', async () => {
    const db = makeFakeSupabase()
    seedRows(db)
    expect(await markEventsDelivered(db as never, { workspaceId: 'w1', userId: 'u1', eventIds: ['1', '2'], homeTurnId: 'ht', exceptWaiting: true })).toBe(1)
    expect(db.rows('agent_event').slice(0, 2).map((r) => r.state)).toEqual(['delivered', 'routed'])
  })

  it('a quiet report turn leaves the question, the failure and the approval for the away section; the result is delivered', async () => {
    const db = makeFakeSupabase()
    seedRows(db)
    await markWorkEventsDelivered(db as never, { workspaceId: 'w1', userId: 'u1', workItemIds: ['item-a'], homeTurnId: 'ht', exceptWaiting: true })
    expect(db.rows('agent_event').map((r) => [r.kind, r.state])).toEqual([
      ['email.drafted', 'delivered'],
      ['work.approval', 'routed'],
      ['work.needs_input', 'routed'],
      ['work.failed', 'routed'],
      ['work.needs_review', 'delivered'],
    ])
  })

  it('a reply a limit held back is named with why, and the agent is told not to draft it', () => {
    for (const reason of ['cap', 'paused', 'usage', 'dormant']) {
      const line = eventTurnLine(r({ kind: 'email.needs_reply', facts: { title: 'Contract', from: 'Dana', known: true, reason }, ref_type: 'email_thread', ref_id: 'pt' }))
      expect(line).toContain('Do not draft it')
      expect(line).not.toContain('No draft yet')
    }
    expect(eventTurnLine(r({ kind: 'email.needs_reply', facts: { title: 'Contract', reason: 'cap' } }))).toContain('limit of automatic drafts was reached')
    expect(eventTurnLine(r({ kind: 'email.needs_reply', facts: { title: 'Contract', reason: 'not_drafted' } }))).toContain('No draft yet')
  })
})
