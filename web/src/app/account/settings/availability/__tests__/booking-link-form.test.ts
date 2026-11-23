/**
 * The booking link dialog's draft (../booking-link-form.ts): a new link is a
 * title away from saving, the slug follows the title until typed, what's
 * wrong before a save, a new link's body, and a change's body carrying only
 * what changed (hosts always with how they share). Made-up people.
 */
import { describe, expect, it } from 'vitest'
import { OWN_WEEK_DEFAULT, createBody, dailyCapLabel, draftOf, draftProblem, linkSummary, newDraft, noticeLabel, patchBody, typedSlug, withTitle, withValue, type SettingsLink } from '../booking-link-form'

const AVA = 'a0000000-0000-4000-8000-00000000000a'
const BEN = 'b0000000-0000-4000-8000-00000000000b'
const LINK: SettingsLink = {
  id: 'l-1',
  url: 'https://app.example/book/ava-lin/intro-call',
  profile: 'ava-lin',
  slug: 'intro-call',
  purpose: 'meeting',
  title: 'Intro call',
  description: null,
  duration_minutes: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  notice_minutes: 240,
  window_days: 30,
  questions: [{ id: 'company', label: 'Company', required: false, kind: 'text' }],
  video: true,
  location: null,
  ask_first: false,
  host_mode: 'one',
  hosts: [AVA],
  owner_user_id: AVA,
  active: true,
  can_edit: true,
}

describe('a new link', () => {
  it('needs only a title; the slug follows it until typed', () => {
    const blank = newDraft(AVA)
    expect(draftProblem(blank)).toBe('Give it a title.')
    const titled = withTitle(blank, 'Intro call')
    expect(titled.slug).toBe('intro-call')
    expect(draftProblem(titled)).toBeNull()
    expect(createBody(titled)).toEqual({
      title: 'Intro call',
      slug: 'intro-call',
      description: null,
      duration_minutes: 30,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      notice_minutes: 240,
      window_days: 30,
      questions: [],
      video: true,
      call_here: false,
      location: null,
      ask_first: false,
      hosts: [AVA],
      host_mode: 'one',
    })
    const typed = withTitle({ ...titled, slug: typedSlug('My Call!'), slugTyped: true }, 'Something else')
    expect(typed.slug).toBe('my-call')
    expect(createBody({ ...titled, team: true })).toMatchObject({ team: true })
  })

  it('what to fix first', () => {
    const d = withTitle(newDraft(AVA), 'Intro call')
    expect(draftProblem({ ...d, slug: '-bad' })).toMatch(/lower-case/)
    expect(draftProblem({ ...d, video: false, location: ' ' })).toBe('Say where, or turn the video call on.')
    expect(draftProblem({ ...d, hosts: [] })).toBe('Pick at least one host.')
    expect(draftProblem({ ...d, questions: [{ label: '', required: false, kind: 'text' }] })).toBe('Each question needs its wording, or remove it.')
  })

  it('several hosts share it all or any; one is one', () => {
    const d = withTitle(newDraft(AVA), 'Team call')
    expect(createBody({ ...d, hosts: [AVA, BEN], shared: 'any' })).toMatchObject({ hosts: [AVA, BEN], host_mode: 'any' })
    expect(createBody({ ...d, hosts: [BEN], shared: 'any' })).toMatchObject({ hosts: [BEN], host_mode: 'one' })
  })
})

describe('a change', () => {
  it('only what changed; nothing changed is an empty body', () => {
    const d = draftOf(LINK)
    expect(patchBody(LINK, d)).toEqual({})
    expect(patchBody(LINK, { ...d, durationMinutes: 45, askFirst: true })).toEqual({ duration_minutes: 45, ask_first: true })
    expect(patchBody(LINK, { ...d, questions: [...d.questions, { label: 'Agenda', required: true, kind: 'long' }] })).toEqual({
      questions: [
        { id: 'company', label: 'Company', required: false, kind: 'text' },
        { label: 'Agenda', required: true, kind: 'long' },
      ],
    })
    expect(patchBody(LINK, { ...d, video: false, location: '12 Elm St' })).toEqual({ video: false, location: '12 Elm St' })
  })

  it('hosts go with how they share', () => {
    const d = draftOf(LINK)
    expect(patchBody(LINK, { ...d, hosts: [AVA, BEN] })).toEqual({ hosts: [AVA, BEN], host_mode: 'all' })
    const team = { ...LINK, hosts: [AVA, BEN], host_mode: 'all' as const }
    expect(patchBody(team, { ...draftOf(team), shared: 'any' })).toEqual({ hosts: [AVA, BEN], host_mode: 'any' })
  })
})

describe('the labels', () => {
  it('notice, options and the list line', () => {
    expect([0, 60, 240, 1440, 2880, 10080, 45].map(noticeLabel)).toEqual(['None', '1 hour', '4 hours', '1 day', '2 days', '1 week', '45 min'])
    expect(withValue([15, 30, 60], 25)).toEqual([15, 25, 30, 60])
    expect(withValue([15, 30, 60], 30)).toEqual([15, 30, 60])
    const names: Record<string, string> = { [AVA]: 'Ava Lin', [BEN]: 'Ben Ruiz', c: 'Cara Diaz' }
    const nameOf = (id: string) => names[id]
    expect(linkSummary(LINK, nameOf)).toBe('30 min · Ava Lin')
    expect(linkSummary({ duration_minutes: 60, host_mode: 'all', hosts: [AVA, BEN] }, nameOf)).toBe('1 hr · Ava Lin and Ben Ruiz')
    expect(linkSummary({ duration_minutes: 45, host_mode: 'any', hosts: [AVA, BEN, 'c'] }, nameOf)).toBe('45 min · any of 3')
    expect(linkSummary({ duration_minutes: 45, host_mode: 'all', hosts: [AVA, BEN, 'c'] }, nameOf)).toBe('45 min · Ava Lin and 2 others')
  })
})

describe('daily limit, own hours and dated changes (booking insights phase 3)', () => {
  const saved = {
    id: 'l1', url: null, profile: 'ava', slug: 'intro', purpose: 'meeting' as const, title: 'Intro', description: null,
    duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, notice_minutes: 240, window_days: 30,
    questions: [], video: true, location: null, ask_first: false, host_mode: 'one' as const, hosts: ['u1'], owner_user_id: 'u1', active: true, can_edit: true,
  }

  it('a new link sends them only when set', () => {
    const plain = createBody({ ...newDraft('u1'), title: 'Intro' })
    expect(plain).not.toHaveProperty('daily_cap')
    expect(plain).not.toHaveProperty('weekly_hours')
    const set = createBody({ ...newDraft('u1'), title: 'Intro', dailyCap: 3, ownHours: true, timeZone: 'America/New_York', dateOverrides: { '2031-01-02': [] } })
    expect(set).toMatchObject({ daily_cap: 3, time_zone: 'America/New_York', date_overrides: { '2031-01-02': [] } })
    expect((set.weekly_hours as unknown[]).length).toBe(7)
  })

  it('a change sends only what changed, a week with its zone', () => {
    const draft = draftOf(saved)
    expect(patchBody(saved, draft)).toEqual({})
    expect(patchBody(saved, { ...draft, dailyCap: 2 })).toEqual({ daily_cap: 2 })
    const own = patchBody(saved, { ...draft, ownHours: true, timeZone: 'America/Chicago' })
    expect(Object.keys(own).sort()).toEqual(['time_zone', 'weekly_hours'])
    const withOwn = { ...saved, weekly_hours: OWN_WEEK_DEFAULT, time_zone: 'America/Chicago', date_overrides: { '2031-01-02': [] } }
    expect(patchBody(withOwn, draftOf(withOwn))).toEqual({})
    expect(patchBody(withOwn, { ...draftOf(withOwn), ownHours: false })).toEqual({ weekly_hours: null, time_zone: null, date_overrides: null })
  })

  it('refuses a broken week or date, and a week with nothing open', () => {
    const base = { ...newDraft('u1'), title: 'Intro', ownHours: true }
    expect(draftProblem(base)).toBeNull()
    expect(draftProblem({ ...base, weekly: [[], [{ start: '10:00', end: '09:00' }], [], [], [], [], []] })).toMatch(/Monday/)
    expect(draftProblem({ ...base, weekly: [[], [], [], [], [], [], []] })).toMatch(/at least one day/)
    expect(draftProblem({ ...base, dateOverrides: { '2031-01-02': [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } })).toMatch(/2031-01-02: the ranges overlap/)
    expect(dailyCapLabel(0)).toBe('No limit')
  })
})
