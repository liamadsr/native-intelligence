/**
 * The composer's menu, as pure functions (command-menu-model.ts): where a
 * trigger is being typed, what a pick does to the text, and what the menu
 * lists for a trigger, a tab and a query.
 */
import { describe, it, expect } from 'vitest'
import { getEdition } from '@/lib/editions/manifest'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import {
  appendMention,
  buildMenu,
  cycleTab,
  findTriggerToken,
  menuTabLabel,
  menuTakesEnter,
  offeredKinds,
  pickSkillText,
  removeToken,
  replaceToken,
  sameTriggerToken,
  serverSearch,
  verbFor,
  type MenuItem,
  type MenuOffer,
  type MenuSources,
  TAB_LABELS,
} from '../command-menu-model'
import { MENTION_PICKER_KINDS, type MentionContact, type MenuSearchKind, type MenuSearchRow } from '@/lib/search/menu-search'
import type { CaptureListItem } from '../../views/capture-utils'

/** The token with the caret at the end of the text. */
const at = (text: string, done?: Parameters<typeof findTriggerToken>[2]) => findTriggerToken(text, text.length, done)

describe('findTriggerToken', () => {
  it('opens on `/` at the start of a word, the rest of the word up to the caret its query', () => {
    expect(at('/')).toEqual({ trigger: '/', start: 0, caret: 1, query: '' })
    expect(at('/capt')).toEqual({ trigger: '/', start: 0, caret: 5, query: 'capt' })
    expect(at('summarize this /bri')).toEqual({ trigger: '/', start: 15, caret: 19, query: 'bri' })
    expect(at('line one\n/x')).toMatchObject({ trigger: '/', start: 9, query: 'x' })
  })

  it('is no trigger inside a word, in a path, or once a space follows', () => {
    expect(at('and/or')).toBeNull()
    expect(at('/usr/bin')).toBeNull()
    expect(at('/ ')).toBeNull()
    expect(at('/brief now')).toBeNull()
  })

  it('opens again when the caret comes back into the trigger (backspace over the space)', () => {
    const text = '/brief '
    expect(findTriggerToken(text, text.length)).toBeNull()
    expect(findTriggerToken(text, text.length - 1)).toMatchObject({ trigger: '/', query: 'brief' })
  })

  it('reads the query up to the caret, wherever it is in the word', () => {
    expect(findTriggerToken('/summary', 5)).toMatchObject({ query: 'summ', caret: 5 })
    expect(findTriggerToken('/summary', 0)).toBeNull()
  })

  it('is no trigger on a skill that is already armed, so Enter after it sends', () => {
    expect(at('/brief', { skills: ['brief'] })).toBeNull()
    expect(at('/brie', { skills: ['brief'] })).toMatchObject({ query: 'brie' })
  })

  it('opens on `@` at the start of a word, with spaces in a name', () => {
    expect(at('@')).toEqual({ trigger: '@', start: 0, caret: 1, query: '' })
    expect(at('ask @maya')).toMatchObject({ trigger: '@', start: 4, query: 'maya' })
    expect(at('ask @maya chen')).toMatchObject({ trigger: '@', start: 4, query: 'maya chen' })
  })

  it('is no `@` trigger in an email, after `@ `, across lines, or past a few words', () => {
    expect(at('me@example.com')).toBeNull()
    expect(at('@ ')).toBeNull()
    expect(at('@maya\nchen')).toBeNull()
    expect(at('@maya  chen')).toBeNull()
    expect(at('@one two three four five')).toBeNull()
  })

  it('is no trigger on a mention that is attached, or the words typed after it', () => {
    const done = { mentions: ['Maya Chen'] }
    expect(at('@Maya Chen', done)).toBeNull()
    expect(at('@Maya Chen what is', done)).toBeNull()
    expect(findTriggerToken('@Maya Chen', 4, done)).toBeNull()
    // One backspace breaks it: the menu is back to fix it.
    expect(at('@Maya Che', done)).toMatchObject({ query: 'Maya Che' })
  })

  it('is no trigger with the caret before a leading `@`', () => {
    expect(findTriggerToken('@may', 0)).toBeNull()
    expect(findTriggerToken('@may', 4)).toMatchObject({ trigger: '@', start: 0, query: 'may' })
  })

  it('takes the trigger nearest the caret', () => {
    expect(at('@maya /br')).toMatchObject({ trigger: '/', query: 'br' })
    expect(at('/brief @ma')).toMatchObject({ trigger: '@', query: 'ma' })
  })
})

describe('what a pick does to the text', () => {
  it('replaces the trigger and the word being typed, then one space, the caret after it', () => {
    const value = 'ask @ma about it'
    const token = findTriggerToken(value, 7)!
    expect(replaceToken(value, token, '@Maya Chen')).toEqual({ value: 'ask @Maya Chen about it', caret: 15 })
    expect(replaceToken('@mar', at('@mar')!, '@Mara')).toEqual({ value: '@Mara ', caret: 6 })
    // The rest of a word the caret was inside goes too.
    expect(replaceToken('/summary', findTriggerToken('/summary', 3)!, '/summarize')).toEqual({ value: '/summarize ', caret: 11 })
  })

  it('takes a page’s trigger out of the draft, leaving the rest as it was', () => {
    expect(removeToken('/capt', at('/capt')!)).toEqual({ value: '', caret: 0 })
    const value = 'hello /cal world'
    expect(removeToken(value, findTriggerToken(value, 10)!)).toEqual({ value: 'hello world', caret: 6 })
  })

  it('puts a skill where it was typed, and the one armed before it out of the text', () => {
    expect(pickSkillText('/br', at('/br'), 'brief', null)).toEqual({ value: '/brief ', caret: 7 })
    const value = '/scout find leads /br'
    expect(pickSkillText(value, at(value), 'brief', 'scout')).toEqual({ value: 'find leads /brief ', caret: 18 })
  })

  it('leads the draft with a skill picked away from the box', () => {
    expect(pickSkillText('', null, 'brief', null)).toEqual({ value: '/brief ', caret: 7 })
    expect(pickSkillText('  what happened', null, 'brief', null)).toEqual({ value: '/brief what happened', caret: 20 })
    expect(pickSkillText('/scout hi', null, 'brief', 'scout')).toEqual({ value: '/brief hi', caret: 9 })
  })

  it('ends the draft with a mention picked away from the box', () => {
    expect(appendMention('', '@Maya')).toEqual({ value: '@Maya ', caret: 6 })
    expect(appendMention('ask', '@Maya')).toEqual({ value: 'ask @Maya ', caret: 10 })
    expect(appendMention('ask ', '@Maya')).toEqual({ value: 'ask @Maya ', caret: 10 })
  })
})

const skill = (slug: string, name: string) => ({ id: `s-${slug}`, slug, name, icon: null, color: null, description: null, views_context: null })
const contact = (id: string, full_name: string, score: number): MenuSearchRow => ({
  kind: 'contact',
  contact: { id, full_name, email: null, job_title: null, company_name: null, is_member: false } satisfies MentionContact,
  score,
})
const capture = (id: string, title: string, score = 0): MenuSearchRow => ({
  kind: 'capture',
  capture: { id, title, created_at: '2026-10-01T00:00:00Z' } as unknown as CaptureListItem,
  score,
})
const action = (id: string, title: string, identifier: string, score: number): MenuSearchRow => ({ kind: 'action', id, title, identifier, status: 'Todo', score })

/** The main chat: pages, skills, records open, everything mentionable. */
const MAIN: MenuOffer = {
  pages: true,
  skills: true,
  open: true,
  mention: new Set<MenuSearchKind>(MENTION_PICKER_KINDS),
}
/** A run's chat: skills, and captures, people and companies to mention; nothing opens. */
const RUN: MenuOffer = { pages: false, skills: true, open: false, mention: new Set<MenuSearchKind>(['capture', 'contact', 'company']) }

describe('buildMenu', () => {
  const pages = pagesFor(getEdition('full'), { desktop: true })
  const sources: MenuSources = {
    pages,
    skills: [skill('morning-brief', 'Morning Brief'), skill('scout', 'Scout')],
    records: { contact: [contact('c1', 'Maya Chen', 0), contact('c2', 'Scott Ray', 0)], capture: [capture('n1', 'Weekly sync')] },
  }
  const keys = (menu: ReturnType<typeof buildMenu>) => menu.sections.map((s) => s.key)

  it('with nothing typed: both list recent people, then (`/`) the pages, then the skills', () => {
    expect(keys(buildMenu('/', 'all', '', MAIN, sources))).toEqual(['people', 'pages', 'skills'])
    expect(keys(buildMenu('@', 'all', '', MAIN, sources))).toEqual(['people', 'skills'])
  })

  it('caps each kind in All, counting pages and skills but not records (only as many as were asked for)', () => {
    const menu = buildMenu('/', 'all', '', MAIN, sources)
    const pageSection = menu.sections.find((s) => s.key === 'pages')!
    expect(pageSection.items).toHaveLength(8)
    expect(pageSection).toMatchObject({ total: pages.length, totalKnown: true })
    const many = Array.from({ length: 6 }, (_, i) => action(`a${i}`, `Pricing ${i}`, `GEN-${i}`, 0.85))
    const actions = buildMenu('/', 'all', 'pricing', MAIN, { ...sources, records: { action: many } }).sections.find((s) => s.key === 'actions')!
    expect(actions.items).toHaveLength(4)
    expect(actions.totalKnown).toBe(false)
  })

  it('once something is typed searches every kind, the best match first', () => {
    // An exact page beats a person who only half matches: `/calendar` puts the Calendar page on top.
    const calendar = buildMenu('/', 'all', 'calendar', MAIN, { ...sources, records: { contact: [contact('c3', 'Cal Calendarson', 0.85)] } })
    expect(calendar.sections[0].items[0]).toMatchObject({ kind: 'page', page: { slug: 'calendar' } })
    // A person's name leads when it matches best.
    expect(keys(buildMenu('/', 'all', 'maya', MAIN, { ...sources, records: { contact: [contact('c1', 'Maya Chen', 0.85)] } }))[0]).toBe('people')
    // A tie keeps the one order: `/sc` finds Scout the skill before Scott.
    const sc = keys(buildMenu('/', 'all', 'sc', MAIN, { ...sources, records: { contact: [contact('c2', 'Scott Ray', 0.85)] } }))
    expect(sc.indexOf('skills')).toBeLessThan(sc.indexOf('people'))
    // `@` lists no page to tie with: `@ma` is Maya.
    expect(buildMenu('@', 'all', 'ma', MAIN, { ...sources, records: { contact: [contact('c1', 'Maya Chen', 0.85)] } }).sections[0].key).toBe('people')
    // An identifier puts its action first.
    const gen = buildMenu('/', 'all', 'GEN-42', MAIN, { ...sources, records: { action: [action('a42', 'Pricing page copy', 'GEN-42', 1.1)] } })
    expect(gen.sections[0].items[0]).toMatchObject({ kind: 'record', row: { id: 'a42' } })
  })

  it('finds a page by a keyword only from its start: "tom" is no "automations"', () => {
    const tom = buildMenu('/', 'all', 'tom', MAIN, { ...sources, records: { contact: [contact('c9', 'Tom Reyes', 0.85)] } })
    expect(keys(tom)).not.toContain('pages')
    expect(tom.sections[0].items[0]).toMatchObject({ kind: 'record', row: { kind: 'contact' } })
    expect(buildMenu('/', 'all', 'auto', MAIN, sources).sections[0].items[0]).toMatchObject({ kind: 'page', page: { slug: 'flows' } })
  })

  it('numbers the rows across sections, as the keys move through them', () => {
    const { sections } = buildMenu('/', 'all', '', MAIN, sources)
    expect(sections[0].offset).toBe(0)
    expect(sections[1].offset).toBe(sections[0].items.length)
  })

  it('a tab shows its own kind, all of it', () => {
    const menu = buildMenu('/', 'pages', '', MAIN, sources)
    expect(keys(menu)).toEqual(['pages'])
    expect(menu.sections[0].items).toHaveLength(pages.length)
    expect(keys(buildMenu('/', 'people', '', MAIN, sources))).toEqual(['people'])
  })

  it('offers a tab only for kinds that found something, and the tab picked, in one fixed order', () => {
    expect(buildMenu('/', 'all', '', MAIN, sources).tabs).toEqual(['all', 'pages', 'skills', 'people'])
    const typed = buildMenu('/', 'all', 'pricing', MAIN, { ...sources, records: { action: [action('a1', 'Pricing', 'GEN-1', 1)], capture: [] } })
    expect(typed.tabs).toEqual(['all', 'actions'])
    expect(buildMenu('/', 'docs', 'pricing', MAIN, { ...sources, records: {} }).tabs).toEqual(['all', 'docs'])
  })

  it('`/` and `@` offer the same things, less what `@` can’t attach (pages, agents)', () => {
    // `/` also finds team chat messages (migration 561); `@` never attaches one.
    expect(offeredKinds('/', MAIN)).toEqual(['pages', 'skills', 'people', 'actions', 'docs', 'projects', 'initiatives', 'captures', 'companies', 'deals', 'flows', 'files', 'events', 'agents', 'messages'])
    // Records first, the skills last (a tie goes to the record).
    expect(offeredKinds('@', MAIN)).toEqual(['people', 'actions', 'docs', 'projects', 'initiatives', 'captures', 'companies', 'deals', 'flows', 'files', 'events', 'skills'])
    expect(offeredKinds('@', RUN)).toEqual(['people', 'captures', 'companies', 'skills'])
  })

  it('Tab and Shift+Tab go round the tabs offered', () => {
    const tabs = ['all', 'pages', 'skills'] as const
    expect(cycleTab(tabs, 'all', 1)).toBe('pages')
    expect(cycleTab(tabs, 'skills', 1)).toBe('all')
    expect(cycleTab(tabs, 'all', -1)).toBe('skills')
  })
})

describe('verbFor: `/` opens, `@` attaches', () => {
  const record = (row: MenuSearchRow): MenuItem => ({ kind: 'record', row })
  const maya = record(contact('c1', 'Maya Chen', 1))
  const agent = record({ kind: 'agent', id: 'ag', title: 'Scout', description: null, icon: null, score: 1 })

  it('a record opens under `/` and is attached under `@`', () => {
    expect(verbFor('/', maya)).toBe('open')
    expect(verbFor('@', maya)).toBe('mention')
  })

  it('a skill is used whichever character found it: under `@` it arms the message', () => {
    expect(verbFor('@', { kind: 'skill', skill: skill('scout', 'Scout') })).toBe('use')
  })

  it('a page and an agent open; a skill is used', () => {
    expect(verbFor('/', { kind: 'page', page: pagesFor(getEdition('full'), { desktop: true })[0] })).toBe('open')
    expect(verbFor('/', agent)).toBe('open')
    expect(verbFor('/', { kind: 'skill', skill: skill('scout', 'Scout') })).toBe('use')
  })
})

describe('serverSearch', () => {
  it('with nothing typed asks for the first view (recent people); once typed, every kind offered', () => {
    expect(serverSearch('/', 'all', '', offeredKinds('/', MAIN))).toEqual({ kinds: ['contact'], limit: 8 })
    expect(serverSearch('@', 'all', '', offeredKinds('@', MAIN))).toEqual({ kinds: ['contact'], limit: 8 })
    expect(serverSearch('/', 'all', 't', offeredKinds('/', MAIN))).toEqual({
      kinds: ['contact', 'action', 'document', 'project', 'initiative', 'capture', 'company', 'deal', 'flow', 'attachment', 'calendar_event', 'agent', 'team_chat_message'],
      limit: 8,
    })
    // `@` never asks for agents or messages: nothing attaches them.
    expect(serverSearch('@', 'all', 't', offeredKinds('@', MAIN))!.kinds).not.toContain('agent')
    expect(serverSearch('@', 'all', 't', offeredKinds('@', MAIN))!.kinds).not.toContain('team_chat_message')
  })
  it('a tab with nothing typed asks for its own kind, a tab’s worth; a Pages tab asks nothing', () => {
    expect(serverSearch('/', 'actions', '', offeredKinds('/', MAIN))).toEqual({ kinds: ['action'], limit: 25 })
    expect(serverSearch('/', 'pages', '', offeredKinds('/', MAIN))).toBeNull()
    // A run's `/` is skills alone: nothing to ask the server.
    expect(serverSearch('/', 'all', 'brief', offeredKinds('/', RUN))).toBeNull()
  })
})

describe('sameTriggerToken', () => {
  it('no trigger is the same as no trigger: a caret move in plain text changes nothing', () => {
    expect(sameTriggerToken(findTriggerToken('hello world', 2), findTriggerToken('hello world', 8))).toBe(true)
  })
  it('a different query or caret is a different trigger', () => {
    expect(sameTriggerToken(at('/ca'), at('/cal'))).toBe(false)
    expect(sameTriggerToken(findTriggerToken('/cal', 2), findTriggerToken('/cal', 4))).toBe(false)
    expect(sameTriggerToken(at('/cal'), null)).toBe(false)
    expect(sameTriggerToken(at('/cal'), at('/cal'))).toBe(true)
  })
})

describe('menuTakesEnter', () => {
  it('picks while there are rows', () => {
    expect(menuTakesEnter(3, false)).toBe(true)
    expect(menuTakesEnter(3, true)).toBe(true)
  })
  it('with no rows Enter is the box’s (it sends), except while the first rows load', () => {
    expect(menuTakesEnter(0, false)).toBe(false)
    expect(menuTakesEnter(0, true)).toBe(true)
  })
})

describe('the menu in an edition’s words', () => {
  const service = getEdition('service')
  const sources: MenuSources = {
    pages: pagesFor(service, { desktop: true }),
    skills: [skill('morning-brief', 'Morning Brief')],
    records: { contact: [contact('c1', 'Maya Chen', 0)], action: [action('a1', 'Pick up the Lee rug', 'GEN-1', 0.5)], capture: [capture('n1', 'Call with Mrs Lee', 0.5)] },
    edition: service,
  }

  it('names the tabs and sections a service business renames, and leaves the rest', () => {
    expect(menuTabLabel('actions', service)).toBe('Jobs')
    expect(menuTabLabel('people', service)).toBe('Customers')
    expect(menuTabLabel('captures', service)).toBe('Calls')
    expect(menuTabLabel('initiatives', service)).toBe('Goals')
    expect(menuTabLabel('companies', service)).toBe('Companies')
    expect(menuTabLabel('pages', service)).toBe('Pages')
    expect(menuTabLabel('all', service)).toBe('All')
    const labels = buildMenu('/', 'all', 'lee', MAIN, sources).sections.map((s) => s.label)
    expect(labels).toEqual(expect.arrayContaining(['Jobs', 'Calls']))
    expect(labels).not.toContain('Actions')
  })

  it('is TAB_LABELS word for word in an edition that says nothing, or with none', () => {
    for (const tab of Object.keys(TAB_LABELS) as (keyof typeof TAB_LABELS)[]) {
      expect(menuTabLabel(tab, getEdition('full'))).toBe(TAB_LABELS[tab])
      expect(menuTabLabel(tab)).toBe(TAB_LABELS[tab])
    }
  })

  it('`/jobs` puts My jobs first, ahead of skills and records', () => {
    const jobs = buildMenu('/', 'all', 'jobs', MAIN, sources)
    expect(jobs.sections[0].items[0]).toMatchObject({ kind: 'page', page: { slug: 'actions', shownSlug: 'jobs', label: 'My jobs' } })
    // The app's slug still finds it.
    expect(buildMenu('/', 'all', 'actions', MAIN, sources).sections[0].items[0]).toMatchObject({ kind: 'page', page: { slug: 'actions' } })
  })
})

describe('the record in front (the palette over a record card)', () => {
  const sources: MenuSources = {
    pages: [],
    skills: [],
    records: {},
    recordActions: {
      entity: { type: 'document', id: 'doc-1', label: 'Q4 renewals plan' },
      label: 'Q4 renewals plan',
      actions: [
        { id: 'copy_link', label: 'Copy link' },
        { id: 'copy_id', label: 'Copy ID' },
        { id: 'archive', label: 'Archive' },
      ],
    },
  }
  const actionsOf = (section: { items: MenuItem[] }) => section.items.map((i) => (i.kind === 'entity_action' ? i.action : null))

  it("leads with the record's own actions before anything is typed", () => {
    const menu = buildMenu('/', 'all', '', MAIN, sources)
    expect(menu.sections[0]).toMatchObject({ key: 'record_actions', label: 'Q4 renewals plan', offset: 0 })
    expect(actionsOf(menu.sections[0])).toEqual(['copy_link', 'copy_id', 'archive'])
    expect(menu.tabs).not.toContain('record_actions')
  })

  it('narrows them by what is typed, and leaves them out of a tab and out of `@`', () => {
    expect(actionsOf(buildMenu('/', 'all', 'arch', MAIN, sources).sections[0])).toEqual(['archive'])
    expect(buildMenu('/', 'all', 'zzz', MAIN, sources).sections.map((s) => s.key)).not.toContain('record_actions')
    expect(buildMenu('/', 'people', '', MAIN, sources).sections.map((s) => s.key)).not.toContain('record_actions')
    expect(buildMenu('@', 'all', '', MAIN, sources).sections.map((s) => s.key)).not.toContain('record_actions')
  })

  it('picking one uses it', () => {
    const item = buildMenu('/', 'all', '', MAIN, sources).sections[0].items[0]
    expect(verbFor('/', item)).toBe('use')
  })
})
