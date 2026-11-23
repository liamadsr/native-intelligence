import { describe, expect, it } from 'vitest'
import {
  applyOwnVote,
  isPollClosed,
  leadingOptionIds,
  nextChoices,
  optionPercent,
  planPoll,
  pollBody,
  pollClosesAt,
  pollStatusLine,
  untilWords,
  type TeamChatPoll,
} from '../polls'

const now = new Date('2026-11-23T12:00:00Z')

describe('planPoll', () => {
  it('tidies and accepts a good poll', () => {
    const r = planPoll({ question: '  Lunch   where? ', options: [' Tacos', '', 'Ramen  bar', '  '], multiple: true, anonymous: 1 }, now)
    expect(r).toEqual({ ok: true, draft: { question: 'Lunch where?', options: ['Tacos', 'Ramen bar'], multiple: true, anonymous: false, closes_at: null } })
  })
  it('needs a question and 2 to 10 distinct options', () => {
    expect(planPoll({ question: '', options: ['a', 'b'] }, now)).toMatchObject({ ok: false })
    expect(planPoll({ question: 'q', options: ['a'] }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/at least 2/) })
    expect(planPoll({ question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 10/) })
    expect(planPoll({ question: 'q', options: ['Yes', 'yes'] }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) })
    expect(planPoll({ question: 'q', options: 'a,b' }, now)).toMatchObject({ ok: false })
    expect(planPoll(null, now)).toMatchObject({ ok: false })
  })
  it('caps lengths', () => {
    expect(planPoll({ question: 'x'.repeat(301), options: ['a', 'b'] }, now)).toMatchObject({ ok: false })
    expect(planPoll({ question: 'q', options: ['a', 'b'.repeat(121)] }, now)).toMatchObject({ ok: false })
  })
  it('a closing time is in the future, within 90 days', () => {
    const ok = planPoll({ question: 'q', options: ['a', 'b'], closes_at: '2026-11-24T12:00:00Z' }, now)
    expect(ok).toMatchObject({ ok: true, draft: { closes_at: '2026-11-24T12:00:00.000Z' } })
    expect(planPoll({ question: 'q', options: ['a', 'b'], closes_at: '2026-11-23T11:00:00Z' }, now)).toMatchObject({ ok: false })
    expect(planPoll({ question: 'q', options: ['a', 'b'], closes_at: '2027-06-01T00:00:00Z' }, now)).toMatchObject({ ok: false })
    expect(planPoll({ question: 'q', options: ['a', 'b'], closes_at: 'soon' }, now)).toMatchObject({ ok: false })
    expect(planPoll({ question: 'q', options: ['a', 'b'], closes_at: '' }, now)).toMatchObject({ ok: true, draft: { closes_at: null } })
  })
})

const poll = (over: Partial<TeamChatPoll> = {}): TeamChatPoll => ({
  id: 'p',
  channel_id: 'c',
  message_id: 'm',
  question: 'Lunch?',
  multiple: false,
  anonymous: false,
  closes_at: null,
  closed_at: null,
  created_by: 'ana',
  created_at: '2026-11-23T10:00:00Z',
  options: [
    { id: 'a', label: 'Tacos', position: 0, votes: 2, voter_ids: ['ben', 'cy'] },
    { id: 'b', label: 'Ramen', position: 1, votes: 1, voter_ids: ['dee'] },
  ],
  voters: 3,
  mine: [],
  can_close: false,
  ...over,
})

describe('voting', () => {
  it('one choice replaces, and clicking it again takes it back', () => {
    expect(nextChoices({ multiple: false }, [], 'a')).toEqual(['a'])
    expect(nextChoices({ multiple: false }, ['a'], 'b')).toEqual(['b'])
    expect(nextChoices({ multiple: false }, ['a'], 'a')).toEqual([])
  })
  it('several toggle', () => {
    expect(nextChoices({ multiple: true }, ['a'], 'b')).toEqual(['a', 'b'])
    expect(nextChoices({ multiple: true }, ['a', 'b'], 'a')).toEqual(['b'])
  })
  it('applyOwnVote moves the counts and the reader among the voters', () => {
    const p = applyOwnVote(poll(), ['b'], 'me')
    expect(p.voters).toBe(4)
    expect(p.options.map((o) => o.votes)).toEqual([2, 2])
    expect(p.options[1].voter_ids).toEqual(['dee', 'me'])
    const changed = applyOwnVote({ ...p }, ['a'], 'me')
    expect(changed.voters).toBe(4)
    expect(changed.options.map((o) => o.votes)).toEqual([3, 1])
    const back = applyOwnVote(changed, [], 'me')
    expect(back.voters).toBe(3)
    expect(back.options.map((o) => o.votes)).toEqual([2, 1])
    expect(back.options.flatMap((o) => o.voter_ids)).not.toContain('me')
  })
  it('anonymous never names the reader', () => {
    const p = applyOwnVote(poll({ anonymous: true, options: poll().options.map((o) => ({ ...o, voter_ids: [] })) }), ['a'], 'me')
    expect(p.options.every((o) => o.voter_ids.length === 0)).toBe(true)
    expect(p.options[0].votes).toBe(3)
  })
})

describe('reading a poll', () => {
  it('closed by hand or by its time', () => {
    expect(isPollClosed(poll(), now)).toBe(false)
    expect(isPollClosed(poll({ closed_at: '2026-11-23T11:00:00Z' }), now)).toBe(true)
    expect(isPollClosed(poll({ closes_at: '2026-11-23T11:59:00Z' }), now)).toBe(true)
    expect(isPollClosed(poll({ closes_at: '2026-11-23T12:01:00Z' }), now)).toBe(false)
  })
  it('percentages, leaders and the status line', () => {
    expect(optionPercent({ votes: 2 }, 3)).toBe(67)
    expect(optionPercent({ votes: 0 }, 0)).toBe(0)
    expect(leadingOptionIds(poll())).toEqual(['a'])
    expect(leadingOptionIds(poll({ options: poll().options.map((o) => ({ ...o, votes: 0 })) }))).toEqual([])
    expect(pollStatusLine(poll(), now)).toBe('3 votes · Pick one')
    expect(pollStatusLine(poll({ multiple: true, anonymous: true, voters: 1, closes_at: '2026-11-23T14:30:00Z' }), now)).toBe('1 vote · Pick any · Anonymous · Closes in 2 hours')
    expect(pollStatusLine(poll({ closed_at: '2026-11-23T11:00:00Z' }), now)).toBe('Final results · 3 votes')
  })
  it('untilWords', () => {
    expect(untilWords(10_000)).toBe('in 1 minute')
    expect(untilWords(30 * 60_000)).toBe('in 30 minutes')
    expect(untilWords(47 * 3_600_000)).toBe('in 47 hours')
    expect(untilWords(5 * 86_400_000)).toBe('in 5 days')
  })
  it('pollBody and closing choices', () => {
    expect(pollBody('Lunch?')).toBe('Poll: Lunch?')
    expect(pollClosesAt('none', now)).toBeNull()
    expect(pollClosesAt('hour', now)).toBe('2026-11-23T13:00:00.000Z')
    expect(pollClosesAt('week', now)).toBe('2026-11-30T12:00:00.000Z')
  })
})
