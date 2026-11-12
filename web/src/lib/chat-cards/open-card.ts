/**
 * Every way in opens a card (docs/plans/one-agent-and-chat-pages.md, Part 2
 * "No nav", phase P5). There are no pages to navigate to any more: a chip in
 * a message, a notification, a bot's Open button, a desktop event or a deep
 * link puts the thing it names in the chat, as a card the person opened
 * (./opened-card.ts), and the card opens full screen at once. Closing it
 * drops it back into its place in the chat.
 *
 * Two halves:
 *   - cardForTarget: what card a thing opens, and where inside it the card
 *     starts (a flow's editor, a record open on a calendar). Pure.
 *   - openCard / openTarget: ask the dashboard for it (OPEN_CARD_EVENT). The
 *     tabs provider answers: in the chat on screen, after switching to the
 *     thing's own workspace when it is another one.
 *
 * Client-safe: no server imports.
 */
import { CARD_RECORD_TYPES, MAIL_FOLDERS, isCardSpec, type CardRecordType, type CardSpec, type MailFolder } from './kinds'
import { calendarRange, localIsoDate } from './calendar'
import { CARD_PAGES } from './page-menu'
import type { PagePlace } from './pages'
import type { TasksPlace } from './tasks-places'

/** Asks the dashboard to open a card: `detail` is an OpenCardRequest. */
export const OPEN_CARD_EVENT = 'ni:open-card'

/**
 * Asks every chat to put back cards: `detail` is a CardMatch. A discarded
 * capture's card goes out of the way (folded to its pill).
 */
export const FOLD_CARDS_EVENT = 'ni:fold-cards'

/** Which cards a fold is for, and how: `collapse` folds them to their pill, else they only leave full screen. */
export type CardMatch = { kind: 'record'; type: CardRecordType; id: string; collapse?: boolean }

/** Does a card match? */
export function cardMatches(spec: CardSpec, match: CardMatch): boolean {
  return spec.kind === 'record' && spec.record.type === match.type && spec.record.id === match.id
}

export function foldCards(match: CardMatch): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(FOLD_CARDS_EVENT, { detail: match }))
}

/** A record's cards, folded to their pills (a discarded capture's). */
export function foldRecordCards(record: { type: CardRecordType; id: string }): void {
  foldCards({ kind: 'record', ...record, collapse: true })
}

/** Where a card opened from outside the chat starts, beyond its spec (kept with the card). */
export interface OpenCardSeed {
  /** A record open inside it (a calendar card's event, a list card's row). */
  open?: { type: CardRecordType | 'event' | 'thread'; id: string; label?: string } | null
  /** A page card: where in the page it starts. */
  at?: PagePlace | null
  /** A page card: the places above `at` (an eval case's suite), for its Back. */
  trail?: PagePlace[]
  /** A page card: what its full-screen editor is on (a flow). */
  editing?: string | null
  /** The flows card: the run of `editing` its editor lands on (a notification about one run). */
  editingRun?: string | null
  /**
   * My Actions' card: the place inside it to go to (Projects, Initiatives…),
   * a step in its history (a nested page opened: rail-pages.ts nestedPageOpen).
   */
  tasksPlace?: TasksPlace | null
}

export interface OpenCardRequest {
  spec: CardSpec
  seed?: OpenCardSeed
  /** The workspace the thing belongs to: another one is switched to first. Absent: the one on screen. */
  workspaceId?: string | null
  /** How the person opened it ('link', 'notification', 'desktop'…), kept with the card. */
  from: string
  /**
   * A card of the same place already in the chat goes full screen again
   * instead of a second one being put in (a bot's page, the live capture):
   * see sameCardPlace.
   */
  reuse?: boolean
}

/**
 * Do two cards show the same place: the same record, the same page on the
 * same target (or both on its top level), the same calendar range or mailbox?
 * What `reuse` brings back instead of opening a second card.
 */
export function sameCardPlace(a: CardSpec, b: CardSpec): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'record' && b.kind === 'record') return a.record.type === b.record.type && a.record.id === b.record.id
  if (a.kind === 'list' || a.kind === 'calendar' || a.kind === 'mail') return JSON.stringify(a) === JSON.stringify(b)
  const ta = (a as { target?: PagePlace }).target
  const tb = (b as { target?: PagePlace }).target
  return (ta?.type ?? null) === (tb?.type ?? null) && (ta?.id ?? null) === (tb?.id ?? null)
}

/** What a thing to open can be. */
export type OpenTarget =
  | { type: CardRecordType; id: string; title?: string | null; section?: string | null }
  | { type: 'calendar-event'; id: string; title?: string | null; /** Its start (ISO), to open on its day. */ start?: string | null }
  | { type: 'mail'; folder?: string | null; threadId?: string | null; draftId?: string | null; title?: string | null }
  | { type: 'flow'; id: string; title?: string | null; runId?: string | null }
  | { type: 'sequence' | 'prospect_list' | 'eval_suite' | 'package' | 'agent' | 'skill' | 'team'; id: string; title?: string | null }
  | { type: 'eval_case' | 'eval_run'; id: string; title?: string | null; suiteId: string; suiteName?: string | null }
  /** A deal: a pipeline's row (Tables, phase 7), open on the Deals page. */
  | { type: 'deal'; id: string; title?: string | null; pipelineId: string }
  /** A table's row, open in its table (the card finds the table when it isn't named). */
  | { type: 'data_row'; id: string; title?: string | null; tableId?: string | null }
  | { type: 'team_board'; id: string; title?: string | null }
  | { type: 'work_item'; id: string; title?: string | null }
  | { type: 'bot'; teammateId: string; name?: string | null; item?: { itemId: string; title?: string | null } | null }
  | { type: 'guest'; guestId: string; name?: string | null; messageId?: string | null }
  | { type: 'agent_link'; linkId: string; name?: string | null; exchangeId?: string | null }
  /** Team chat, on a channel or on one message (in its channel, or its thread), scrolled to it. */
  | { type: 'team_chat'; channelId?: string | null; messageId?: string | null }
  | { type: 'page'; slug: string }

export interface TargetCard {
  spec: CardSpec
  seed?: OpenCardSeed
}

const label = (title: string | null | undefined, fallback: string): string => {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  return (t || fallback).slice(0, 120)
}

function isRecordType(type: string): type is CardRecordType {
  return (CARD_RECORD_TYPES as readonly string[]).includes(type)
}

/** The `/` page a slug names, as its card (its gate is the caller's: the card itself checks it too). */
function pageCard(slug: string, now: Date): CardSpec | null {
  const page = CARD_PAGES.find((p) => p.slug === slug)
  if (!page) return null
  const spec = page.spec(now)
  return isCardSpec(spec) ? spec : null
}

const RECORD_NOUN: Record<CardRecordType, string> = {
  action: 'Action',
  capture: 'Capture',
  document: 'Doc',
  initiative: 'Initiative',
  project: 'Project',
  contact: 'Contact',
  company: 'Company',
}

/**
 * The card a thing opens, or null when it names nothing a card can draw (an
 * unknown type, a missing id). Records open as a record card; a place inside
 * a page (a sequence, a prospect list, a suite) as that page's card on it.
 */
export function cardForTarget(target: OpenTarget, now: Date = new Date()): TargetCard | null {
  if (target.type === 'page') {
    const spec = pageCard(target.slug, now)
    return spec ? { spec } : null
  }
  if (target.type === 'bot') {
    if (!target.teammateId) return null
    const name = label(target.name, 'Teammate')
    const item = target.item?.itemId ? target.item : null
    return {
      spec: { kind: 'bot', title: name, target: { type: 'bot', id: target.teammateId, label: name } },
      ...(item ? { seed: { at: { type: 'work_item', id: item.itemId, label: label(item.title, 'Work item') } } } : {}),
    }
  }
  if (target.type === 'guest') {
    if (!target.guestId) return null
    const name = label(target.name, 'Guest')
    return {
      spec: { kind: 'guest', title: name, target: { type: 'guest', id: target.guestId, label: name } },
      ...(target.messageId ? { seed: { at: { type: 'guest_message', id: target.messageId } } } : {}),
    }
  }
  if (target.type === 'agent_link') {
    if (!target.linkId) return null
    const name = label(target.name, 'Agents')
    return {
      spec: { kind: 'agent_link', title: name, target: { type: 'agent_link', id: target.linkId, label: name } },
      ...(target.exchangeId ? { seed: { at: { type: 'agent_link_exchange', id: target.exchangeId } } } : {}),
    }
  }
  if (target.type === 'team_chat') {
    // One team chat card: the one already in the chat comes back, moved to the place (sameCardPlace: no target).
    const at: PagePlace | null = target.messageId
      ? { type: 'team_chat_message', id: target.messageId }
      : target.channelId
        ? { type: 'team_chat_channel', id: target.channelId }
        : null
    return { spec: { kind: 'team_chat', title: 'Team chat' }, ...(at ? { seed: { at } } : {}) }
  }
  if (target.type === 'mail') {
    const folder: MailFolder = (MAIL_FOLDERS as readonly string[]).includes(target.folder ?? '') ? (target.folder as MailFolder) : 'inbox'
    const title = label(target.title, target.threadId ? 'Thread' : folder === 'inbox' ? 'Inbox' : folder[0].toUpperCase() + folder.slice(1))
    // A draft opens on its thread, in view (a draft with no thread opens its folder).
    const draft = target.threadId && target.draftId ? { draft_id: target.draftId } : {}
    return { spec: { kind: 'mail', title, mail: { folder, ...(target.threadId ? { thread_id: target.threadId } : {}), ...draft } } }
  }
  if (!target.id) return null
  if (isRecordType(target.type)) {
    const t = target as { type: CardRecordType; id: string; title?: string | null; section?: string | null }
    const section = t.type === 'action' && (t.section === 'cloud' || t.section === 'agents') ? t.section : null
    return {
      spec: { kind: 'record', title: label(t.title, RECORD_NOUN[t.type]), record: { type: t.type, id: t.id, ...(section ? { section } : {}) } },
    }
  }
  switch (target.type) {
    case 'calendar-event': {
      // Its day, with the event open; without a start, this week (the card
      // says so when the event isn't on it).
      const day = target.start && !Number.isNaN(Date.parse(target.start)) ? localIsoDate(new Date(target.start)) : null
      const view = day ? 'day' : 'week'
      const range = calendarRange(view, day ?? localIsoDate(now))
      return {
        spec: { kind: 'calendar', title: label(target.title, 'Event'), calendar: { ...range, view } },
        seed: { open: { type: 'event', id: target.id, label: label(target.title, 'Event') } },
      }
    }
    case 'flow':
      return {
        spec: { kind: 'flows', title: label(target.title, 'Flows') },
        seed: { editing: target.id, ...(target.runId ? { editingRun: target.runId } : {}) },
      }
    case 'sequence':
      return { spec: { kind: 'sequences', title: label(target.title, 'Sequence'), target: { type: 'sequence', id: target.id, label: label(target.title, 'Sequence') } } }
    case 'prospect_list':
      return {
        spec: { kind: 'prospecting', title: label(target.title, 'Prospect list'), target: { type: 'prospect_list', id: target.id, label: label(target.title, 'Prospect list') } },
      }
    case 'eval_suite':
      return { spec: { kind: 'evals', title: label(target.title, 'Eval suite'), target: { type: 'eval_suite', id: target.id, label: label(target.title, 'Eval suite') } } }
    case 'eval_case':
    case 'eval_run': {
      if (!target.suiteId) return null
      const suite: PagePlace = { type: 'eval_suite', id: target.suiteId, label: label(target.suiteName, 'Eval suite') }
      const fallback = target.type === 'eval_case' ? 'Case' : 'Run'
      return {
        spec: { kind: 'evals', title: label(target.title, fallback), target: suite },
        seed: { at: { type: target.type, id: target.id, label: label(target.title, fallback) }, trail: [suite] },
      }
    }
    case 'package':
      return { spec: { kind: 'knowledge', title: label(target.title, 'Knowledge'), target: { type: 'package', id: target.id, label: label(target.title, 'Package') } } }
    case 'agent':
    case 'skill':
      return {
        spec: {
          kind: 'library',
          title: label(target.title, target.type === 'agent' ? 'Agent' : 'Skill'),
          target: { type: target.type, id: target.id, label: label(target.title, target.type === 'agent' ? 'Agent' : 'Skill') },
          tab: target.type === 'agent' ? 'agents' : 'skills',
        },
      }
    case 'deal':
      if (!target.pipelineId) return null
      return {
        spec: { kind: 'pipelines', title: label(target.title, 'Deal'), target: { type: 'data_row', id: target.id, in: target.pipelineId, label: label(target.title, 'Deal') } },
      }
    case 'data_row':
      return {
        spec: {
          kind: 'tables',
          title: label(target.title, 'Row'),
          target: { type: 'data_row', id: target.id, label: label(target.title, 'Row'), ...(target.tableId ? { in: target.tableId } : {}) },
        },
      }
    case 'team':
      return { spec: { kind: 'teams', title: label(target.title, 'Team'), target: { type: 'team', id: target.id, label: label(target.title, 'Team') } } }
    case 'team_board':
      return { spec: { kind: 'team_board', title: label(target.title, 'Team board'), target: { type: 'team', id: target.id, label: label(target.title, 'Team') } } }
    case 'work_item':
      // Not a record: a work item with a teammate opens on its bot's page
      // (useOpenWorkItem); one with none lands on its own card.
      return {
        spec: { kind: 'work_item', title: label(target.title, 'Work item'), target: { type: 'work_item', id: target.id, label: label(target.title, 'Work item') } },
      }
  }
  return null
}

/** Ask the dashboard to open a card. False where there is no window (on the server). */
export function openCard(
  spec: CardSpec,
  opts: { from: string; seed?: OpenCardSeed; workspaceId?: string | null; reuse?: boolean },
): boolean {
  if (typeof window === 'undefined' || !isCardSpec(spec)) return false
  const detail: OpenCardRequest = {
    spec,
    from: opts.from,
    ...(opts.seed ? { seed: opts.seed } : {}),
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.reuse ? { reuse: true } : {}),
  }
  window.dispatchEvent(new CustomEvent(OPEN_CARD_EVENT, { detail }))
  return true
}

/** Open the card a thing opens. False when it names nothing a card can draw. */
export function openTarget(target: OpenTarget, opts: { from: string; workspaceId?: string | null; now?: Date; reuse?: boolean }): boolean {
  const card = cardForTarget(target, opts.now)
  if (!card) return false
  return openCard(card.spec, { from: opts.from, seed: card.seed, workspaceId: opts.workspaceId, reuse: opts.reuse })
}

/** An OPEN_CARD_EVENT's detail, checked (it is a window event: anything may send one). */
export function parseOpenCardRequest(detail: unknown): OpenCardRequest | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Partial<OpenCardRequest>
  if (!isCardSpec(d.spec)) return null
  const from = typeof d.from === 'string' && d.from ? d.from.slice(0, 40) : 'link'
  const workspaceId = typeof d.workspaceId === 'string' && d.workspaceId ? d.workspaceId : null
  const seed = d.seed && typeof d.seed === 'object' ? d.seed : undefined
  return {
    spec: d.spec,
    from,
    ...(seed ? { seed } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(d.reuse === true ? { reuse: true } : {}),
  }
}

/**
 * The boot deep link that opens a `/` page's card: `/account?page=<slug>`
 * (main-chat-context.tsx deepLinkCard). What a settings page that became a
 * page redirects to (Liam, 11-11: Availability, its own page under Calendar).
 */
export const PAGE_DEEP_LINK_PARAM = 'page'

export function pageDeepLink(slug: string): string {
  return `/account?${PAGE_DEEP_LINK_PARAM}=${encodeURIComponent(slug)}`
}
