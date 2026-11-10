/**
 * The palette's first view leads with the activity feed: Inbox (what
 * mentions or was assigned to the person) then Recent (what they touched
 * last), a few of each, a record in both shown once, and only before
 * anything is typed (a search shows what it finds). Each row opens its
 * record. The `@` menu never shows them. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { INBOX_CAP, RECENT_CAP, buildMenu, feedSections, verbFor, type MenuOffer } from '../command-menu-model'
import { paletteInboxUrl, paletteRecentUrl } from '../use-palette-feed'
import type { FeedEntry } from '@/lib/entities/feed-model'

const entry = (type: FeedEntry['type'], id: string, label: string): FeedEntry => ({
  type,
  id,
  label,
  context: null,
  count: 1,
  last: {
    id: `ev-${id}`,
    action: 'assigned',
    at: '2026-11-09T10:00:00.000Z',
    actor: { kind: 'member', member_id: 'm-maya', name: 'Maya Chen', me: false },
    subject: { member_id: 'm-ana', name: 'Ana Reyes', me: true },
    from: null,
    to: null,
    relation: null,
    other: null,
  },
})

const offer: MenuOffer = { pages: true, skills: false, open: true, mention: new Set() }
const sources = (inbox: FeedEntry[], recent: FeedEntry[]) => ({ pages: [], skills: [], records: {}, inbox, recent })

const quote = entry('action', 'a-1', 'Send the Fernhill quote')
const launch = entry('team_chat_message', 'm-1', 'Ana, can you take the launch?')
const plan = entry('document', 'd-1', 'Q4 renewals plan')

describe('the palette’s Inbox and Recent', () => {
  it('lead the first view, Inbox first, a record in both shown once', () => {
    const menu = buildMenu('/', 'all', '', offer, sources([quote, launch], [plan, quote]))
    expect(menu.sections.map((s) => [s.key, s.label, s.items.length])).toEqual([
      ['inbox', 'Inbox', 2],
      ['recent', 'Recent', 1],
    ])
    expect(menu.sections[0].offset).toBe(0)
    expect(menu.sections[1].offset).toBe(2)
    // Never tabs of their own.
    expect(menu.tabs).not.toContain('inbox')
    expect(menu.tabs).not.toContain('recent')
  })

  it('show a few of each', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry('action', `a-${i}`, `Task ${i}`))
    const more = Array.from({ length: 12 }, (_, i) => entry('document', `d-${i}`, `Doc ${i}`))
    const [inbox, recent] = feedSections({ inbox: many, recent: more })
    expect(inbox.items).toHaveLength(INBOX_CAP)
    expect(recent.items).toHaveLength(RECENT_CAP)
  })

  it('are drawn only when there is something in them', () => {
    expect(feedSections({ inbox: [], recent: null })).toEqual([])
    expect(buildMenu('/', 'all', '', offer, sources([], [])).sections).toEqual([])
  })

  it('give way to a search, a tab, and the @ menu', () => {
    expect(buildMenu('/', 'all', 'fern', offer, sources([quote], [plan])).sections.some((s) => s.key === 'inbox' || s.key === 'recent')).toBe(false)
    expect(buildMenu('/', 'pages', '', offer, sources([quote], [plan])).sections.some((s) => s.key === 'inbox')).toBe(false)
    const at: MenuOffer = { pages: false, skills: false, open: false, mention: new Set(['action']) }
    expect(buildMenu('@', 'all', '', at, sources([quote], [plan])).sections.some((s) => s.key === 'inbox')).toBe(false)
  })

  it('open their record on Enter', () => {
    expect(verbFor('/', { kind: 'feed', entry: quote })).toBe('open')
  })

  it('ask the feed for the last two weeks of the Inbox, and the person’s own Recent', () => {
    const inbox = new URL(paletteInboxUrl(new Date('2026-11-10T00:00:00Z')), 'http://x')
    expect(inbox.pathname).toBe('/api/account/feed')
    expect(inbox.searchParams.get('assigned_to')).toBe('me')
    expect(inbox.searchParams.get('mentioned')).toBe('me')
    expect(inbox.searchParams.get('since')).toBe('2026-10-27T00:00:00.000Z')
    const recent = new URL(paletteRecentUrl(), 'http://x')
    expect(recent.searchParams.get('actor')).toBe('me')
  })
})
