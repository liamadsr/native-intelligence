/**
 * "While you were away" (A6 slice 2, src/lib/agent-events/away-section.ts).
 *
 * Pinned: home thread only; only after a gap of 2 h or more since the
 * previous message (this turn's own fresh row is skipped); counts first, then
 * at most 8 lines, "waiting on you" first; from undelivered quiet or notify
 * events plus the log lines the 30-line log section misses (less those an
 * event stands for); fenced as untrusted; building it marks the rows
 * delivered, and a retried build of the same turn renders the same section.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { AWAY_GAP_MS, AWAY_MAX_LINES, awayLineFor, buildAwaySection, renderAwaySection } from '../away-section'
import { LOG_SECTION_LINES } from '@/lib/log/log-section'

const NOW = Date.parse('2026-10-14T15:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const ids = { conversationId: 'conv-1', workspaceId: 'w1', userId: 'u1' }

let db: FakeSupabase
let seq = 0
const event = (over: Record<string, unknown>) => ({
  id: String(++seq),
  workspace_id: 'w1',
  user_id: 'u1',
  state: 'routed',
  outcome: 'quiet',
  facts: {},
  occurs_at: ago(60),
  ref_type: null,
  ref_id: null,
  delivered_at: null,
  delivered_key: null,
  ...over,
})

beforeEach(() => {
  db = makeFakeSupabase()
  seq = 0
  db.seed('chat_conversations', [
    { id: 'conv-1', user_id: 'u1', workspace_id: 'w1', is_home: true },
    { id: 'side', user_id: 'u1', workspace_id: 'w1', is_home: null },
  ])
  db.seed('chat_messages', [{ id: 'msg-prev', conversation_id: 'conv-1', user_id: 'u1', workspace_id: 'w1', role: 'user', created_at: ago(300) }])
})

const build = (over: Partial<Parameters<typeof buildAwaySection>[1]> = {}) =>
  buildAwaySection(db as never, { ...ids, timeZone: 'UTC', nowMs: NOW, ...over })

describe('awayLineFor / renderAwaySection', () => {
  it('a reply Dial8 was unsure of reads as a question, not a missing draft (E3)', () => {
    expect(awayLineFor({ kind: 'email.needs_reply', facts: { from: 'healy@vendor.example', reason: 'unsure' } })).toBe('Might need a reply (want one drafted?): healy@vendor.example')
  })

  it('an arrived email: what it is and who sent it, never a subject; worth knowing first, and when it asks something', () => {
    expect(awayLineFor({ kind: 'email.arrived', facts: { emailKind: 'meeting', shouldKnow: true, from: 'calendar-notification@google.com' } })).toBe('Worth knowing: A meeting email from calendar-notification@google.com')
    expect(awayLineFor({ kind: 'email.arrived', facts: { emailKind: 'conversation', needsInput: true, from: 'dana@acme.example' } })).toBe('A message from dana@acme.example, asking you something')
    expect(awayLineFor({ kind: 'email.arrived', facts: {} })).toBe('An email')
  })

  it('a meeting change: what happened, with the old (and new) time in the person\'s zone', () => {
    const at = '2026-10-20T20:00:00.000Z'
    expect(awayLineFor({ kind: 'meeting.changed', occurs_at: at, facts: { title: 'Board prep', change: 'cancelled' } }, 'America/New_York')).toBe('Meeting cancelled: Board prep (was 4:00 PM EDT)')
    expect(awayLineFor({ kind: 'meeting.changed', occurs_at: at, facts: { title: 'Board prep', change: 'removed' } }, 'America/New_York')).toBe('Meeting no longer on your calendar: Board prep (was 4:00 PM EDT)')
    expect(awayLineFor({ kind: 'meeting.changed', occurs_at: at, facts: { title: 'Board prep', change: 'moved', movedTo: '2026-10-20T21:30:00.000Z' } }, 'America/New_York')).toBe('Meeting moved: Board prep (4:00 PM EDT → 5:30 PM EDT)')
  })

  it('a fixed phrase per kind around a clipped title', () => {
    expect(awayLineFor({ kind: 'work.needs_input', facts: { title: 'Acme reply' } })).toBe('Waiting on you: Acme reply (it has a question)')
    // A mail row names the sender's address, never a subject (no stored mail; an old row's title is not shown).
    expect(awayLineFor({ kind: 'email.needs_reply', facts: { title: 'Contract', from: 'dana@acme.com' } })).toBe('Needs a reply (no draft): dana@acme.com')
    expect(awayLineFor({ kind: 'email.drafted', facts: { from: 'dana@acme.com' } })).toBe('Draft ready: reply to dana@acme.com')
    expect(awayLineFor({ kind: 'email.drafted', facts: {} })).toBe('Draft ready: a reply to review')
    expect(awayLineFor({ kind: 'email.suspicious', facts: { from: 'x@phish.example' } })).toBe('Suspicious email (not drafted) from x@phish.example')
    expect(awayLineFor({ kind: 'mention', facts: { title: 'GEN-4', notificationType: 'comment_reply' } })).toBe('A reply to your comment: GEN-4')
    expect(awayLineFor({ kind: 'mention', facts: { title: 'Sam shared "Plan" with you', notificationType: 'capture_shared' } })).toBe('Shared with you: Sam shared "Plan" with you')
    // The other notices' titles are already Dial8's sentence.
    expect(awayLineFor({ kind: 'activity', facts: { title: 'Sam completed GEN-4' } })).toBe('Update: Sam completed GEN-4')
    expect(awayLineFor({ kind: 'reminder.due', facts: { title: 'Ship the deck' } })).toBe('Reminder you set: Ship the deck')
    expect(awayLineFor({ kind: 'contact.followup_due', facts: { title: 'Follow up with Jane' } })).toBe('Follow up with Jane')
    expect(awayLineFor({ kind: 'sequence.failed', facts: { title: 'Sequence send failed: Q4' } })).toBe('Failed: Sequence send failed: Q4')
    // A meeting names its start in local time with the zone, never "coming up" (a kept line must read true that evening).
    expect(awayLineFor({ kind: 'meeting.soon', facts: { title: 'Acme', prepReady: true }, occurs_at: '2026-10-17T16:00:00.000Z' }, 'America/New_York')).toBe(
      'Meeting at 12:00 PM EDT: Acme (prep ready)',
    )
    expect(awayLineFor({ kind: 'meeting.soon', facts: { title: 'Acme' }, occurs_at: '2026-10-17T16:00:00.000Z' })).toBe('Meeting at 4:00 PM UTC: Acme')
    expect(awayLineFor({ kind: 'meeting.soon', facts: { title: 'Acme' } })).toBe('Meeting: Acme')
  })

  it('a meeting notice in the summary names its start in the zone, and counts without "coming up"', () => {
    const section = renderAwaySection({
      events: [{ kind: 'meeting.soon', facts: { title: 'Physical therapy', prepReady: true }, occurs_at: '2026-10-17T16:00:00.000Z' }],
      missedLog: [],
      sinceIso: '2026-10-17T12:00:00.000Z',
      timeZone: 'America/New_York',
    })!
    expect(section.markdown).toContain('1 meeting notice')
    expect(section.markdown).toContain('Meeting at 12:00 PM EDT: Physical therapy (prep ready)')
    expect(section.markdown).not.toContain('coming up')
  })

  it('counts first, waiting on you first, at most 8 lines, fenced as untrusted', () => {
    const events = [
      { kind: 'email.drafted' as const, facts: { title: 'Re: a' }, occurs_at: ago(10) },
      { kind: 'work.failed' as const, facts: { title: 'Report' }, occurs_at: ago(20) },
      { kind: 'work.needs_review' as const, facts: { title: 'Prospects' }, occurs_at: ago(30) },
      ...Array.from({ length: 8 }, (_, i) => ({ kind: 'email.drafted' as const, facts: { title: `Re: ${i}` }, occurs_at: ago(40 + i) })),
    ]
    const section = renderAwaySection({ events, missedLog: [{ at: ago(200), line: 'Started: Old job', ref_type: null, ref_id: null }], sinceIso: ago(300), timeZone: 'UTC' })!
    expect(section.key).toBe('away')
    const lines = section.markdown.split('\n')
    expect(lines[0]).toContain('While you were away')
    expect(lines[0]).toContain('2026-10-14 10:00')
    expect(lines[1]).toBe('1 waiting on you · 1 failed · 9 drafts ready · 1 earlier log line')
    expect(section.markdown).toContain('[UNTRUSTED WORKSPACE CONTENT')
    const bullets = lines.filter((l) => l.startsWith('- '))
    expect(bullets[0]).toBe('- 2026-10-14 14:30 Ready for your review: Prospects')
    expect(bullets[1]).toBe('- 2026-10-14 14:40 Failed: Report')
    expect(bullets).toHaveLength(AWAY_MAX_LINES + 1)
    expect(bullets.at(-1)).toBe('- …and 4 more')
    expect(renderAwaySection({ events: [], missedLog: [], sinceIso: ago(300), timeZone: null })).toBeNull()
  })
})

describe('buildAwaySection', () => {
  it('renders the undelivered quiet and notify rows and marks them delivered', async () => {
    db.seed('agent_event', [
      event({ kind: 'work.needs_input', outcome: 'notify', facts: { title: 'Which tone?' } }),
      event({ kind: 'email.drafted', facts: { from: 'pricing@acme.com' } }),
      event({ kind: 'mention', outcome: 'ignore', facts: { title: 'Ignored' } }),
      event({ kind: 'work.done', state: 'delivered', delivered_at: ago(100), delivered_key: 'away:older', facts: { title: 'Seen before' } }),
      event({ kind: 'email.drafted', user_id: 'u2', facts: { title: 'Someone else' } }),
      event({ kind: 'email.drafted', state: 'new', outcome: null, facts: { title: 'Not routed yet' } }),
    ])
    const section = (await build())!
    expect(section.markdown).toContain('1 waiting on you · 1 draft ready')
    expect(section.markdown).toContain('Waiting on you: Which tone? (it has a question)')
    expect(section.markdown).toContain('Draft ready: reply to pricing@acme.com')
    for (const absent of ['Ignored', 'Seen before', 'Someone else', 'Not routed yet']) expect(section.markdown).not.toContain(absent)
    const rows = db.rows('agent_event')
    expect(rows.slice(0, 2).map((r) => [r.state, r.delivered_key])).toEqual([
      ['delivered', 'away:msg-prev'],
      ['delivered', 'away:msg-prev'],
    ])
    expect(rows[2].delivered_at).toBeNull()

    // A retried build of the same turn renders the same section from the marked rows.
    expect((await build())!.markdown).toBe(section.markdown)
  })

  it('leaves out a meeting that has started (and marks it expired, never read again)', async () => {
    db.seed('agent_event', [
      event({ kind: 'meeting.soon', facts: { title: 'Standup' }, expires_at: ago(30) }),
      event({ kind: 'meeting.soon', facts: { title: 'Later today' }, expires_at: new Date(NOW + 60 * 60_000).toISOString() }),
    ])
    const section = (await build())!
    expect(section.markdown).not.toContain('Standup')
    expect(section.markdown).toContain('Later today')
    const [started, later] = db.rows('agent_event')
    expect(started).toMatchObject({ state: 'expired', delivered_at: null })
    expect(later).toMatchObject({ state: 'delivered' })
  })

  it('is null for a side chat, before a 2 h gap, with no previous message, or with nothing to say', async () => {
    db.seed('agent_event', [event({ kind: 'email.drafted', facts: { title: 'Re: x' } })])
    expect(await build({ conversationId: 'side' })).toBeNull()
    expect(await build({ nowMs: Date.parse(ago(300)) + AWAY_GAP_MS - 1 })).toBeNull()
    expect(db.rows('agent_event')[0].delivered_at).toBeNull()

    const empty = makeFakeSupabase()
    empty.seed('chat_conversations', [{ id: 'conv-1', user_id: 'u1', workspace_id: 'w1', is_home: true }])
    expect(await buildAwaySection(empty as never, { ...ids, timeZone: null, nowMs: NOW })).toBeNull()
    empty.seed('chat_messages', [{ id: 'm', conversation_id: 'conv-1', user_id: 'u1', workspace_id: 'w1', role: 'user', created_at: ago(300) }])
    expect(await buildAwaySection(empty as never, { ...ids, timeZone: null, nowMs: NOW })).toBeNull()
  })

  it('skips this turn’s own fresh message and measures the gap from the one before', async () => {
    db.seed('chat_messages', [{ id: 'msg-now', conversation_id: 'conv-1', user_id: 'u1', workspace_id: 'w1', role: 'user', created_at: ago(0.5) }])
    db.seed('agent_event', [event({ kind: 'capture.processed', facts: { title: 'Acme sync' } })])
    const section = await build()
    expect(section!.markdown).toContain('Meeting processed: Acme sync')
    expect(db.rows('agent_event')[0].delivered_key).toBe('away:msg-prev')
  })

  it('adds the log lines the 30-line log section misses, less those an event stands for', async () => {
    db.seed('agent_event', [event({ kind: 'work.failed', ref_type: 'work_item', ref_id: 'job-old', facts: { title: 'Old job' } })])
    db.seed('tracked_job', [{ id: 'job-old', workspace_id: 'w1', status: 'failed' }])
    const lines = Array.from({ length: LOG_SECTION_LINES + 3 }, (_, i) => ({
      id: String(i + 1),
      workspace_id: 'w1',
      user_id: 'u1',
      at: ago(250 - i),
      kind: 'work_finished',
      line: `Line ${i}`,
      ref_type: i === 0 ? 'work_item' : null,
      ref_id: i === 0 ? 'job-old' : null,
    }))
    db.seed('agent_log', [...lines, { id: '999', workspace_id: 'w1', user_id: 'u1', at: ago(400), kind: 'work_finished', line: 'Before the gap', ref_type: null, ref_id: null }])
    const section = (await build())!
    // The 3 oldest since the gap are missed; one is the event's own line.
    expect(section.markdown).toContain('1 failed · 2 earlier log lines')
    expect(section.markdown).toContain('Line 1')
    expect(section.markdown).toContain('Line 2')
    expect(section.markdown).not.toContain('Line 0')
    expect(section.markdown).not.toContain('Line 3\n')
    expect(section.markdown).not.toContain('Before the gap')
  })

  it('reads the most pressing rows first, so a burst of teammates’ updates never pushes a question past the cap (review fix)', async () => {
    db.seed('agent_event', [
      event({ kind: 'work.needs_input', priority: 2, facts: { title: 'Pick a plan' }, occurs_at: ago(240) }),
      ...Array.from({ length: 120 }, (_, i) => event({ kind: 'activity', priority: 0, facts: { title: `Update ${i}` }, occurs_at: ago(30) })),
    ])
    const section = (await build())!
    expect(section.markdown).toContain('1 waiting on you')
    expect(section.markdown).toContain('Waiting on you: Pick a plan')
  })

  it('drops a teammate’s mention or update once its notification was read, but never a reminder', async () => {
    db.seed('agent_event', [
      event({ kind: 'activity', facts: { title: 'Sam completed GEN-4' }, ref_type: 'notification', ref_id: 'n-read' }),
      event({ kind: 'mention', facts: { title: 'Dana replied', notificationType: 'comment_reply' }, ref_type: 'notification', ref_id: 'n-unread' }),
      event({ kind: 'reminder.due', facts: { title: 'Ship the deck' }, ref_type: 'notification', ref_id: 'n-reminder' }),
    ])
    db.seed('notification', [
      { id: 'n-read', workspace_id: 'w1', is_read: true },
      { id: 'n-unread', workspace_id: 'w1', is_read: false },
      { id: 'n-reminder', workspace_id: 'w1', is_read: true },
    ])
    const section = (await build())!
    expect(section.markdown).not.toContain('Sam completed GEN-4')
    expect(section.markdown).toContain('A reply to your comment: Dana replied')
    expect(section.markdown).toContain('Reminder you set: Ship the deck')
    expect(section.markdown).toContain('1 reminder due')
    expect(db.rows('agent_event')[0]).toMatchObject({ state: 'delivered', delivered_key: 'settled' })
  })

  it('drops what settled since (a draft sent, a question answered) and marks it so it never shows again', async () => {
    db.seed('agent_event', [
      event({ kind: 'email.drafted', facts: { from: 'already-sent@x.com' }, ref_type: 'email_draft', ref_id: 'd-1' }),
      event({ kind: 'email.drafted', facts: { from: 'still-to-review@x.com' }, ref_type: 'email_draft', ref_id: 'd-2' }),
      event({ kind: 'work.needs_input', outcome: 'notify', facts: { title: 'Answered' }, ref_type: 'work_item', ref_id: 'w-1' }),
    ])
    db.seed('email_draft', [
      { id: 'd-1', workspace_id: 'w1', status: 'sent' },
      { id: 'd-2', workspace_id: 'w1', status: 'edited' },
    ])
    db.seed('tracked_job', [{ id: 'w-1', workspace_id: 'w1', status: 'running' }])
    const section = (await build())!
    expect(section.markdown).toContain('1 draft ready')
    expect(section.markdown).toContain('still-to-review@x.com')
    expect(section.markdown).not.toContain('already-sent@x.com')
    expect(section.markdown).not.toContain('Answered')
    expect(section.markdown).not.toContain('1 waiting on you')
    const [sent, open, answered] = db.rows('agent_event')
    expect(sent).toMatchObject({ state: 'delivered', delivered_key: 'settled' })
    expect(answered).toMatchObject({ state: 'delivered', delivered_key: 'settled' })
    expect(open).toMatchObject({ state: 'delivered', delivered_key: 'away:msg-prev' })
  })

  it('dedupes fully: one line per item, and no line for an item the log section (its newest 30) already names, only its count; turn rows count too', async () => {
    db.seed('agent_event', [
      // Two rows about one item: one line, the most pressing.
      event({ kind: 'work.needs_review', facts: { title: 'Prospects' }, ref_type: 'work_item', ref_id: 'w-r' }),
      event({ kind: 'work.done', facts: { title: 'Prospects' }, ref_type: 'work_item', ref_id: 'w-r', occurs_at: ago(5) }),
      // The log section's newest line already says this one.
      event({ kind: 'work.needs_review', facts: { title: 'Logged deck' }, ref_type: 'work_item', ref_id: 'w-logged' }),
      // A turn row the agent stayed quiet about still shows.
      event({ kind: 'email.drafted', outcome: 'turn', facts: { from: 'dana@acme.com', known: true } }),
    ])
    db.seed('tracked_job', [
      { id: 'w-r', workspace_id: 'w1', status: 'needs_review' },
      { id: 'w-logged', workspace_id: 'w1', status: 'needs_review' },
    ])
    db.seed('agent_log', [{ id: '1', workspace_id: 'w1', user_id: 'u1', at: ago(20), kind: 'work_needs_review', line: 'Ready for review: Logged deck', ref_type: 'work_item', ref_id: 'w-logged' }])
    const section = (await build())!
    expect(section.markdown).toContain('2 waiting on you · 1 draft ready')
    const bullets = section.markdown.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets.filter((l) => l.includes('Prospects'))).toHaveLength(1)
    expect(bullets[0]).toContain('Ready for your review: Prospects')
    expect(section.markdown).not.toContain('Logged deck')
    expect(section.markdown).toContain('Draft ready: reply to dana@acme.com')
    // Every row it stood for is delivered, the folded and the log-covered ones too.
    expect(db.rows('agent_event').every((r) => r.state === 'delivered')).toBe(true)
  })

  it('throws when a read fails, so the spec can tell none from unreadable', async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }) }
    await expect(buildAwaySection(broken as never, { ...ids, timeZone: null, nowMs: NOW })).rejects.toThrow('boom')
  })
})
