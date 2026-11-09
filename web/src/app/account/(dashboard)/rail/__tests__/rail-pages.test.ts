/**
 * The app rail's pages (../rail-pages.ts): Liam's reference order, each a `/`
 * page that's on in the workspace (in its words), and the icon lit for the
 * card in front.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { CARD_PAGES, pagesFor } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { RAIL_PAGES, activeRailItem, railPagesFor } from '../rail-pages'

const NOW = new Date(2026, 10, 9, 10, 0)
const full = getEdition('full')
const offered = (edition = full) => railPagesFor(pagesFor(edition, { desktop: false, now: NOW }))

describe('the rail pages', () => {
  it('each opens a `/` page', () => {
    for (const def of RAIL_PAGES) expect(CARD_PAGES.some((p) => p.slug === def.slug), def.slug).toBe(true)
  })

  it('keep the reference order: docs, mail, team chat, actions, calendar, agents, CRM', () => {
    expect(offered().map((p) => p.def.id)).toEqual(['docs', 'mail', 'team-chat', 'actions', 'calendar', 'agents', 'crm'])
  })

  it('leave out a page that is off in the workspace', () => {
    const ids = offered(withEffectiveSurface(full, { email: 'off', crm: 'off', docs: 'off' })).map((p) => p.def.id)
    expect(ids).not.toContain('mail')
    expect(ids).not.toContain('crm')
    expect(ids).not.toContain('docs')
    expect(ids).toContain('team-chat')
  })

  it('name a page in the workspace’s words', () => {
    const service = getEdition('service')
    const actions = offered(service).find((p) => p.def.id === 'actions')
    const named = pagesFor(service, { desktop: false, now: NOW }).find((p) => p.slug === 'actions')
    expect(actions?.page.label).toBe(named?.label)
  })
})

describe('the lit icon', () => {
  const pages = offered()
  const list = (entity_type: string): CardSpec => ({ kind: 'list', title: 'x', entity_type, filters: [] }) as CardSpec
  const record = (type: string): CardSpec => ({ kind: 'record', title: 'x', record: { type, id: 'r1' } }) as CardSpec

  it('is Home with no card in front', () => {
    expect(activeRailItem(null, pages)).toBe('home')
  })

  it('is the page a card in front is one of', () => {
    expect(activeRailItem({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }, pages)).toBe('mail')
    expect(activeRailItem({ kind: 'team_chat', title: 'Team chat' }, pages)).toBe('team-chat')
    expect(activeRailItem({ kind: 'calendar', title: 'This week', calendar: { from: '2026-11-08', to: '2026-11-14', view: 'week' } }, pages)).toBe('calendar')
    expect(activeRailItem({ kind: 'library', title: 'Agents & skills' }, pages)).toBe('agents')
    expect(activeRailItem({ kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'b1' } }, pages)).toBe('agents')
    expect(activeRailItem(list('document'), pages)).toBe('docs')
    expect(activeRailItem(list('action'), pages)).toBe('actions')
    expect(activeRailItem({ kind: 'team_board', title: 'Board', target: { type: 'team', id: 't1' } }, pages)).toBe('actions')
  })

  it('lights the CRM for its companies, contacts and deals, as lists or records', () => {
    for (const entity of ['company', 'contact', 'deal']) {
      expect(activeRailItem(list(entity), pages), entity).toBe('crm')
      expect(activeRailItem(record(entity), pages), entity).toBe('crm')
    }
    expect(activeRailItem(record('action'), pages)).toBe('actions')
    expect(activeRailItem(record('document'), pages)).toBe('docs')
  })

  it('is none for a card no rail page shows', () => {
    expect(activeRailItem(list('capture'), pages)).toBeNull()
    expect(activeRailItem({ kind: 'flows', title: 'Flows' }, pages)).toBeNull()
  })

  it('is none for a page the workspace has off', () => {
    const noMail = offered(withEffectiveSurface(full, { email: 'off' }))
    expect(activeRailItem({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }, noMail)).toBeNull()
  })
})
