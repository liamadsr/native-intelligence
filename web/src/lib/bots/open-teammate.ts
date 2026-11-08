/**
 * What a click on a bot does (bot-characters.md Step 3, items 6 and 11), and
 * where any work item opens (bots-v4.md "An item opens on its bot's page",
 * Phase 2). Every bot click goes through `openTeammate(teammateIds, intent)`,
 * and every work item, from anywhere, through `openItem` (useOpenWorkItem in
 * React), so what a bot can be asked, and where an item lands, grow here and
 * nowhere else.
 *
 * A bot stands for every teammate wearing its face, across workspaces (one bot
 * per face on screen), so it names a SET of teammates (`ai_team_member` ids).
 * `open` reads what is NEW for them off the shell's shared source
 * (AgentWorkProvider): their `beckoning` (countByOwner; rows waiting on you
 * that you haven't opened, and pending cards), each item once
 * (`beckoningFor`):
 *
 *   exactly one, a row   that item (goToItem, below).
 *   exactly one, a card  the item of the run that wrote it (its ledger row,
 *                        named by the card or matched on
 *                        `source_flow_run_id`), when the source holds that
 *                        row; its item lists the run's cards with their verbs.
 *                        A card with no such row (a work proposal whose run is
 *                        unknown, a fresh loop card) falls through to the page.
 *   none, or several     the bot's page (docs/plans/bots-v4.md Phase 1b), of
 *                        the teammate on screen first (`resolveTalk`'s pick,
 *                        so one with something new first): the nav's
 *                        `openPage`, lib/bots/bot-page.ts. Where its page
 *                        can't open (a teammate the roster doesn't hold:
 *                        deleted, or behind a private team; or no dashboard
 *                        to answer), nothing opens, and the nav says so
 *                        (`botNotFound`: "Couldn't find that agent").
 *
 * Where an item opens (goToItem), whoever asks:
 *
 *   with a teammate      on its bot's page, in item view (the nav's
 *                        `openItemPage`, lib/bots/bot-page.ts openBotPageItem):
 *                        the item on the work side, the conversation about it
 *                        (its run's chat) beside it, and Back to the bot's
 *                        lists, as a card in the chat on screen.
 *   with no teammate     its panel on a card of its own, in its own workspace:
 *   (or one whose page   switched to first when it is not the current one,
 *   can't open: deleted, as notice clicks and review cards always have.
 *   behind a private
 *   team)
 *
 * An item's teammate is its row's (`ai_team_member_id`); a card's, its run's
 * row's, else the bot that raised it. One the source doesn't hold comes from
 * the caller (`known`: a row it holds whole, a notice's bot), else is looked
 * up (the nav's `lookup`, lib/bots/item-lookup.ts) before it opens.
 *
 * Opening an item stamps it opened where it's drawn, visible and focused, and
 * only for its owner (migration 295: the item view's panel, or the panel on
 * its own card), so it stops being new and its bot stops calling for it.
 *
 * `talk` (bots-v2.md Phase 2, decisions 5 and 6) hands the nav's `talk` the
 * teammate to start on (`resolveTalk`); with the bubble gone, the shell opens
 * that teammate's page (use-open-teammate.ts). `page` is the bot's page
 * whatever is new.
 *
 * Pure but for the navigation it is handed (useOpenTeammate and
 * useOpenWorkItem wire the source and the tab actions), so every branch is
 * unit-tested here.
 */
import type { OpenTarget } from '@/lib/chat-cards/open-card'
import type { BotCharacterType } from '@/lib/bots/bot-faces'
import {
  beckoningFor,
  cardLookupRows,
  teammateKey,
  type OwnedCard,
  type OwnerCounts,
} from '@/lib/work/agent-work-lanes'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { kindLabel } from '@/lib/work/presentation'
import type { CardRunRow, LightWorkRow } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'
import { batchKeyOf, batchWorkItemId, isBatchKey } from './batch'
import type { ItemFacts } from './item-lookup'
import type { TeammateChatItem } from './teammate-chat-tab'
import { asBotCharacter } from './teammate-faces'

/**
 * What a bot asks of its teammates:
 *
 *   'talk'  a click on the bot: its bubble, held at the bot, on the teammate
 *           to start on (resolveTalk). The bubble says what's new, one item at
 *           a time, and is where you talk to the teammate (bots-v2.md Phase 1).
 *   'open'  what is new for them: the one item (on its bot's page), or the
 *           bot's page. A tap with no main window relaying the bubble, or
 *           that no chat covers (bots-v2.md Phase 8, desktop-open.ts).
 *   'page'  the bot's page, whatever is new (the bubble's "Open Triage's
 *           page"): of the teammate on screen first.
 */
export type TeammateIntent = 'open' | 'talk' | 'page'

/** A row the source holds: a full feed row, a light one, or a pending card's run. */
type HeldRow = WorkItem | LightWorkRow | CardRunRow

/** What openTeammate reads: the shared source's rows, cards and counts. */
export interface OpenTeammateSource {
  /** Every row held (AgentWork.rows). */
  rows: readonly HeldRow[]
  /** The rows pending cards point at outside `rows` (AgentWork.cardRows). */
  cardRows: readonly HeldRow[]
  /** The pending cards (the shell's attention hook). */
  cards: ReadonlyArray<OwnedCard & { title?: string | null; workspace_id?: string; run_key?: string | null }>
  /** countByOwner over all of it (the provider's `counts`). */
  counts: ReadonlyMap<string, OwnerCounts>
  /** The roster (AgentWork.roster): where each teammate works, and its face. `talk` reads it. */
  roster?: ReadonlyArray<Pick<RosterTeammate, 'id' | 'workspace_id' | 'bot_character'>>
}

/** Where it goes: the tab actions and the workspace on screen. */
export interface OpenTeammateNav {
  currentWorkspaceId: string | null
  /** Open a card for `target` in the chat on screen, after switching to `workspaceId` when it's another (lib/chat-cards/open-card.ts openTarget). */
  open: (target: OpenTarget, workspaceId: string | null) => void
  /** `talk`: the bot's bubble, on the teammate to start on (useOpenTeammate opens it). */
  talk?: (talk: TalkOutcome) => void
  /** A teammate's bot's page (lib/bots/bot-page.ts openBotPage); false where it can't open. */
  openPage?: (teammateId: string) => boolean
  /**
   * A teammate's bot's page on one of its items (lib/bots/bot-page.ts
   * openBotPageItem); false where it can't open (no dashboard to answer, a
   * teammate the roster doesn't hold: deleted, or behind a private team).
   */
  openItemPage?: (teammateId: string, item: TeammateChatItem) => boolean
  /** Who an item the source doesn't hold is (lib/bots/item-lookup.ts lookupWorkItem); null when it can't say. */
  lookup?: (itemId: string) => Promise<ItemFacts | null>
  /** Its bot's page couldn't open and there is nothing else to show: say so (useOpenTeammate: a toast). */
  botNotFound?: () => void
}

/**
 * Where one item is: its run's ledger row (`workItemId`), that row's own
 * workspace, how it was found (a row, or a card's run), and its teammate
 * (`ai_team_member_id`; null for none).
 */
export type ItemPlace = { kind: 'item'; workItemId: string; workspaceId: string; via: 'row' | 'card'; teammateId: string | null }

/** One item, opened: on its teammate's bot's page (`on: 'bot-page'`), or its panel on a card of its own (`on: 'card'`). */
export type ItemOutcome = ItemPlace & { on: 'bot-page' | 'card' }

/** An item nothing on screen could place, asked about first (the nav's `lookup`): `settled` is where it then went. */
export type LookingOutcome = { kind: 'looking'; workItemId: string; settled: Promise<OpenTeammateOutcome> }

/**
 * A bubble, held at `face` (the bot every one of `teammateIds` wears), starting
 * on `teammateId`; null ids or face when there's nobody, or no face, to hold it at.
 */
export type TalkOutcome = { kind: 'talk'; teammateIds: string[]; teammateId: string | null; face: BotCharacterType | null }

/** A teammate's bot's page. */
export type BotPageOutcome = { kind: 'bot-page'; teammateId: string }

/**
 * Nowhere to go: the bot's page can't open (a teammate the roster doesn't
 * hold: deleted, or behind a private team; or no dashboard to answer), and
 * there is no one item to show instead. The nav's `botNotFound` has said so.
 */
export type NoPageOutcome = { kind: 'no-page'; teammateIds: string[] }

/** What a click did, for its caller (and the tests). */
export type OpenTeammateOutcome = ItemOutcome | LookingOutcome | BotPageOutcome | NoPageOutcome | TalkOutcome

/** A card's own word on the bot that raised it (bots v3 1a), else null. */
function raisedBy(card: Pick<OwnedCard, 'payload'>): string | null {
  const id = card.payload?.raised_by_ai_member_id
  return typeof id === 'string' && id ? id : null
}

/**
 * Where one item of the source is: a row, itself; a card, the run that wrote
 * it: the run it names (`payload.work_item_id`, stamped when it was inserted:
 * bots v3 1a), else the one matched on `source_flow_run_id`, when the source
 * holds that run's row. A batch (`work:<id>` or `run:<run_key>:<flow_id>`,
 * bubble.ts batchKeyOf) is its run likewise. Its teammate is the row's; a
 * card's run not held, the bot that raised the card. Null when the source
 * can't place it (a card whose run it doesn't hold, an id it never had).
 */
export function resolveItem(itemId: string, source: OpenTeammateSource): ItemPlace | null {
  const row = source.rows.find((r) => r.id === itemId)
  if (row) return { kind: 'item', workItemId: row.id, workspaceId: row.workspace_id, via: 'row', teammateId: row.ai_team_member_id ?? null }
  const held = cardLookupRows(source.rows, source.cardRows)
  const card = isBatchKey(itemId)
    ? source.cards.find((c) => batchKeyOf(c) === itemId)
    : source.cards.find((c) => c.id === itemId)
  if (!card) return null
  const named = batchWorkItemId(itemId) ?? (typeof card.payload?.work_item_id === 'string' ? card.payload.work_item_id : null)
  if (named) {
    const run = held.find((r) => r.id === named)
    const workspaceId = run?.workspace_id ?? card.workspace_id
    if (workspaceId) {
      return { kind: 'item', workItemId: named, workspaceId, via: 'card', teammateId: run ? (run.ai_team_member_id ?? null) : raisedBy(card) }
    }
  }
  if (card.source_flow_run_id) {
    const run = held.find((r) => r.flow_run_id === card.source_flow_run_id)
    if (run) return { kind: 'item', workItemId: run.id, workspaceId: run.workspace_id, via: 'card', teammateId: run.ai_team_member_id ?? null }
  }
  return null
}

/** Where `open` lands for these teammates, read off the source: the one new item, else null (the bot's page). */
export function resolveOpenTeammate(teammateIds: readonly string[], source: OpenTeammateSource): ItemPlace | null {
  const ownerKeys = [...new Set(teammateIds)].map(teammateKey)
  const fresh = beckoningFor(source.counts, ownerKeys)
  return fresh.length === 1 ? resolveItem(fresh[0], source) : null
}

/**
 * Who a bot's bubble starts on, of the teammates wearing its face (decision 6):
 * one with something new for you, else the one in the workspace on screen,
 * else the first. Of several with something new, the one on screen first.
 */
export function resolveTalk(
  teammateIds: readonly string[],
  source: OpenTeammateSource,
  currentWorkspaceId: string | null,
): TalkOutcome {
  const ids = [...new Set(teammateIds)]
  const hasNew = (id: string) => (source.counts.get(teammateKey(id))?.beckoning.length ?? 0) > 0
  const here = (id: string) =>
    !!currentWorkspaceId && source.roster?.find((t) => t.id === id)?.workspace_id === currentWorkspaceId
  const teammateId = ids.find((id) => hasNew(id) && here(id)) ?? ids.find(hasNew) ?? ids.find(here) ?? ids[0] ?? null
  const face = teammateId ? asBotCharacter(source.roster?.find((t) => t.id === teammateId)?.bot_character) : null
  return { kind: 'talk', teammateIds: ids, teammateId, face }
}

/**
 * The item's name (its label on its bot's page, or the panel's breadcrumb):
 * its title when the source holds the full row; else a card's title; else
 * what the caller knows (`fallback`: a notice's title, a row it holds whole);
 * else its kind.
 */
function titleFor(place: ItemPlace, source: OpenTeammateSource, fallback?: string | null): string {
  const row = cardLookupRows(source.rows, source.cardRows).find((r) => r.id === place.workItemId)
  const title = row && 'title' in row ? row.title : null
  if (title) return title
  const card = place.via === 'card' ? source.cards.find((c) => c.source_flow_run_id === row?.flow_run_id) : null
  return card?.title || fallback || (row ? kindLabel(row.kind) : 'Work item')
}

/** An item's panel on its own card (its home for an item no bot's page holds). */
export function itemCardTarget(workItemId: string, title: string): OpenTarget {
  return { type: 'work_item', id: workItemId, title }
}

/**
 * Opens one item (see the rules above): on its teammate's bot's page when it
 * has a teammate whose page can open; else its panel on a card of its own, in
 * its own workspace (switched to when it isn't the one on screen, else in place).
 * `title` is the caller's name for it, over the source's.
 */
function goToItem(place: ItemPlace, source: OpenTeammateSource, nav: OpenTeammateNav, title?: string | null, fallback?: string | null): ItemOutcome {
  const name = title || titleFor(place, source, fallback)
  if (place.teammateId && nav.openItemPage?.(place.teammateId, { itemId: place.workItemId, title: name })) return { ...place, on: 'bot-page' }
  const foreign = nav.currentWorkspaceId && place.workspaceId && place.workspaceId !== nav.currentWorkspaceId ? place.workspaceId : null
  nav.open(itemCardTarget(place.workItemId, name), foreign)
  return { ...place, on: 'card' }
}

/**
 * The bot's page, of the teammate on screen first (resolveTalk's pick: one
 * with something new, else the one in the workspace on screen, else the
 * first). Where it can't open, nothing does (the caller says so, or opens
 * something else).
 */
function goToBotPage(teammateIds: readonly string[], source: OpenTeammateSource, nav: OpenTeammateNav): BotPageOutcome | NoPageOutcome {
  const { teammateId } = resolveTalk(teammateIds, source, nav.currentWorkspaceId)
  if (teammateId && nav.openPage?.(teammateId)) return { kind: 'bot-page', teammateId }
  return { kind: 'no-page', teammateIds: [...new Set(teammateIds)] }
}

/**
 * A click on a bot standing for `teammateIds`. Returns where it went.
 */
export function openTeammate(
  teammateIds: readonly string[],
  intent: TeammateIntent,
  source: OpenTeammateSource,
  nav: OpenTeammateNav,
): OpenTeammateOutcome {
  switch (intent) {
    case 'open': {
      const place = resolveOpenTeammate(teammateIds, source)
      return place ? goToItem(place, source, nav) : botPageOrSay(teammateIds, source, nav)
    }
    case 'talk': {
      const outcome = resolveTalk(teammateIds, source, nav.currentWorkspaceId)
      if (outcome.teammateId) nav.talk?.(outcome)
      return outcome
    }
    case 'page':
      return botPageOrSay(teammateIds, source, nav)
  }
}

/** The bot's page; where it can't open, the nav says it couldn't find the bot. */
function botPageOrSay(teammateIds: readonly string[], source: OpenTeammateSource, nav: OpenTeammateNav): BotPageOutcome | NoPageOutcome {
  const page = goToBotPage(teammateIds, source, nav)
  if (page.kind === 'no-page') nav.botNotFound?.()
  return page
}

/**
 * What the caller knows of an item the shared source may not hold (it holds
 * open rows only): the bubble's "Last finished", a settled row a record's
 * "Agent activity" lists, a handoff the panel names, a notice's bot.
 *
 *   workspaceId  its own workspace; absent when the caller doesn't know it.
 *   title        its name, for its label.
 *   teammateId   its teammate: null for none; absent when the caller doesn't
 *                know (then it's looked up).
 */
export interface KnownRow {
  workspaceId?: string | null
  title?: string | null
  teammateId?: string | null
}

/**
 * One work item, opened from anywhere (the bubble's Open, Answer and "Last
 * finished"; a bot page's row; a teammate's report in chat; a record's "Agent
 * activity"; the panel's handoff links; a notice; Open in Native Intelligence): where the
 * rules above put it. The source places what it holds, by its word; otherwise
 * `known` does, when it knows the workspace and the teammate; otherwise the
 * nav's `lookup` says (`kind: 'looking'`, then it opens), for an id that could
 * be a work item's. What nothing can place opens where `known` says (on a
 * card of its own, in its workspace), else on the bot's page of `teammateIds`, else
 * on a card of its own here; a card (no work item to show) whose bot's page can't
 * open opens nothing, and the nav says it couldn't find the bot.
 */
export function openItem(
  itemId: string,
  teammateIds: readonly string[],
  source: OpenTeammateSource,
  nav: OpenTeammateNav,
  known?: KnownRow | null,
): OpenTeammateOutcome {
  const placed = resolveItem(itemId, source)
  if (placed) return goToItem(placed, source, nav, null, known?.title)
  const title = known?.title ?? null
  // A card (or a run's cards) is no work item: nothing to ask about, nor a panel to show.
  const isCard = isBatchKey(itemId) || source.cards.some((c) => c.id === itemId)
  if (known?.workspaceId && known.teammateId !== undefined) {
    return goToItem({ kind: 'item', workItemId: itemId, workspaceId: known.workspaceId, via: 'row', teammateId: known.teammateId }, source, nav, title)
  }
  const unplaced = (): OpenTeammateOutcome => {
    if (known?.workspaceId) {
      return goToItem({ kind: 'item', workItemId: itemId, workspaceId: known.workspaceId, via: 'row', teammateId: known.teammateId ?? null }, source, nav, title)
    }
    if (teammateIds.length > 0) {
      const page = isCard ? botPageOrSay(teammateIds, source, nav) : goToBotPage(teammateIds, source, nav)
      if (page.kind === 'bot-page' || isCard) return page
    }
    return goToItem({ kind: 'item', workItemId: itemId, workspaceId: nav.currentWorkspaceId ?? '', via: 'row', teammateId: null }, source, nav, title)
  }
  if (!nav.lookup || isCard) return unplaced()
  // What the caller knows of its teammate (none, or which) stands over the read's.
  const teammateOf = (facts: ItemFacts) => (known && known.teammateId !== undefined ? known.teammateId : facts.teammateId)
  const settled = nav.lookup(itemId).then(
    (facts): OpenTeammateOutcome =>
      facts
        ? goToItem(
            { kind: 'item', workItemId: facts.workItemId, workspaceId: facts.workspaceId, via: 'row', teammateId: teammateOf(facts) },
            source,
            nav,
            title || facts.title,
          )
        : unplaced(),
    () => unplaced(),
  )
  return { kind: 'looking', workItemId: itemId, settled }
}
