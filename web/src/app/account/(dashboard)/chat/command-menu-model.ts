/**
 * The composer's one menu (`/` and `@`), as pure functions: where a trigger is
 * being typed, what picking something does to the text, and what the menu
 * lists for a query. No React; command-menu.tsx draws it.
 *
 * ── The text is the query ───────────────────────────────────────────────────
 * Typing `/` or `@` at the start of a word opens the menu, and what follows the
 * trigger, up to the caret, is what it searches. The caret never leaves the
 * box, so a fast typist's keys all land in one place, and the menu is read
 * from (text, caret) on every change: nothing is remembered that could drift.
 * Delete the trigger and the menu is gone with nothing left behind; backspace
 * back into a trigger and it is open again; a space after `/` (or one straight
 * after `@`) means it was only a character.
 *
 * ── `/` opens, `@` attaches ─────────────────────────────────────────────────
 * (docs/plans/slash-search.md) `/` is search, and only global (the palette:
 * `/` outside a text field, ⌘K, the top bar's Search): pages, skills, agents
 * and every record, Enter opening what's picked (a record's card, a page) or
 * using a skill. `@` is a chat box's (in the box `/` is only a character):
 * the records it can put in the message and its skills, Enter attaching a
 * record or arming a skill. Each does its one thing; nothing swaps them. Both
 * list the same things, less what `@` can't attach (pages, agents): before
 * anything is typed, recent people, then (`/`) the pages, then the skills;
 * once typed, every kind, the best match first. Tabs (only for kinds that
 * found something) narrow it to one kind.
 */
import type { EditionDefinition, EditionTerm } from '@/lib/editions/manifest'
import { editionWords } from '@/lib/editions/words'
import { filterPages, type OfferedPage } from '@/lib/chat-cards/page-menu'
import { normalizeQuery, scoreText, type MenuSearchKind, type MenuSearchRow } from '@/lib/search/menu-search'
import type { SkillCommand } from './chat-panel'

export type MenuTrigger = '/' | '@'

/** A trigger being typed: the `/` or `@` at `start`, and what follows it up to the caret. */
export interface TriggerToken {
  trigger: MenuTrigger
  /** Index of the trigger character in the text. */
  start: number
  /** The caret: where the query ends. */
  caret: number
  /** What is typed between the trigger and the caret. */
  query: string
}

/** A command never runs this long; past it, a `/word` is just text. */
const MAX_SLASH_QUERY = 48
/** A name, typed out: a few words at most. */
const MAX_AT_QUERY = 48
const MAX_AT_WORDS = 4

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'

/** A finished mention ends at the end of the text, a space or punctuation. */
const MENTION_END = /^($|[\s.,!?;:])/

/**
 * The trigger the caret is in, or null.
 *
 * `/` opens at the start of a word and runs to the next space: `/brief`, not
 * `and/or` or `/usr/bin`. `@` opens at the start of a word too, and its query
 * may hold single spaces (`@Maya Chen`), but not lead with one (`@ ` is just
 * an at sign), nor break a line or run past a few words.
 *
 * A trigger that is already done is no trigger: a skill that is armed
 * (`skills`, its `/slug`) or a mention that is attached (`mentions`, its
 * label), with the caret inside it or in the words typed after it. Enter
 * after `/brief` sends; one backspace into `@Maya Chen` breaks the mention,
 * and the menu is back.
 */
export function findTriggerToken(
  value: string,
  caret: number,
  done: { skills?: readonly string[]; mentions?: readonly string[] } = {},
): TriggerToken | null {
  if (caret < 0 || caret > value.length) return null

  // The word the caret is in, from its start.
  let wordStart = caret
  while (wordStart > 0 && !isSpace(value[wordStart - 1])) wordStart--

  if (value[wordStart] === '/' && wordStart < caret) {
    const query = value.slice(wordStart + 1, caret)
    if (query.includes('/') || query.length > MAX_SLASH_QUERY) return null
    let wordEnd = caret
    while (wordEnd < value.length && !isSpace(value[wordEnd])) wordEnd++
    const word = value.slice(wordStart + 1, wordEnd)
    if (done.skills?.includes(word)) return null
    return { trigger: '/', start: wordStart, caret, query }
  }

  // `@`: the nearest one on this line, before the caret.
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  // (lastIndexOf from -1 still looks at index 0: a caret before a leading `@` is in no trigger.)
  const at = caret > 0 ? value.lastIndexOf('@', caret - 1) : -1
  if (at < lineStart || caret - at - 1 > MAX_AT_QUERY) return null
  if (at > 0 && !isSpace(value[at - 1])) return null
  const query = value.slice(at + 1, caret)
  if (isSpace(query[0]) || query.includes('  ') || query.split(' ').length > MAX_AT_WORDS) return null
  const rest = value.slice(at + 1)
  for (const label of done.mentions ?? []) {
    if (label && rest.startsWith(label) && MENTION_END.test(rest.slice(label.length))) return null
  }
  return { trigger: '@', start: at, caret, query }
}

/** The same trigger, read the same way (null for no trigger): a caret move that changes neither moves no state. */
export function sameTriggerToken(a: TriggerToken | null, b: TriggerToken | null): boolean {
  if (!a || !b) return a === b
  return a.trigger === b.trigger && a.start === b.start && a.caret === b.caret && a.query === b.query
}

/** Where the token's text ends: the caret, then the rest of a word being edited. */
function tokenEnd(value: string, token: TriggerToken): number {
  let end = token.caret
  while (end < value.length && !isSpace(value[end])) end++
  return end
}

/**
 * Put `text` where the token is (the trigger, the query, and the rest of the
 * word the caret was in), then one space, and the caret after it. A space
 * already there is used, not doubled.
 */
export function replaceToken(value: string, token: TriggerToken, text: string): { value: string; caret: number } {
  const before = value.slice(0, token.start)
  const after = value.slice(tokenEnd(value, token))
  const next = before + text + (after.startsWith(' ') ? '' : ' ') + after
  return { value: next, caret: before.length + text.length + 1 }
}

/** Take the token's text out (a page was opened: nothing of it stays in the draft). */
export function removeToken(value: string, token: TriggerToken): { value: string; caret: number } {
  return cutRange(value, token.start, tokenEnd(value, token))
}

/** Cut [from, to) out of the text, closing the gap to one space. */
function cutRange(value: string, from: number, to: number): { value: string; caret: number } {
  const before = value.slice(0, from).replace(/[ \t]+$/, '')
  const after = value.slice(to).replace(/^[ \t]+/, '')
  const joiner = before && after && !before.endsWith('\n') && !after.startsWith('\n') ? ' ' : ''
  return { value: before + joiner + after, caret: before.length + joiner.length }
}

/** Where a skill's `/slug` stands in the draft, as its own word. */
function findSkillText(value: string, slug: string): { from: number; to: number } | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`).exec(value)
  if (!match) return null
  const from = match.index + match[1].length
  return { from, to: from + slug.length + 1 }
}

/**
 * The draft once a skill is picked: its `/slug` where the trigger was typed
 * (or, picked away from the box, leading the draft with the caret at the
 * end), and the skill armed before it, if another, out of the text: one skill
 * drives a turn, so one `/slug` names it.
 */
export function pickSkillText(
  value: string,
  token: TriggerToken | null,
  slug: string,
  armed: string | null,
): { value: string; caret: number } {
  let placed: { value: string; caret: number }
  if (token) {
    placed = replaceToken(value, token, `/${slug}`)
  } else {
    const next = `/${slug} ${value.replace(/^\s+/, '')}`
    placed = { value: next, caret: next.length }
  }
  if (!armed || armed === slug) return placed
  const old = findSkillText(placed.value, armed)
  if (!old) return placed
  const cut = cutRange(placed.value, old.from, old.to)
  const shift = placed.value.length - cut.value.length
  return { value: cut.value, caret: old.from < placed.caret ? placed.caret - shift : placed.caret }
}

/** A mention picked away from the box: it ends the draft, the caret after it. */
export function appendMention(value: string, text: string): { value: string; caret: number } {
  const sep = value && !isSpace(value[value.length - 1]) ? ' ' : ''
  const next = `${value}${sep}${text} `
  return { value: next, caret: next.length }
}

// ── What the menu lists ─────────────────────────────────────────────────────

/** The record kinds, as the menu's sections name them. */
export type RecordMenuKind = 'actions' | 'docs' | 'projects' | 'initiatives' | 'captures' | 'people' | 'companies' | 'agents'
export type MenuKind = 'pages' | 'skills' | RecordMenuKind
export type MenuTab = 'all' | MenuKind

export const TAB_LABELS: Record<MenuTab, string> = {
  all: 'All',
  pages: 'Pages',
  skills: 'Skills',
  actions: 'Actions',
  docs: 'Docs',
  projects: 'Projects',
  initiatives: 'Initiatives',
  captures: 'Captures',
  people: 'People',
  companies: 'Companies',
  agents: 'Agents',
}

/** The app term behind each record kind (src/lib/editions/words.ts), for its name in an edition's words. */
const KIND_TERM: Partial<Record<RecordMenuKind, EditionTerm>> = {
  actions: 'action',
  docs: 'document',
  projects: 'project',
  initiatives: 'initiative',
  captures: 'capture',
  people: 'contact',
  companies: 'company',
}

/**
 * A tab's or section's name: the edition's word where it renames that kind
 * ("Jobs" for Actions, "Customers" for People in a service business), else
 * TAB_LABELS.
 */
export function menuTabLabel(tab: MenuTab, edition?: Pick<EditionDefinition, 'words'> | null): string {
  const term = tab === 'all' || !isRecordKind(tab) ? undefined : KIND_TERM[tab]
  const own = term ? editionWords(edition).terms[term] : undefined
  return own ? own.many.charAt(0).toUpperCase() + own.many.slice(1) : TAB_LABELS[tab]
}

/** The search kind behind each record section, and back. */
export const SEARCH_KIND: Record<RecordMenuKind, MenuSearchKind> = {
  actions: 'action',
  docs: 'document',
  projects: 'project',
  initiatives: 'initiative',
  captures: 'capture',
  people: 'contact',
  companies: 'company',
  agents: 'agent',
}
export const MENU_KIND: Record<MenuSearchKind, RecordMenuKind> = {
  action: 'actions',
  document: 'docs',
  project: 'projects',
  initiative: 'initiatives',
  capture: 'captures',
  contact: 'people',
  company: 'companies',
  agent: 'agents',
}

export function isRecordKind(kind: MenuKind): kind is RecordMenuKind {
  return kind !== 'pages' && kind !== 'skills'
}

export type MenuItem =
  | { kind: 'page'; page: OfferedPage }
  | { kind: 'skill'; skill: SkillCommand }
  | { kind: 'record'; row: MenuSearchRow }

/** What picking a row does: open it (a page, a record's card), use it (a skill), or put it in the message. */
export type MenuVerb = 'open' | 'use' | 'mention'

/** What this composer can do with what the menu finds. */
export interface MenuOffer {
  /** Pages it may open (the main chat's). */
  pages: boolean
  /** It has skills to offer. */
  skills: boolean
  /** It can open a record's card (the main chat). */
  open: boolean
  /** The record kinds it can put in a message. */
  mention: ReadonlySet<MenuSearchKind>
}

/**
 * The kinds a trigger offers here, in its order. `/` offers what opens: the
 * pages, the skills, and (where the composer opens cards) every record kind
 * and the agents. `@` offers what the message can carry: the record kinds the
 * composer can attach, and its skills (picked, one arms the message: Liam,
 * 10-20, "why can't you just @ mention a skill"), after the records.
 */
export function offeredKinds(trigger: MenuTrigger, offer: MenuOffer): MenuKind[] {
  if (trigger === '@') {
    return AT_ORDER.filter((kind) => (kind === 'skills' ? offer.skills : isRecordKind(kind) && offer.mention.has(SEARCH_KIND[kind])))
  }
  return ORDER.filter((kind) => {
    if (kind === 'pages') return offer.pages
    if (kind === 'skills') return offer.skills
    return offer.open
  })
}

/** What Enter does to a row: `/` opens it (a skill is used), `@` attaches it. */
export function verbFor(trigger: MenuTrigger, item: MenuItem): MenuVerb {
  if (item.kind === 'skill') return 'use'
  if (item.kind === 'page') return 'open'
  return trigger === '@' ? 'mention' : 'open'
}

/** The kinds in order: tabs keep these places, and a tie between two kinds' best rows keeps it. */
const ORDER: readonly MenuKind[] = ['pages', 'skills', 'people', 'actions', 'docs', 'projects', 'initiatives', 'captures', 'companies', 'agents']
/** `@`'s: the records first (`@ma` is Maya before a skill named like her), its skills last. */
const AT_ORDER: readonly MenuKind[] = ['people', 'actions', 'docs', 'projects', 'initiatives', 'captures', 'companies', 'skills']
/** What each shows before anything is typed, in this order: recent people first. */
const LEADS: Record<MenuTrigger, readonly MenuKind[]> = {
  '/': ['people', 'pages', 'skills'],
  // The same first view, less what can't be attached (pages).
  '@': ['people', 'skills'],
}
/** In All: how many of a kind it shows (pages and skills get more room; a kind's tab shows them all). */
const ALL_CAP_WIDE = 8
const ALL_CAP = 4
const capOf = (kind: MenuKind) => (kind === 'pages' || kind === 'skills' ? ALL_CAP_WIDE : ALL_CAP)

/** The kinds a trigger shows before anything is typed (All, no query). */
export function leadKinds(trigger: MenuTrigger): readonly MenuKind[] {
  return LEADS[trigger]
}

/** The kinds a menu in this state shows: its tab's, else every offered kind once something is typed, else the leads. */
export function searchedKinds(trigger: MenuTrigger, tab: MenuTab, query: string, offered: readonly MenuKind[]): MenuKind[] {
  if (tab !== 'all') return offered.includes(tab) ? [tab] : []
  return query.trim() ? [...offered] : LEADS[trigger].filter((k) => offered.includes(k))
}

/** Rows per kind the server is asked for: a few in All (enough to know there are more), a tab's worth in a tab. */
export const ALL_SEARCH_LIMIT = 8
export const TAB_SEARCH_LIMIT = 25

/**
 * The server search a menu in this state makes (debounced, the last one
 * aborted), or null for none. Once something is typed it covers every record
 * kind offered, whatever the tab, so the tabs can show which kinds found
 * something; with nothing typed, only what's on screen (recent people, or the
 * tab's own kind).
 */
export function serverSearch(
  trigger: MenuTrigger,
  tab: MenuTab,
  query: string,
  offered: readonly MenuKind[],
): { kinds: MenuSearchKind[]; limit: number } | null {
  const kinds = (query.trim() ? offered : searchedKinds(trigger, tab, query, offered)).filter(isRecordKind).map((k) => SEARCH_KIND[k])
  if (!kinds.length) return null
  return { kinds, limit: tab === 'all' ? ALL_SEARCH_LIMIT : TAB_SEARCH_LIMIT }
}

/**
 * Whether Enter, pressed while the menu shows, is the menu's. With rows it
 * picks the highlighted one. With none (a tab with nothing matching, a search
 * that came back empty) it is the box's again, and sends; the one exception is
 * while the first rows are still loading (the menu says so), when it waits
 * and does nothing, rather than send a half-typed mention.
 */
export function menuTakesEnter(rowCount: number, loading: boolean): boolean {
  return rowCount > 0 || loading
}

function pageScore(page: Pick<OfferedPage, 'slug' | 'shownSlug' | 'label' | 'keywords'>, q: string): number {
  if (!q) return 0
  // A keyword from a word's start ("tasks", "crm"), never inside one ("tom" is no "automations").
  const keyword = (page.keywords ?? []).some((k) => scoreText(k, q) >= 0.7) ? 0.5 : 0
  // The slug the person sees in this workspace's words (`jobs`) scores as the slug does.
  return Math.max(scoreText(page.slug, q), page.shownSlug ? scoreText(page.shownSlug, q) : 0, scoreText(page.label, q), keyword)
}

function skillScore(skill: SkillCommand, q: string): number {
  if (!q) return 0
  return Math.max(scoreText(skill.slug, q), scoreText(skill.name, q))
}

/** The skills a query finds, the best match first (ties keep their order). */
export function filterSkills(skills: readonly SkillCommand[], query: string): SkillCommand[] {
  const q = normalizeQuery(query)
  if (!q) return [...skills]
  return skills
    .map((skill, i) => ({ skill, i, score: skillScore(skill, q) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.skill)
}

export interface MenuSources {
  pages: readonly OfferedPage[]
  skills: readonly SkillCommand[]
  /** The server's rows by kind, best first (already narrowed to the query, what's attached left out). */
  records: Partial<Record<MenuSearchKind, readonly MenuSearchRow[]>>
  /** The workspace's edition, for the sections' names in its words. Absent: the app's own. */
  edition?: Pick<EditionDefinition, 'words'> | null
}

export interface MenuSection {
  key: MenuKind
  label: string
  /** The rows shown (All caps each kind; a kind's own tab shows them all). */
  items: MenuItem[]
  /** How many matched, shown or not. */
  total: number
  /** Whether `total` is all there are (pages and skills), or only as many as were asked for (records). */
  totalKnown: boolean
  /** Index of the first row in the flat list the keys move through. */
  offset: number
}

export interface Menu {
  sections: MenuSection[]
  /** The tabs offered: All, the kinds that found something, and the tab picked. */
  tabs: MenuTab[]
}

/**
 * The menu for a trigger, tab and query: its sections in the order they show,
 * each with its offset into the one flat list the keys move through, and the
 * tabs.
 *
 * In All, the kinds come in the trigger's order until something is typed;
 * then the kind whose best row matches best leads (ties keep the trigger's
 * order), so `/calendar` puts the Calendar page first, `/maya` Maya and
 * `/GEN-42` that action.
 */
export function buildMenu(trigger: MenuTrigger, tab: MenuTab, query: string, offer: MenuOffer, sources: MenuSources): Menu {
  const q = normalizeQuery(query)
  const offered = offeredKinds(trigger, offer)
  const rowsOf = (kind: MenuKind): { items: MenuItem[]; best: number } => {
    if (kind === 'pages') {
      const pages = offer.pages ? sources.pages : []
      return {
        items: filterPages(pages, q).map((page): MenuItem => ({ kind: 'page', page })),
        best: Math.max(0, ...pages.map((p) => pageScore(p, q))),
      }
    }
    if (kind === 'skills') {
      const found = filterSkills(sources.skills, q)
      return {
        items: found.map((skill): MenuItem => ({ kind: 'skill', skill })),
        best: Math.max(0, ...found.map((s) => skillScore(s, q))),
      }
    }
    const rows = sources.records[SEARCH_KIND[kind]] ?? []
    return { items: rows.map((row): MenuItem => ({ kind: 'record', row })), best: Math.max(0, ...rows.map((r) => r.score)) }
  }

  const all = new Map(offered.map((kind) => [kind, rowsOf(kind)]))
  const shown = searchedKinds(trigger, tab, query, offered)
  // Nothing typed: the leads' own order (people first). Typed: the best row's kind first, ties in ORDER.
  const ordered = q
    ? offered
        .map((kind, i) => ({ kind, i, best: all.get(kind)!.best }))
        .filter(({ kind }) => shown.includes(kind))
        .sort((a, b) => b.best - a.best || a.i - b.i)
    : shown.map((kind) => ({ kind }))

  const sections: Omit<MenuSection, 'offset'>[] = []
  for (const { kind } of ordered) {
    const items = all.get(kind)!.items
    if (!items.length) continue
    const cap = tab !== 'all' ? Infinity : capOf(kind)
    sections.push({ key: kind, label: menuTabLabel(kind, sources.edition), items: items.slice(0, cap), total: items.length, totalKnown: !isRecordKind(kind) })
  }

  let offset = 0
  const withOffsets = sections.map((s) => {
    const section = { ...s, offset }
    offset += s.items.length
    return section
  })

  // A tab for each kind with something to show for what's typed (with
  // nothing typed: the leads), and the tab picked, whatever it holds.
  const tabs: MenuTab[] = ['all']
  for (const kind of offered) {
    const hasRows = all.get(kind)!.items.length > 0 && (q ? true : LEADS[trigger].includes(kind))
    if (hasRows || kind === tab) tabs.push(kind)
  }
  return { sections: withOffsets, tabs }
}

/** The tab after (or before) `tab`, round the ones offered. */
export function cycleTab(tabs: readonly MenuTab[], tab: MenuTab, step: 1 | -1): MenuTab {
  const i = tabs.indexOf(tab)
  if (i < 0) return tabs[0] ?? 'all'
  return tabs[(i + step + tabs.length) % tabs.length]
}

/** The words a row is found by in the browser (narrowing what's loaded while the server answers). */
export function rowSearchText(row: MenuSearchRow): string {
  switch (row.kind) {
    case 'action':
      return `${row.title} ${row.identifier ?? ''}`
    case 'capture':
      return row.capture.title
    case 'contact':
      return `${row.contact.full_name ?? ''} ${row.contact.email ?? ''}`
    case 'company':
      return `${row.company.name} ${row.company.domain ?? ''}`
    default:
      return row.title
  }
}
