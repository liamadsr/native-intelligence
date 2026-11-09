/**
 * What the main agent reads of the bots' work (docs/plans/bots-v4.md, "The
 * main agent talks to the bots", Phase A1): the reads behind the main chat's
 * `list_bot_work` and `get_bot_item` (src/lib/ai/tools/bot-work.ts).
 *
 *   readBotWork    every bot the caller can reach, across every workspace
 *                  they're in. First what's pending, bot by bot: the shared
 *                  source's own read (the open rows,
 *                  the pending cards and the rows those cards point at:
 *                  listOpenWorkInWorkspaces, listPendingCards,
 *                  listPendingCardRows), grouped per bot with bubbleItems (new)
 *                  and seenItems (seen) over countByOwner's counts, exactly as
 *                  the bots group it (AgentWorkProvider, the bubble, the bot's
 *                  page). So a bot's numbers here are its own: `waiting` is
 *                  the app's "N waiting" (needsYou), `new` its dot
 *                  (beckoning), `running` its "N running". Capped per bot
 *                  ("and N more"), each item one templated line. Then every
 *                  other bot (nothing waiting, nothing running), compactly
 *                  and capped (`idle_bots`, "and N more"), so "which bots do
 *                  I have?" has an answer.
 *   readBotDetail  one bot: its items as its page's For you lists them (its
 *                  own rows from listTeammateWork, then the shared source's),
 *                  plus what it's working on and what it finished lately.
 *   readBotItem    one item in full: a draft's text, a document's, a question
 *                  with its options, a card's proposal (the narration reads,
 *                  narration-server.ts), or a run's cards one by one; a
 *                  review's drafts by id, for revise_email_draft.
 *   findOwnItem    the fence readBotItem reads an item through, and the main
 *                  agent's writes act through (Phase A2, bot-work-acts.ts).
 *
 * Mail drafts (GEN-1165). The open drafts a drafting pass wrote (the ones For
 * you lists one card each: agent-drafts-server.ts) are review items too,
 * under the bot For you puts them under (the workspace's Correspondent the
 * caller can reach, else its Assistant, `area` mail), each `draft:<row id>`,
 * counted in that bot's `waiting` and `new`. get_bot_item reads one in full;
 * settle_work_item's dismiss and discard_email_draft discard it.
 *
 * Who it reads for. The tool routes run these on a SERVICE client, so nothing
 * here leans on RLS: every read is fenced explicitly on the caller's own
 * member rows (resolveMemberIdsForUser: `member.user_id = caller`), as
 * settle_card fences on its member row. Rows and cards are the caller's own
 * (`member_id` in theirs), teammates are read in their workspaces only, and
 * the narration reads fence each row's workspace and the user (see
 * narration-server.ts).
 *
 * Which bots. Only the ones the caller may talk to: a teammate behind a
 * private team they aren't on (callerReachableTeammateIds, the rule the
 * chat's mint refuses by) is left out of every list and
 * count, and its detail is refused as not found. Work with no bot the caller
 * can reach (no teammate, a card with no raiser or a gone one, a private
 * team's bot's) is its workspace's Assistant's, the owner rule the bots read
 * by (lib/work/bot-owner.ts), with facts read for exactly the teammates the
 * work names (loadBotOwners, never a capped list): it is listed, counted and
 * read under the Assistant, like any of its own. A row of a private team's
 * bot is marked a fallback (findOwnItem's `fallback`): its run's chat is never
 * continued for it (bot-relay.ts), the Assistant's own thread takes the
 * message instead. Sequence sends
 * keep no bot: the overview names them by lane and count only
 * (`without_bot`), as it does any work in a workspace with no Assistant
 * known; a pending card no bot owns there (cardOwnerKeys empty, so
 * countByOwner counts it for no one) is listed apart (`unowned_cards`), and
 * get_bot_item reads it with no bot.
 *
 * Each bot's state, as the app shows it (its page, teammate-state.ts; the
 * crew's crew-state.ts): working while it runs something; else asleep while it
 * rests (teammate-state.ts teammateRest: switched off, its attempts paused by
 * its role's breaker, or stopped by the AI usage limit), saying why in the
 * agent's page's words (TEAMMATE_REST_WORDS); else awake. Who is listed is
 * every teammate of the caller's workspaces they can reach, read whole and
 * paged (readReachableBots: never a capped list, so a private team's
 * teammates can't crowd a reachable bot out). The state's facts are the
 * app's: roster entries (agent-roster.ts loadAgentRoster, with their roles'
 * breakers) for at most STATE_READ_MAX (150) of those bots, the busy ones
 * first, and the ledger's AI limit (queries.ts listAiLimitedTeammates,
 * crew-state.ts aiLimitedTeammates). A bot whose facts weren't read has no
 * state (unknown, never guessed) and the answer says so (`states_unread`).
 * And what it does, in one line: its page's About (teammate-blurb.ts). A
 * name finds any bot (readBotsByName), past every cap.
 *
 * Names people set (a bot's, a workspace's) come plain (teammate-report.ts
 * plainName): one line, no angle brackets, so they can't close a fence or
 * open a tag.
 *
 * One face (docs/plans/always-on-agent.md §2c, decision 11): the area faces
 * (Captures, Mail, Prospecting, Evals, CRM; migration 318) are attribution
 * only, so they are never listed: their work is the agent's own, listed under
 * the workspace's Assistant (the owner rule, bot-owner.ts), which is marked
 * `self` (it is the main agent reading this), its lines in the first person
 * ("I drafted…"), each with the area it came from (`area`). A bot_id that
 * names an area face reads as its workspace's Assistant.
 *
 * No model is called: every line is a template (narration.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { listPendingCards } from '@/lib/attention/pending-cards'
import { isChatAskCard } from '@/lib/attention/chat-asks'
import { callerReachableTeammateIds } from '@/lib/chat/teammate-access'
import { loadAgentRoster, type RosterTeammate } from '@/lib/work/agent-roster'
import { cardLookupRows, cardOwnerKeys, countByOwner, laneLabel, teammateKey, type OwnerCounts } from '@/lib/work/agent-work-lanes'
import { ASSISTANT_SYSTEM_KEY, KINDS_WITHOUT_BOT, ROSTER_LIMIT, assistantTakes, faceAreaOf, namedTeammateIds, rowOwnerId, withBotOwners, withCardOwner, withCardOwners, type BotOwners } from '@/lib/work/bot-owner'
import { loadBotOwners, otherReachableTeammates } from '@/lib/work/bot-owner-server'
import { settledAt } from '@/lib/work/presentation'
import {
  WORK_FEED_WINDOW_DAYS,
  WORK_ITEM_SELECT,
  listAiLimitedTeammates,
  listOpenWorkInWorkspaces,
  listPendingCardRows,
  listTeammateWork,
  type CardRunRow,
  type LightWorkRow,
} from '@/lib/work/queries'
import { WORK_TERMINAL_STATUSES, isWorkLive, workNeedsYou, type WorkItem } from '@/lib/work/types'
import { teammateBlurb } from '@/lib/work/teammate-blurb'
import { planReading, readWithPlanFallback, type PlanReading } from '@/lib/work/plan'
import { resolveMemberIdsForUser } from '@/lib/workspace'
import { batchKeyOf, isBatchKey } from './batch'
import { bubbleItems, seenItems, type BubbleItem, type BubbleRow } from './bubble-items'
import { aiLimitedTeammates, type AiLimited } from './crew-state'
import { cardReading, narrateItem } from './narration'
import { narrateCardById, narrateWorkItemById, type NarrationAuth } from './narration-server'
import { asBotCharacter } from './teammate-faces'
import { AGENT_FACE } from './agent-face'
import { TEAMMATE_REST_WORDS, teammateBotState, teammateRest } from './teammate-state'
import { plainName } from '@/lib/chat/teammate-report'
import { areaFaceKey } from '@/lib/work/work-area'
import { isAreaKey, type AreaKey } from '@/lib/packs/registry'
import { AGENT_DRAFT_ITEM_PREFIX, agentDraftSentence, type AgentDraft } from '@/lib/email/agent-drafts'
import { readAgentDraftsIn } from '@/lib/email/agent-drafts-server'
import { draftReading } from './narration'

// ── Caps ─────────────────────────────────────────────────────────────────────

/** Items listed per bot in the overview (and cards no bot owns); the rest are counted ("and 12 more"). */
export const BOT_WORK_ITEMS_MAX = 5
/** Bots listed in the overview; the rest are counted. */
export const BOT_WORK_BOTS_MAX = 15
/** Bots with nothing waiting or running listed in the overview (after the busy ones); the rest are counted. */
export const BOT_WORK_IDLE_MAX = 40
/** Bots a name lookup lists. */
export const BOT_NAME_MATCHES_MAX = 20
/** Ids per `in` list (keeps each request's URL short). */
const IDS_CHUNK = 150
/**
 * Bots whose state one answer reads: loadAgentRoster sends its ids in one
 * `in` list, so this stays within IDS_CHUNK (and below the roster's own cap).
 */
const STATE_READ_MAX = Math.min(IDS_CHUNK, ROSTER_LIMIT)
/** Rows per page of a whole read (PostgREST's own row cap). */
const PAGE = 1000

/** Items one bot's detail lists (For you). */
export const BOT_DETAIL_ITEMS_MAX = 20
/** What one bot's detail lists as working on. */
export const BOT_DETAIL_WORKING_MAX = 10
/** What one bot's detail lists as done lately. */
export const BOT_DETAIL_DONE_MAX = 5
/** A card's text in a run's cards, at most this many characters each. */
const BATCH_CARD_TEXT_MAX = 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A teammate's owner key (agent-work-lanes.ts teammateKey); every other key is a lane's. */
const TEAMMATE_KEY_PREFIX = teammateKey('')
const LANE_KEY_PREFIX = 'lane:'
const TERMINAL = new Set<string>(WORK_TERMINAL_STATUSES)

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Who reads: the caller, on the tool route's client (a service client: see the header). */
export interface BotWorkCaller {
  supabase: SupabaseClient
  userId: string
  now?: Date
  /**
   * Who reads the answer: the main agent itself (`agent`, the default: its
   * own face's lines in the first person, "I drafted…"), or someone acting
   * for the person over MCP (`person`: those lines name it, "Your agent
   * drafted…"). Any other bot's lines name that bot either way.
   */
  voice?: BotWorkVoice
}

/** Who reads list_bot_work and get_bot_item (BotWorkCaller.voice). */
export type BotWorkVoice = 'agent' | 'person'

/** How the agent's own face is named to someone acting for the person (voice `person`). */
export const PERSON_AGENT_SPEAKER = 'Your agent'

export type BotWorkResult<T> = { ok: true; value: T } | { ok: false; code: 'NOT_FOUND' | 'INPUT_INVALID' | 'READ_FAILED'; error: string }

/** What an item is. */
export type BotItemType = 'review' | 'question' | 'card' | 'cards' | 'update'

/** One thing a bot has waiting on you, as one line. */
export interface BotWorkLine {
  /** What get_bot_item takes: a row's id, a card's id, a run's cards (`work:<id>`, `run:<key>:<loop>`), or a Mail draft (`draft:<id>`). */
  id: string
  type: BotItemType
  /** `new`: it calls for you (the bot's dot). `seen`: you've opened it since it started waiting. */
  status: 'new' | 'seen'
  line: string
  /** Your own item's area (one face: Captures, Mail, …), on a `self` bot's lines; absent for none. */
  area?: AreaKey
  /** A run's cards: how many. */
  cards?: number
}

/** A bot as a list names it. */
export interface BotRef {
  bot_id: string
  name: string
  workspace_id: string
  /** Its workspace's name, when the caller is in more than one. */
  workspace?: string
  /** The character it wears; null for none. */
  face: string | null
  /**
   * This is you: the workspace's Assistant, the main agent's own face (one
   * face). What it holds is your own work (your area work included), so say
   * it in the first person ("I drafted a reply to Dana"), never as another
   * bot's. Absent for every other bot (custom agents, role teammates, loop
   * bots), which you name.
   */
  self?: true
}

/**
 * A bot's state as the app shows it: `working` (it runs something), `asleep`
 * (it rests: switched off, attempts paused, stopped by the AI limit), or
 * `awake` (neither).
 */
export type BotState = 'working' | 'asleep' | 'awake'

/** What the app says of a bot beyond its counts: its state, why it rests, and what it does. */
export interface BotStatus {
  /**
   * Absent when its state couldn't be read (the roster read failed, or it is
   * past the STATE_READ_MAX bots whose state one answer reads): unknown, never
   * a guess. A bot running something is `working` all the same.
   */
  state?: BotState
  /**
   * Why it rests, in the agent's page's words: "Switched off", "Attempts
   * paused" or "Stopped by the AI limit". Absent while it doesn't. With
   * `working`, it sleeps once what runs settles.
   */
  asleep_because?: string
  /** What it does, in one line (its page's About: teammate-blurb.ts). Absent when its state couldn't be read. */
  about?: string
}

/** One bot's waiting work: its own counts, and its items, new then seen. */
export interface BotWorkSummary extends BotRef, BotStatus {
  /** What waits on you: its waiting rows and its cards (the app's "N waiting"). */
  waiting: number
  /** How much of it is new (its dot). */
  new: number
  /** How much of it you've seen. */
  seen: number
  /** What it's running now. */
  running: number
  items: BotWorkLine[]
  /** Items past the cap. */
  more: number
}

/** A bot with nothing waiting on you and nothing running (both 0), as the overview lists it: compactly. */
export interface IdleBot extends BotRef, BotStatus {
  state?: Exclude<BotState, 'working'>
}

/** A bot a name lookup matched: who it is, its state, what it does, and its counts. */
export interface BotMatch extends BotRef, BotStatus {
  waiting: number
  running: number
}

/** A name lookup (list_bot_work `name`): one bot's detail, or the bots it matched. */
export type BotNameLookup =
  | { bot: BotWorkDetail }
  | {
      /** The bots it matched (exact names first, when there are any), at most BOT_NAME_MATCHES_MAX. */
      matches: BotMatch[]
      /** Matches past the cap. */
      more: number
      /** Some state couldn't be read (see BotStatus.state). */
      states_unread?: true
    }

export interface BotWorkOverview {
  /** The bots with something waiting or running, most new first. */
  bots: BotWorkSummary[]
  /** Bots with something, past BOT_WORK_BOTS_MAX. */
  more_bots: number
  /**
   * Every other bot the caller can reach (nothing waiting, nothing running):
   * asleep ones first, then awake, then those whose state couldn't be read,
   * each by name; at most BOT_WORK_IDLE_MAX.
   */
  idle_bots: IdleBot[]
  /** Idle bots past BOT_WORK_IDLE_MAX (list_bot_work's `name` finds any of them). */
  more_idle_bots: number
  /**
   * Some bots' state couldn't be read (the roster read failed, or the caller
   * has more than STATE_READ_MAX bots): those come with no `state`. Every bot
   * is still listed or counted.
   */
  states_unread?: true
  /** Work waiting on you that no bot speaks for, by lane: sequence sends (and any work in a workspace with no Assistant). */
  without_bot: Array<{ lane: string; waiting: number }>
  /**
   * Pending cards no bot owns: only in a workspace with no Assistant known
   * (elsewhere they're the Assistant's). How many, the first few as lines
   * (each readable with get_bot_item), and how many more.
   */
  unowned_cards: { waiting: number; items: BotWorkLine[]; more: number }
  /**
   * What asks the person in the chat, never For you (P13): approvals,
   * suggestions, work to start, questions, each a card inline in the chat
   * (right after the message that raised it, or in their home thread). Only
   * the person's own click on the card answers an approval; the rest you may
   * settle with settle_card when they ask you to.
   */
  asks_in_chat: { waiting: number; items: AskInChatLine[]; more: number; note: string }
}

/** One ask waiting in the chat: its card, what kind of ask, its title (the run's words: data). */
export interface AskInChatLine {
  card_id: string
  kind: 'approval' | 'question' | 'suggestion' | 'work_to_start' | 'email_to_draft'
  title: string
}

/** What list_bot_work says beside the asks. */
export const ASKS_IN_CHAT_NOTE =
  'These wait as cards in the chat, never in For you. Only the person’s own click on an approval’s card answers it; never say you approved one. Point them to the card in the chat.'

/** An ask's line (P13): its kind in Native Intelligence's words, its title clipped. */
export function askInChatLine(card: Pick<AttentionItem, 'id' | 'kind' | 'title'>): AskInChatLine {
  const kind: AskInChatLine['kind'] =
    card.kind === 'approval' ? 'approval' : card.kind === 'question' ? 'question' : card.kind === 'work_proposal' ? 'work_to_start' : card.kind === 'draft_email' ? 'email_to_draft' : 'suggestion'
  const title = card.title.replace(/\s+/g, ' ').trim()
  return { card_id: card.id, kind, title: title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title }
}

/** A run of a bot's, as one line (working on, done lately). */
export interface BotRunLine {
  id: string
  status: string
  line: string
  /** The agent's plan for it (tracked_job.plan, A4): how many steps are finished of how many, and the step it's on. */
  plan?: PlanReading
}

export interface BotWorkDetail extends BotWorkSummary {
  working_on: BotRunLine[]
  /** What it finished in the last `window_days` (by when it started), newest first; else its last finished run. */
  done_lately: BotRunLine[]
  window_days: number
}

/** One item read in full. */
export interface BotItemReading {
  id: string
  type: BotItemType
  /** The bot it's from (`self`: your own, one face); null for work no bot speaks for. */
  bot: Pick<BotRef, 'bot_id' | 'name' | 'self'> | null
  /** The area the work belongs to (`tracked_job.area`, migration 318), for a row that records one. */
  area?: AreaKey
  line: string
  /** A row's status, or a card's (`pending` while it waits). */
  status: string
  /** What the reading is: an email draft, a document, or other text (a question, a result, a card's proposal). */
  read_kind?: string
  /** The document's title, the draft's subject. */
  title?: string
  /** The full text, paragraphs split by blank lines (a long one is cut, and says so). Absent: nothing to read. */
  text?: string
  /** A run's cards, one by one. */
  cards?: Array<{ card_id: string; kind: string; line: string; text?: string }>
  /** A review's drafts still waiting (email_draft deliverables): the ids revise_email_draft takes. */
  draft_ids?: string[]
  /** A row's plan (tracked_job.plan, A4): the counts, the step it's on, and every step. */
  plan?: PlanReading
}

// ── The shared source's read, fenced ─────────────────────────────────────────

interface Membership {
  memberId: string
  workspaceId: string
}

/** What the bots read (AgentWorkProvider's light answer and its cards), for this caller. */
interface BotSource {
  memberships: Membership[]
  memberIds: string[]
  workspaceIds: string[]
  /** The owner rule's facts for this caller (bot-owner.ts): the rows and cards below are named with them. */
  owners: BotOwners
  rows: LightWorkRow[]
  cards: AttentionItem[]
  /** The chat's cards (P13): read on their own, never counted for a bot. */
  asks: AttentionItem[]
  cardRows: CardRunRow[]
  counts: Map<string, OwnerCounts>
}

class ReadFailed extends Error {}

async function readMemberships(supabase: SupabaseClient, userId: string): Promise<Membership[]> {
  try {
    return await resolveMemberIdsForUser(supabase, userId)
  } catch (err) {
    throw new ReadFailed(`memberships: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The caller's open rows, pending cards and the rows those cards point at, in
 * every workspace they're in, named with their owner (the owner rule:
 * bot-owner.ts), and countByOwner over them as the shared source counts
 * (agent-work-provider.tsx): the same reads the bots load, fenced on the
 * caller's member rows.
 */
async function readSource(supabase: SupabaseClient, userId: string, now: Date, known?: Membership[]): Promise<BotSource> {
  const memberships = known ?? (await readMemberships(supabase, userId))
  const memberIds = [...new Set(memberships.map((m) => m.memberId))]
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]
  const nowIso = now.toISOString()
  const [open, pending, asks, rawCardRows] = await Promise.all([
    listOpenWorkInWorkspaces(supabase, { workspaceIds, memberIds }),
    listPendingCards(supabase, { nowIso, memberIds, place: 'for_you' }),
    listPendingCards(supabase, { nowIso, memberIds, place: 'asks' }),
    listPendingCardRows(supabase, { workspaceIds, nowIso, memberIds }),
  ])
  if (open.error) throw new ReadFailed(`open rows: ${open.error}`)
  if (pending.error) throw new ReadFailed(`cards: ${pending.error}`)
  // The owner facts for exactly the teammates this work names (never a capped list).
  const owners = await loadBotOwners(supabase, {
    userId,
    workspaceIds,
    teammateIds: namedTeammateIds([...open.items, ...rawCardRows], pending.cards),
  })
  const rows = withBotOwners(open.items, owners)
  const cardRows = withBotOwners(rawCardRows, owners)
  // For you's cards, as the shared source holds them (P13): the chat's asks are never counted for a bot.
  const cards = withCardOwners(pending.cards, owners)
  const counts = countByOwner(rows, cards, cardLookupRows(rows, cardRows))
  // A failed read of the asks leaves them out (the chat still shows them), never the overview.
  return { memberships, memberIds, workspaceIds, owners, rows, cards, asks: asks.error ? [] : asks.cards, cardRows, counts }
}

type TeammateRow = {
  id: string
  workspace_id: string
  team_id: string | null
  name: string | null
  is_system: boolean | null
  system_key?: string | null
  bot_character: unknown
}
const TEAMMATE_SELECT = 'id, workspace_id, team_id, name, is_system, system_key, bot_character'

/**
 * The teammates the caller may talk to (the private-team rule,
 * callerReachableTeammateIds), in their workspaces: those among `ids`, or
 * every one (`'all'`, paged: never a capped list, so no bot is dropped for
 * the ones the caller can't reach). Names come plain (plainName): a bot's and
 * a workspace's names are set by people, so they carry no angle brackets and
 * stay on one line. A failed read, or a failed reach read, throws: nothing is
 * guessed.
 */
async function readReachableBots(
  supabase: SupabaseClient,
  userId: string,
  ids: readonly string[] | 'all',
  workspaceIds: readonly string[],
): Promise<Map<string, BotRef>> {
  const out = new Map<string, BotRef>()
  if (ids.length === 0 || workspaceIds.length === 0) return out
  const rows: TeammateRow[] = []
  if (ids === 'all') {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('ai_team_member')
        .select(TEAMMATE_SELECT)
        .in('workspace_id', [...workspaceIds])
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new ReadFailed(`teammates: ${error.message}`)
      rows.push(...((data ?? []) as TeammateRow[]))
      if ((data ?? []).length < PAGE) break
    }
  } else {
    const wanted = [...new Set(ids)]
    for (let i = 0; i < wanted.length; i += IDS_CHUNK) {
      const { data, error } = await supabase
        .from('ai_team_member')
        .select(TEAMMATE_SELECT)
        .in('id', wanted.slice(i, i + IDS_CHUNK))
        .in('workspace_id', [...workspaceIds])
      if (error) throw new ReadFailed(`teammates: ${error.message}`)
      rows.push(...((data ?? []) as TeammateRow[]))
    }
  }
  let reachable: Set<string>
  try {
    reachable = await callerReachableTeammateIds(supabase, {
      userId,
      teammates: rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, isSystem: r.is_system === true, teamId: r.team_id ?? null })),
    })
  } catch (err) {
    throw new ReadFailed(`reach: ${err instanceof Error ? err.message : String(err)}`)
  }
  // One face: an area face is attribution only, never a bot of its own, while
  // its workspace's Assistant holds its work (with none known, it keeps it).
  const agentIn = new Set(rows.filter((r) => r.is_system === true && r.system_key === ASSISTANT_SYSTEM_KEY).map((r) => r.workspace_id))
  for (const r of rows) {
    if (!reachable.has(r.id)) continue
    if (r.is_system && areaFaceKey(r.system_key) && agentIn.has(r.workspace_id)) continue
    const self = r.is_system === true && r.system_key === ASSISTANT_SYSTEM_KEY
    const worn = asBotCharacter(r.bot_character)
    out.set(r.id, {
      bot_id: r.id,
      name: plainName(r.name?.trim() || '') || (self ? 'Assistant' : 'Teammate'),
      workspace_id: r.workspace_id,
      // The agent wears its one look whatever the row says (one face).
      face: self ? AGENT_FACE : worn,
      ...(self ? { self: true as const } : {}),
    })
  }
  return out
}

/**
 * The bot a bot_id reads as: an area face's is its workspace's Assistant (one
 * face), anything else itself. Fenced on the caller's workspaces; a failed
 * read throws (nothing is guessed).
 */
async function agentBotIdFor(supabase: SupabaseClient, botId: string, workspaceIds: readonly string[]): Promise<string> {
  if (workspaceIds.length === 0) return botId
  const { data, error } = await supabase
    .from('ai_team_member')
    .select('id, workspace_id, is_system, system_key')
    .eq('id', botId)
    .in('workspace_id', [...workspaceIds])
    .maybeSingle()
  if (error) throw new ReadFailed(`bot: ${error.message}`)
  const mate = data as { id: string; workspace_id: string; is_system: boolean | null; system_key: string | null } | null
  if (!mate || mate.is_system !== true || !areaFaceKey(mate.system_key)) return botId
  const { data: assistant, error: assistantError } = await supabase
    .from('ai_team_member')
    .select('id')
    .eq('workspace_id', mate.workspace_id)
    .eq('system_key', ASSISTANT_SYSTEM_KEY)
    .maybeSingle()
  if (assistantError) throw new ReadFailed(`assistant: ${assistantError.message}`)
  return (assistant as { id: string } | null)?.id ?? botId
}

/** Workspace names, when the caller is in more than one (fail-soft: none). */
async function readWorkspaceNames(supabase: SupabaseClient, workspaceIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (workspaceIds.length < 2) return out
  try {
    const { data, error } = await supabase.from('workspace').select('id, name').in('id', [...workspaceIds])
    if (error) throw new Error(error.message)
    for (const w of (data ?? []) as Array<{ id: string; name: string | null }>) {
      const name = plainName(w.name ?? '')
      if (name) out.set(w.id, name)
    }
  } catch (err) {
    console.warn('[bot-work] workspace names read failed:', err instanceof Error ? err.message : err)
  }
  return out
}

/** Whole rows (titles, deliverables, questions) for the lines, the caller's own (fail-soft: the light rows say less). */
async function readWholeRows(supabase: SupabaseClient, ids: readonly string[], memberIds: readonly string[]): Promise<Map<string, WorkItem>> {
  const out = new Map<string, WorkItem>()
  if (ids.length === 0 || memberIds.length === 0) return out
  try {
    const { data, error } = await supabase
      .from('tracked_job')
      .select(WORK_ITEM_SELECT)
      .in('id', [...new Set(ids)])
      .in('member_id', [...memberIds])
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as WorkItem[]) out.set(r.id, r)
  } catch (err) {
    console.warn('[bot-work] whole rows read failed:', err instanceof Error ? err.message : err)
  }
  return out
}

// ── State: what the app says of each bot ─────────────────────────────────────

/** The facts for a bot's state (see the header). */
interface BotFacts {
  /** Roster entries by teammate id (the roster read: breakers, what each fronts). */
  roster: Map<string, RosterTeammate>
  /** Who the AI usage limit has stopped (crew-state.ts aiLimitedTeammates over the ledger's answer). */
  aiLimited: AiLimited
  /** The roster was read (a failed read is logged: every state is then unknown). */
  read: boolean
}

/**
 * The facts for exactly `teammateIds` (at most STATE_READ_MAX:
 * the caller chooses which, so the roster's own cap never drops a bot
 * silently): their roster entries with their roles' breakers
 * (agent-roster.ts loadAgentRoster), and the ledger's AI limit as the
 * caller's members in `memberships` (listAiLimitedTeammates, fenced on those
 * member rows). Who is reachable is decided before this (readReachableBots),
 * so the roster reads no reach of its own. On the tool route's service
 * client, every read is limited to the caller's workspaces. Fail-soft: the
 * state is what's known.
 */
async function readBotFacts(
  supabase: SupabaseClient,
  args: { memberships: readonly Membership[]; teammateIds: readonly string[]; now: Date },
): Promise<BotFacts> {
  const ids = [...new Set(args.teammateIds)].slice(0, STATE_READ_MAX)
  const workspaceIds = [...new Set(args.memberships.map((m) => m.workspaceId))]
  const [roster, limited] = await Promise.all([
    ids.length === 0
      ? Promise.resolve({ roster: [] as RosterTeammate[], error: null as string | null })
      : loadAgentRoster({ session: supabase, service: supabase, workspaceIds, teammateIds: ids, now: args.now }).catch((err: unknown) => ({
          roster: [] as RosterTeammate[],
          error: err instanceof Error ? err.message : String(err),
        })),
    ids.length === 0 ? Promise.resolve([]) : listAiLimitedTeammates(supabase, { scope: args.memberships, now: args.now }),
  ])
  if (roster.error) console.error('[bot-work] roster read failed:', roster.error)
  return {
    roster: new Map(roster.roster.map((t) => [t.id, t])),
    aiLimited: aiLimitedTeammates(limited, null, null, args.now.getTime()),
    read: !roster.error,
  }
}

/**
 * A bot's state, why it rests and what it does, as its page reads them
 * (teammate-state.ts). With no roster entry for it (the read failed, or it's past
 * the bots read), its state is unknown: absent, never guessed, but a bot
 * running something is working whatever else is true.
 */
function statusOf(botId: string, running: number, facts: BotFacts): BotStatus {
  const mate = facts.roster.get(botId)
  if (!mate) return running > 0 ? { state: 'working' } : {}
  const limited = facts.aiLimited.has(botId)
  const rest = teammateRest(mate, limited)
  const drawn = teammateBotState(mate, running, limited)
  return {
    state: drawn === 'working' ? 'working' : drawn === 'sleeping' ? 'asleep' : 'awake',
    ...(rest ? { asleep_because: TEAMMATE_REST_WORDS[rest] } : {}),
    about: teammateBlurb(mate),
  }
}

const byName = (a: { name: string; bot_id: string }, b: { name: string; bot_id: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.bot_id.localeCompare(b.bot_id)

const STATE_RANK: Record<string, number> = { asleep: 0, awake: 1 }
const stateRank = (s: BotStatus) => (s.state ? (STATE_RANK[s.state] ?? 1) : 2)

/** A bot as a list names it, with its workspace's name when the caller has several. */
function refOf(bot: BotRef, workspaceNames: ReadonlyMap<string, string>): BotRef {
  const workspace = workspaceNames.get(bot.workspace_id)
  return {
    bot_id: bot.bot_id,
    name: bot.name,
    workspace_id: bot.workspace_id,
    ...(workspace ? { workspace } : {}),
    face: bot.face,
    ...(bot.self ? { self: true as const } : {}),
  }
}

/**
 * The ids whose state one answer reads, at most STATE_READ_MAX: `first` (the
 * busy bots) whole, then the rest by name.
 */
function factIds(first: readonly string[], rest: readonly BotRef[]): string[] {
  return [...new Set([...first, ...[...rest].sort(byName).map((b) => b.bot_id)])].slice(0, STATE_READ_MAX)
}

/**
 * Every bot the caller can reach (`reachable`, every teammate read, not a
 * capped roster) with nothing waiting and nothing running (`busyIds`: the
 * teammates countByOwner counts anything waiting or running for): asleep
 * first, then awake, then unknown, each by name.
 */
function idleBotsOf(
  reachable: ReadonlyMap<string, BotRef>,
  busyIds: ReadonlySet<string>,
  facts: BotFacts,
  workspaceNames: ReadonlyMap<string, string>,
): IdleBot[] {
  return [...reachable.values()]
    .filter((b) => !busyIds.has(b.bot_id))
    .map((b): IdleBot => {
      // Nothing runs, so its state is asleep, awake or unknown (absent).
      const { state, ...status } = statusOf(b.bot_id, 0, facts)
      return { ...refOf(b, workspaceNames), ...(state ? { state: state === 'asleep' ? ('asleep' as const) : ('awake' as const) } : {}), ...status }
    })
    .sort((a, b) => stateRank(a) - stateRank(b) || byName(a, b))
}

/** "  Writer " and "writer" read the same. */
const nameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

// ── Lines ────────────────────────────────────────────────────────────────────

function payloadText(payload: unknown, key: string): string | null {
  const v = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : null
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function rowType(status: string): BotItemType {
  return status === 'needs_input' ? 'question' : status === 'needs_review' ? 'review' : 'update'
}

/** A question card asks (P13: the chat's, read by id only); a post draft is a card like any delivered one. */
function cardType(card: Pick<AttentionItem, 'kind' | 'payload'>): BotItemType {
  return isChatAskCard(card) && card.kind === 'question' ? 'question' : 'card'
}

/** "Triage has three cards for you from 'Call with Acme'." Yours (`speaker` null): "I have three cards for you…". */
function batchLine(speaker: string | null, cards: readonly Pick<AttentionItem, 'payload'>[]): string {
  const from = cards.map((c) => payloadText(c.payload, 'capture_title') ?? payloadText(c.payload, 'skill_name')).find(Boolean)
  const n = cards.length
  return `${speaker ? `${speaker} has` : 'I have'} ${n} card${n === 1 ? '' : 's'} for you${from ? ` from '${from.replace(/\s+/g, ' ')}'` : ''}.`
}

/** Who a bot's lines name: null for the first person (the agent reading its own face's), else the speaker. */
function speakerFor(bot: Pick<BotRef, 'name' | 'self'> | null, voice: BotWorkVoice = 'agent'): string | null {
  if (!bot) return null
  if (bot.self) return voice === 'person' ? PERSON_AGENT_SPEAKER : null
  return bot.name
}

/**
 * How a bot's lines are said: the agent's own face (`self`) in the first
 * person to the agent itself, "Your agent…" to someone acting for the person
 * (voice `person`); any other bot's named, in the third.
 */
function voiceFor(bot: Pick<BotRef, 'name' | 'self'> | null, voice: BotWorkVoice = 'agent'): { person?: 'third'; speaker?: string } {
  const speaker = speakerFor(bot, voice)
  return speaker ? { person: 'third', speaker } : {}
}

/** The area an item of yours came from (one face): the area face the owner rule moved it from, else its row's own. */
function itemArea(item: BubbleItem, whole: ReadonlyMap<string, WorkItem>): AreaKey | undefined {
  if (item.kind === 'row') {
    // The owner rule stamped the area face's area on the listed row; a whole row (read raw) carries its own `area`.
    const wholeRow = whole.get(item.id)
    const area = faceAreaOf(item.row) ?? ('area' in item.row ? item.row.area : null) ?? wholeRow?.area ?? null
    return isAreaKey(area) ? area : undefined
  }
  const card = item.kind === 'card' ? item.card : item.cards[0]
  const raised = card?.payload?.raised_by_area
  return isAreaKey(raised) ? raised : undefined
}

function itemLine(
  item: BubbleItem,
  status: 'new' | 'seen',
  bot: Pick<BotRef, 'name' | 'self'>,
  whole: ReadonlyMap<string, WorkItem>,
  reader: BotWorkVoice = 'agent',
): BotWorkLine {
  const voice = voiceFor(bot, reader)
  const area = bot.self ? itemArea(item, whole) : undefined
  const tagged = area ? { area } : {}
  if (item.kind === 'row') {
    const row = whole.get(item.id) ?? item.row
    return { id: item.id, type: rowType(row.status), status, line: narrateItem({ item: row, ...voice }).line, ...tagged }
  }
  if (item.kind === 'card') {
    return { id: item.id, type: cardType(item.card), status, line: narrateItem({ card: item.card, ...voice }).line, ...tagged }
  }
  return { id: item.id, type: 'cards', status, cards: item.cards.length, line: batchLine(speakerFor(bot, reader), item.cards), ...tagged }
}

/** A card no bot owns, said plainly (there is no bot to say it): "A card from 'Call with Acme': Send Acme the deck." */
function unownedCardLine(card: Pick<AttentionItem, 'id' | 'kind' | 'title' | 'payload'>): BotWorkLine {
  const title = card.title.replace(/\s+/g, ' ').trim()
  const clipped = title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title
  const from = payloadText(card.payload, 'capture_title')
  const what = cardType(card) === 'question' ? 'A question' : 'A card'
  return {
    id: card.id,
    type: cardType(card),
    status: 'new',
    line: `${what}${from ? ` from '${from.replace(/\s+/g, ' ')}'` : ''}: ${clipped || 'untitled'}${/[.?!…]$/.test(clipped) ? '' : '.'}`,
  }
}

function runLine(row: WorkItem, bot: Pick<BotRef, 'name' | 'self'>, reader: BotWorkVoice = 'agent'): BotRunLine {
  const plan = planReading(row.plan, false)
  return { id: row.id, status: row.status, line: narrateItem({ item: row, ...voiceFor(bot, reader) }).line, ...(plan ? { plan } : {}) }
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/** One listed thing: a bubble item, or a Mail draft (always new). */
type GroupEntry = { item: BubbleItem; status: 'new' | 'seen' } | { draft: AgentDraft }

interface BotGroup {
  bot: BotRef
  waiting: number
  fresh: number
  seen: number
  running: number
  entries: GroupEntry[]
  more: number
}

/**
 * One bot's items as its page lists them: what's new (bubbleItems, a run's
 * cards folded into one), then its Mail drafts (`mail`: always new), then
 * what you've seen (seenItems), at most `cap`; and its counts, countByOwner's
 * own plus its drafts.
 */
function groupFor(
  bot: BotRef,
  source: Pick<BotSource, 'counts' | 'cards' | 'cardRows'>,
  rows: readonly BubbleRow[],
  cap: number,
  mail?: BotDrafts,
): BotGroup {
  const c = source.counts.get(teammateKey(bot.bot_id))
  const fresh = bubbleItems(bot.bot_id, source.counts, rows, source.cards, source.cardRows)
  const seen = seenItems(bot.bot_id, rows)
  const drafts = mail?.drafts ?? []
  const draftTotal = Math.max(mail?.total ?? 0, drafts.length)
  const all: GroupEntry[] = [
    ...fresh.map((item) => ({ item, status: 'new' as const })),
    ...drafts.map((draft) => ({ draft })),
    ...seen.map((item) => ({ item, status: 'seen' as const })),
  ]
  return {
    bot,
    waiting: (c?.needsYou ?? 0) + draftTotal,
    fresh: (c?.beckoning.length ?? 0) + draftTotal,
    seen: seen.length,
    running: c?.running ?? 0,
    entries: all.slice(0, cap),
    // Drafts past the ones read are counted too.
    more: Math.max(0, all.length + (draftTotal - drafts.length) - cap),
  }
}

function summaryOf(
  group: BotGroup,
  whole: ReadonlyMap<string, WorkItem>,
  workspaceNames: ReadonlyMap<string, string>,
  facts: BotFacts,
  reader: BotWorkVoice = 'agent',
): BotWorkSummary {
  const { bot } = group
  return {
    ...refOf(bot, workspaceNames),
    ...statusOf(bot.bot_id, group.running, facts),
    waiting: group.waiting,
    new: group.fresh,
    seen: group.seen,
    running: group.running,
    items: group.entries.map((e) => ('draft' in e ? draftLine(e.draft, bot, reader) : itemLine(e.item, e.status, bot, whole, reader))),
    more: group.more,
  }
}

function rowIdsOf(groups: readonly BotGroup[]): string[] {
  return groups.flatMap((g) => g.entries.flatMap((e) => ('item' in e && e.item.kind === 'row' ? [e.item.id] : [])))
}

function failed(what: string, err: unknown): { ok: false; code: 'READ_FAILED'; error: string } {
  console.error(`[bot-work] ${what} failed:`, err instanceof Error ? err.message : err)
  return { ok: false, code: 'READ_FAILED', error: "Could not read your agents' work right now." }
}

// ── Mail drafts (GEN-1165) ───────────────────────────────────────────────────

/** One bot's Mail drafts: those read (newest first) and how many it has in all. */
interface BotDrafts {
  drafts: AgentDraft[]
  total: number
}

/**
 * The bot each workspace's drafts list under, as For you puts them
 * (for-you-column.ts): a Correspondent the caller can reach (the first by
 * name), else the workspace's Assistant. A failed Correspondent read falls
 * back to the Assistant.
 */
async function draftWriters(
  supabase: SupabaseClient,
  userId: string,
  workspaceIds: readonly string[],
  owners: BotOwners,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (workspaceIds.length === 0) return out
  try {
    const { data, error } = await supabase.from('ai_team_member').select('id').in('workspace_id', [...workspaceIds]).eq('role', 'correspondent')
    if (error) throw new Error(error.message)
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (ids.length > 0) {
      const reachable = await readReachableBots(supabase, userId, ids, workspaceIds)
      for (const bot of [...reachable.values()].sort(byName)) if (!out.has(bot.workspace_id)) out.set(bot.workspace_id, bot.bot_id)
    }
  } catch (err) {
    console.warn('[bot-work] correspondents read failed; drafts list under the Assistant:', err instanceof Error ? err.message : err)
  }
  for (const ws of workspaceIds) {
    const assistant = owners.assistants.get(ws)?.id
    if (!out.has(ws) && assistant) out.set(ws, assistant)
  }
  return out
}

/**
 * The caller's open Mail drafts in `workspaceIds`, by the bot they list under
 * (draftWriters): the newest read, and each workspace's count (exact: counted
 * again per workspace only when there are more than one read). A workspace
 * with no bot to list them under lists none, as For you shows none. Fail-soft:
 * a failed read lists no drafts, never fails the answer.
 */
async function readBotDrafts(
  supabase: SupabaseClient,
  userId: string,
  workspaceIds: readonly string[],
  owners: BotOwners,
): Promise<Map<string, BotDrafts>> {
  const out = new Map<string, BotDrafts>()
  try {
    const { drafts, total } = await readAgentDraftsIn(supabase, userId, workspaceIds)
    if (total === 0) return out
    const totals = new Map<string, number>()
    if (total === drafts.length) {
      for (const d of drafts) totals.set(d.workspace_id, (totals.get(d.workspace_id) ?? 0) + 1)
    } else if (workspaceIds.length === 1) {
      totals.set(workspaceIds[0], total)
    } else {
      for (const ws of workspaceIds) totals.set(ws, (await readAgentDraftsIn(supabase, userId, [ws], 1)).total)
    }
    const writers = await draftWriters(supabase, userId, [...totals.keys()].filter((ws) => (totals.get(ws) ?? 0) > 0), owners)
    for (const [ws, count] of totals) {
      const botId = writers.get(ws)
      if (!botId || count === 0) continue
      const had = out.get(botId)
      const mine = drafts.filter((d) => d.workspace_id === ws)
      out.set(botId, had ? { drafts: [...had.drafts, ...mine], total: had.total + count } : { drafts: mine, total: count })
    }
  } catch (err) {
    console.warn('[bot-work] mail drafts read failed:', err instanceof Error ? err.message : err)
  }
  return out
}

/** A Mail draft as one line: "I drafted the reply to dana@acme.com: “Re: Pricing”; it waits in Mail." */
function draftLine(draft: Pick<AgentDraft, 'id' | 'to' | 'subject'>, bot: Pick<BotRef, 'name' | 'self'> | null, reader: BotWorkVoice = 'agent'): BotWorkLine {
  const speaker = bot ? speakerFor(bot, reader) : 'Native Intelligence'
  return {
    id: `${AGENT_DRAFT_ITEM_PREFIX}${draft.id}`,
    type: 'review',
    status: 'new',
    line: `${speaker ? `${speaker} drafted` : 'I drafted'} ${agentDraftSentence(draft)}; it waits in Mail.`,
    ...(bot?.self ? { area: 'mail' as AreaKey } : {}),
  }
}

// ── What's pending, bot by bot ───────────────────────────────────────────────

export async function readBotWork(caller: BotWorkCaller): Promise<BotWorkResult<BotWorkOverview>> {
  const { supabase, userId } = caller
  try {
    const now = caller.now ?? new Date()
    const source = await readSource(supabase, userId, now)
    // Every bot the caller can reach, read whole (the busy ones are among them), and the Mail drafts.
    const [reachable, workspaceNames, mail] = await Promise.all([
      readReachableBots(supabase, userId, 'all', source.workspaceIds),
      readWorkspaceNames(supabase, source.workspaceIds),
      readBotDrafts(supabase, userId, source.workspaceIds, source.owners),
    ])
    const busy = [
      ...[...source.counts.entries()]
        .filter(([key, c]) => key.startsWith(TEAMMATE_KEY_PREFIX) && (c.needsYou > 0 || c.running > 0))
        .map(([key]) => key.slice(TEAMMATE_KEY_PREFIX.length)),
      ...mail.keys(),
    ]
    const busyIds = new Set(busy)
    const busyBots = [...reachable.values()].filter((b) => busyIds.has(b.bot_id))
    const idleRefs = [...reachable.values()].filter((b) => !busyIds.has(b.bot_id))
    const wantedFacts = factIds(
      busyBots.map((b) => b.bot_id),
      idleRefs,
    )
    const facts = await readBotFacts(supabase, { memberships: source.memberships, teammateIds: wantedFacts, now })
    const groups = busyBots
      .map((bot) => groupFor(bot, source, source.rows, BOT_WORK_ITEMS_MAX, mail.get(bot.bot_id)))
      .sort(
        (a, b) =>
          b.fresh - a.fresh ||
          b.waiting - a.waiting ||
          b.running - a.running ||
          a.bot.name.localeCompare(b.bot.name, undefined, { sensitivity: 'base' }) ||
          a.bot.bot_id.localeCompare(b.bot.bot_id),
      )
    const shown = groups.slice(0, BOT_WORK_BOTS_MAX)
    const whole = await readWholeRows(supabase, rowIdsOf(shown), source.memberIds)
    const withoutBot: BotWorkOverview['without_bot'] = []
    for (const [key, c] of source.counts) {
      if (key.startsWith(LANE_KEY_PREFIX) && c.needsYou > 0) withoutBot.push({ lane: laneLabel(key.slice(LANE_KEY_PREFIX.length)), waiting: c.needsYou })
    }
    // The cards countByOwner counts for no one (the same lookup it owns them by).
    const lookup = cardLookupRows<CardRunRow | LightWorkRow>(source.rows, source.cardRows)
    const unowned = source.cards.filter((card) => cardOwnerKeys(card, lookup).length === 0)
    const idle = idleBotsOf(reachable, busyIds, facts, workspaceNames)
    const statesUnread = reachable.size > 0 && (!facts.read || wantedFacts.length < reachable.size)
    return {
      ok: true,
      value: {
        bots: shown.map((g) => summaryOf(g, whole, workspaceNames, facts, caller.voice)),
        more_bots: groups.length - shown.length,
        idle_bots: idle.slice(0, BOT_WORK_IDLE_MAX),
        more_idle_bots: Math.max(0, idle.length - BOT_WORK_IDLE_MAX),
        ...(statesUnread ? { states_unread: true as const } : {}),
        without_bot: withoutBot,
        unowned_cards: {
          waiting: unowned.length,
          items: unowned.slice(0, BOT_WORK_ITEMS_MAX).map(unownedCardLine),
          more: Math.max(0, unowned.length - BOT_WORK_ITEMS_MAX),
        },
        asks_in_chat: {
          waiting: source.asks.length,
          items: source.asks.slice(0, BOT_WORK_ITEMS_MAX).map(askInChatLine),
          more: Math.max(0, source.asks.length - BOT_WORK_ITEMS_MAX),
          note: ASKS_IN_CHAT_NOTE,
        },
      },
    }
  } catch (err) {
    return failed('overview', err)
  }
}

// ── One bot ──────────────────────────────────────────────────────────────────

const NO_BOT = {
  ok: false as const,
  code: 'NOT_FOUND' as const,
  error: 'No agent of yours with that id. Pass a bot_id exactly as list_bot_work gave it, never shortened or filled in, or pass name to find an agent by name.',
}
/** A bot_id that is no id at all. */
const BAD_BOT_ID = {
  ok: false as const,
  code: 'INPUT_INVALID' as const,
  error: 'bot_id is a bot_id exactly as list_bot_work gave it (pass name to find an agent by name; an item id goes to get_bot_item).',
}

/** The rows For you reads: the bot's own (whole) first, then the shared source's it doesn't hold (for-you.tsx forYouRows). */
function forYouRows(own: readonly WorkItem[], shared: readonly BubbleRow[]): BubbleRow[] {
  const have = new Set(own.map((r) => r.id))
  return [...own, ...shared.filter((r) => !have.has(r.id))]
}

export async function readBotDetail(caller: BotWorkCaller, askedBotId: string): Promise<BotWorkResult<BotWorkDetail>> {
  const { supabase, userId } = caller
  if (!UUID.test(askedBotId)) return BAD_BOT_ID
  const now = caller.now ?? new Date()
  try {
    const memberships = await readMemberships(supabase, userId)
    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]
    // An area face reads as its workspace's Assistant (one face).
    const botId = await agentBotIdFor(supabase, askedBotId, workspaceIds)
    const [source, bots, workspaceNames] = await Promise.all([
      readSource(supabase, userId, now, memberships),
      readReachableBots(supabase, userId, [botId], workspaceIds),
      readWorkspaceNames(supabase, workspaceIds),
    ])
    const bot = bots.get(botId)
    // Not visible to the caller, in a workspace they're not in, or behind a
    // private team they aren't on: one answer for all, as for no such bot.
    if (!bot) return NO_BOT
    const memberId = source.memberships.find((m) => m.workspaceId === bot.workspace_id)?.memberId
    if (!memberId) return NO_BOT
    // Its state, read for it alone, in its own workspace.
    const factsRead = readBotFacts(supabase, { memberships: [{ memberId, workspaceId: bot.workspace_id }], teammateIds: [bot.bot_id], now })
    // Its Mail drafts, read alongside (never rejects: a failed read lists none).
    const mailRead = readBotDrafts(supabase, userId, [bot.workspace_id], source.owners)

    const sinceIso = new Date(now.getTime() - WORK_FEED_WINDOW_DAYS * 86_400_000).toISOString()
    // The workspace's Assistant also holds the work no reachable bot does (the owner rule).
    const isAssistant = source.owners.assistants.get(bot.workspace_id)?.id === bot.bot_id
    // Its page's facts: every teammate of its workspace, so "every row no other reachable bot holds" is exact.
    const owners = isAssistant ? await loadBotOwners(supabase, { userId, workspaceIds: [bot.workspace_id], teammateIds: 'all' }) : source.owners
    const read = await listTeammateWork(supabase, {
      teammateId: bot.bot_id,
      workspaceId: bot.workspace_id,
      memberIds: [memberId],
      sinceIso,
      ...(isAssistant
        ? { unowned: { otherTeammateIds: otherReachableTeammates(owners, bot.workspace_id), kindsWithoutBot: [...KINDS_WITHOUT_BOT] } }
        : {}),
    })
    if (read.error) throw new ReadFailed(`teammate work: ${read.error}`)
    const work = { items: withBotOwners(read.items, owners), lastFinished: read.lastFinished ? withBotOwners([read.lastFinished], owners)[0] : null }

    const mail = await mailRead
    const group = groupFor(bot, source, forYouRows(work.items, source.rows), BOT_DETAIL_ITEMS_MAX, mail.get(bot.bot_id))
    const facts = await factsRead
    const held = new Map(work.items.map((r) => [r.id, r]))
    const missing = rowIdsOf([group]).filter((id) => !held.has(id))
    const whole = new Map([...held, ...(await readWholeRows(supabase, missing, source.memberIds))])

    const mine = work.items.filter((r) => r.ai_team_member_id === bot.bot_id)
    const working = mine.filter((r) => isWorkLive(r.status) && !workNeedsYou(r.status))
    const done = mine
      .filter((r) => TERMINAL.has(r.status))
      .sort((a, b) => (settledAt(a) < settledAt(b) ? 1 : settledAt(a) > settledAt(b) ? -1 : 0))
    const doneLately = done.length > 0 ? done.slice(0, BOT_DETAIL_DONE_MAX) : work.lastFinished ? [work.lastFinished] : []

    return {
      ok: true,
      value: {
        ...summaryOf(group, whole, workspaceNames, facts, caller.voice),
        working_on: working.slice(0, BOT_DETAIL_WORKING_MAX).map((r) => runLine(r, bot, caller.voice)),
        done_lately: doneLately.map((r) => runLine(r, bot, caller.voice)),
        window_days: WORK_FEED_WINDOW_DAYS,
      },
    }
  } catch (err) {
    return failed('bot detail', err)
  }
}

// ── A bot by name ────────────────────────────────────────────────────────────

const NO_NAMED_BOT = { ok: false as const, code: 'NOT_FOUND' as const, error: 'No agent of yours has a name like that: list_bot_work with no name lists them.' }

/**
 * The bots the caller can reach whose name matches `name` (case and spacing
 * aside): those named exactly that, when there are any, else those whose name
 * holds it. One: that bot's detail (readBotDetail). Several: each with its
 * state, what it does and its counts, at most BOT_NAME_MATCHES_MAX. So a bot
 * past the overview's caps, or one asked for by name ("is Writer asleep?"), is
 * always reachable.
 */
export async function readBotsByName(caller: BotWorkCaller, name: string): Promise<BotWorkResult<BotNameLookup>> {
  const { supabase, userId } = caller
  const key = nameKey(name)
  if (!key) return { ok: false, code: 'INPUT_INVALID', error: 'name is part of an agent\'s name.' }
  const now = caller.now ?? new Date()
  try {
    const memberships = await readMemberships(supabase, userId)
    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]
    const reachable = await readReachableBots(supabase, userId, 'all', workspaceIds)
    const all = [...reachable.values()]
    const exact = all.filter((b) => nameKey(b.name) === key)
    const found = (exact.length > 0 ? exact : all.filter((b) => nameKey(b.name).includes(key))).sort(byName)
    if (found.length === 0) return NO_NAMED_BOT
    if (found.length === 1) {
      const detail = await readBotDetail(caller, found[0].bot_id)
      return detail.ok ? { ok: true, value: { bot: detail.value } } : detail
    }
    const shown = found.slice(0, BOT_NAME_MATCHES_MAX)
    const [source, workspaceNames, facts] = await Promise.all([
      readSource(supabase, userId, now, memberships),
      readWorkspaceNames(supabase, workspaceIds),
      readBotFacts(supabase, { memberships, teammateIds: shown.map((b) => b.bot_id), now }),
    ])
    const mail = await readBotDrafts(supabase, userId, [...new Set(shown.map((b) => b.workspace_id))], source.owners)
    const matches = shown.map((b): BotMatch => {
      const c = source.counts.get(teammateKey(b.bot_id))
      const running = c?.running ?? 0
      return { ...refOf(b, workspaceNames), ...statusOf(b.bot_id, running, facts), waiting: (c?.needsYou ?? 0) + (mail.get(b.bot_id)?.total ?? 0), running }
    })
    return {
      ok: true,
      value: { matches, more: found.length - shown.length, ...(facts.read ? {} : { states_unread: true as const }) },
    }
  } catch (err) {
    return failed('bot by name', err)
  }
}

// ── One item ─────────────────────────────────────────────────────────────────

const NO_ITEM = { ok: false as const, code: 'NOT_FOUND' as const, error: 'No item of yours with that id: list_bot_work gives the ids.' }

/** The caller's sign-in address, which the draft narration leaves out as a sender (fail-soft: none). */
async function userEmail(supabase: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const admin = (supabase as unknown as { auth?: { admin?: { getUserById?: (id: string) => Promise<{ data?: { user?: { email?: string | null } | null } | null }> } } }).auth?.admin
    if (typeof admin?.getUserById !== 'function') return null
    const { data } = await admin.getUserById(userId)
    return data?.user?.email ?? null
  } catch {
    return null
  }
}

/**
 * The bot a teammate key names, when the caller may talk to it; `null` for a
 * lane (no bot); `undefined` for a bot they may not reach (refused).
 */
async function ownerBot(
  caller: BotWorkCaller,
  ownerKey: string | null,
  workspaceIds: readonly string[],
): Promise<BotRef | null | undefined> {
  if (!ownerKey || !ownerKey.startsWith(TEAMMATE_KEY_PREFIX)) return null
  const id = ownerKey.slice(TEAMMATE_KEY_PREFIX.length)
  return (await readReachableBots(caller.supabase, caller.userId, [id], workspaceIds)).get(id)
}

/** The row's member is the caller's own member row IN the row's workspace. */
function ownsInWorkspace(memberships: readonly Membership[], row: { member_id: string; workspace_id: string }): boolean {
  return memberships.some((m) => m.memberId === row.member_id && m.workspaceId === row.workspace_id)
}

function botOf(bot: BotRef | null): BotItemReading['bot'] {
  return bot ? { bot_id: bot.bot_id, name: bot.name, ...(bot.self ? { self: true as const } : {}) } : null
}

/** A ledger row of the caller's own, as findOwnItem reads it (what the reads and the writes need of it). */
export interface OwnItemRow {
  id: string
  member_id: string
  workspace_id: string
  status: string
  kind: string
  title: string | null
  ai_team_member_id: string | null
  agent_run_id: string | null
  source: Record<string, unknown> | null
  progress: WorkItem['progress']
  deliverables: WorkItem['deliverables']
  /** Its area (migration 318), when it records one. */
  area?: string | null
  /** The agent's plan (migration 331), when one was written. */
  plan?: unknown
}

/** A card of the caller's own, as findOwnItem reads it. */
export type OwnItemCard = Pick<AttentionItem, 'id' | 'member_id' | 'workspace_id' | 'kind' | 'status' | 'payload' | 'source_flow_run_id'> & {
  title: string | null
}

/** One of the caller's own items, and the bot it's from (null: work no bot speaks for). */
/**
 * One of the caller's own items, and the bot it's from (null: work no bot speaks for).
 * A row's `fallback`: the Assistant shows it for a teammate the caller can't
 * reach (lib/work/bot-owner.ts `owner_fallback`): its run's chat runs as that
 * other bot, so nothing continues it (bot-relay.ts refuses it).
 */
export type OwnItem =
  | { kind: 'row'; row: OwnItemRow; bot: BotRef | null; fallback?: true }
  | { kind: 'card'; card: OwnItemCard; bot: BotRef | null }

const OWN_ROW_SELECT = 'id, member_id, workspace_id, status, kind, title, ai_team_member_id, agent_run_id, source, progress, deliverables, area, plan'
const OWN_CARD_SELECT = 'id, member_id, workspace_id, kind, status, title, payload, source_flow_run_id'

/**
 * A ledger row or a card by its id (a uuid), when it is the caller's own: its
 * member is one of the caller's member rows AND that member row is in the
 * item's own workspace (nothing in the schema ties the two together, and the
 * reads and writes after this fence on that workspace). Its bot is the owner
 * rule's (bot-owner.ts): the bot it names when the caller may talk to it,
 * else its workspace's Assistant (work with no bot the caller can reach is
 * the Assistant's), else, in a workspace with no Assistant known, none for
 * work that names no bot and a refusal for a private team's bot's. Null for
 * anything else (another member's, a workspace the caller isn't in, nothing
 * there): one answer for all. The one fence the main agent's reads
 * (readBotItem) and writes (bot-work-acts.ts) share, on any client: every
 * read is fenced explicitly. Throws on a failed read.
 */
export async function findOwnItem(caller: BotWorkCaller, id: string): Promise<OwnItem | null> {
  const { supabase, userId } = caller
  const memberships = await readMemberships(supabase, userId)
  const memberIds = [...new Set(memberships.map((m) => m.memberId))]
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]
  if (memberIds.length === 0) return null

  // A ledger row of the caller's own?
  // Without migration 331 the read is made again without `plan` (readWithPlanFallback).
  const rowRead = await readWithPlanFallback(OWN_ROW_SELECT, (columns) =>
    supabase.from('tracked_job').select(columns).eq('id', id).in('member_id', memberIds).maybeSingle(),
  )
  if (rowRead.error) throw new ReadFailed(`row: ${rowRead.error.message}`)
  const row = (rowRead.data as OwnItemRow | null) ?? null
  if (row) {
    if (!ownsInWorkspace(memberships, row)) return null
    const owners = await loadBotOwners(supabase, { userId, workspaceIds: [row.workspace_id], teammateIds: namedTeammateIds([row]) })
    const owner = rowOwnerId(row, owners)
    const bot = await ownerBot(caller, owner ? teammateKey(owner) : null, workspaceIds)
    if (bot === undefined) return null
    return { kind: 'row', row, bot, ...(assistantTakes(row, owners) === 'fallback' ? { fallback: true as const } : {}) }
  }

  // A card of the caller's own?
  const cardRead = await supabase.from('attention_item').select(OWN_CARD_SELECT).eq('id', id).in('member_id', memberIds).maybeSingle()
  if (cardRead.error) throw new ReadFailed(`card: ${cardRead.error.message}`)
  const card = (cardRead.data as OwnItemCard | null) ?? null
  if (!card || !ownsInWorkspace(memberships, card)) return null
  // Its owner, as the bots find it (the owner rule, then cardOwnerKeys): who
  // raised it, else the run that wrote it, else its workspace's Assistant.
  let runRows: CardRunRow[] = []
  if (card.source_flow_run_id && !payloadText(card.payload, 'raised_by_ai_member_id')) {
    const runs = await supabase
      .from('tracked_job')
      .select('id, workspace_id, kind, ai_team_member_id, flow_run_id')
      .eq('flow_run_id', card.source_flow_run_id)
      .in('member_id', memberIds)
      .limit(1)
    if (runs.error) throw new ReadFailed(`card run: ${runs.error.message}`)
    runRows = (runs.data ?? []) as unknown as CardRunRow[]
  }
  const owners = await loadBotOwners(supabase, { userId, workspaceIds: [card.workspace_id], teammateIds: namedTeammateIds(runRows, [card]) })
  const bot = await ownerBot(caller, cardOwnerKeys(withCardOwner(card, owners), withBotOwners(runRows, owners))[0] ?? null, workspaceIds)
  return bot === undefined ? null : { kind: 'card', card, bot }
}

/**
 * The bot one of the caller's items is from (findOwnItem's owner rule), for
 * an item's id that came in as a bot's: list_bot_work then answers with that
 * bot (PROD, 2026-10-08: a model passed an item's id as bot_id). Null when the
 * id is no item of the caller's, the item has no bot, or a read fails.
 */
export async function findItemBot(caller: BotWorkCaller, id: string): Promise<BotRef | null> {
  if (!UUID.test(id)) return null
  try {
    return (await findOwnItem(caller, id))?.bot ?? null
  } catch {
    return null
  }
}

/** Drafts a reading names for revise_email_draft, at most this many. */
const DRAFT_IDS_MAX = 5

/**
 * A draft id as a model may read it: an email_draft row id or a mailbox draft
 * id, the two shapes revise_email_draft takes (provider-drafts.ts isProviderId:
 * one token of base64 characters). The run that delivered it wrote the id, so
 * anything else (words, spaces, markup) is withheld, never shown.
 */
const DRAFT_ID = /^[A-Za-z0-9_=+/-]{1,512}$/

/** The drafts a row still waits on (its unresolved email_draft deliverables): the ids revise_email_draft takes. */
function openDraftIds(row: Pick<OwnItemRow, 'deliverables'>): string[] {
  const list = Array.isArray(row.deliverables) ? row.deliverables : []
  return list
    .filter((d) => d && d.type === 'email_draft' && typeof d.id === 'string' && DRAFT_ID.test(d.id) && !d.resolved_at)
    .map((d) => d.id)
    .slice(0, DRAFT_IDS_MAX)
}

/** One item in full. `botId`: for a run's cards, whose batch (see readBatch); ignored otherwise. */
export async function readBotItem(caller: BotWorkCaller, itemId: string, botId?: string): Promise<BotWorkResult<BotItemReading>> {
  const id = itemId.trim()
  if (isBatchKey(id)) {
    if (botId !== undefined && !UUID.test(botId)) return BAD_BOT_ID
    return readBatch(caller, id, botId)
  }
  if (id.startsWith(AGENT_DRAFT_ITEM_PREFIX)) return readDraftItem(caller, id)
  if (!UUID.test(id)) return { ok: false, code: 'INPUT_INVALID', error: 'item_id is an item id from list_bot_work.' }
  const { supabase, userId } = caller
  try {
    const own = await findOwnItem(caller, id)
    if (!own) return NO_ITEM
    const { bot } = own
    // Yours (one face) in the first person; another bot's named.
    const speaking = voiceFor(bot, caller.voice)

    if (own.kind === 'row') {
      const { row } = own
      // The narration reads fence on the row's workspace (findOwnItem made it
      // the workspace of the member row that makes it the caller's).
      const auth: NarrationAuth = { supabase, user: { id: userId, email: await userEmail(supabase, userId) }, member: { id: row.member_id } }
      const reply = await narrateWorkItemById(auth, id, speaking)
      if (!reply) return NO_ITEM
      const draftIds = row.status === 'needs_review' ? openDraftIds(row) : []
      const plan = planReading(row.plan, true)
      return {
        ok: true,
        value: {
          id,
          type: rowType(row.status),
          bot: botOf(bot),
          ...(isAreaKey(row.area) ? { area: row.area } : {}),
          line: reply.line,
          status: row.status,
          ...(reply.readKind ? { read_kind: reply.readKind } : {}),
          ...(reply.readTitle ? { title: reply.readTitle } : {}),
          ...(reply.readText ? { text: reply.readText } : {}),
          ...(draftIds.length > 0 ? { draft_ids: draftIds } : {}),
          ...(plan ? { plan } : {}),
        },
      }
    }

    const { card } = own
    const auth: NarrationAuth = { supabase, user: { id: userId, email: null }, member: { id: card.member_id } }
    const reply = await narrateCardById(auth, id, speaking)
    if (!reply) return NO_ITEM
    return {
      ok: true,
      value: {
        id,
        type: cardType(card),
        bot: botOf(bot),
        line: reply.line,
        status: card.status,
        ...(reply.readKind ? { read_kind: reply.readKind } : {}),
        ...(reply.readTitle ? { title: reply.readTitle } : {}),
        ...(reply.readText ? { text: reply.readText } : {}),
      },
    }
  } catch (err) {
    return failed('item', err)
  }
}

/**
 * A run's cards (`work:<id>`, `run:<key>:<loop>`): its pending cards, one by
 * one, as one bot's batch. The bubble folds a run's cards per owner
 * (bubbleItems), and only where an owner has two or more of them, so when a
 * run's cards have different owners each such owner has its own batch under
 * the same key. `botId` picks whose (an unreachable one is not found);
 * without it, the first owner holding two or more (else the first owner).
 * Only that owner's cards are read, so the batch is the one the overview
 * counted.
 */
async function readBatch(caller: BotWorkCaller, key: string, botId?: string): Promise<BotWorkResult<BotItemReading>> {
  try {
    const source = await readSource(caller.supabase, caller.userId, caller.now ?? new Date())
    const lookup = cardLookupRows<CardRunRow | LightWorkRow>(source.rows, source.cardRows)
    const byOwner = new Map<string | null, AttentionItem[]>()
    for (const card of source.cards) {
      if (batchKeyOf(card) !== key) continue
      const owner = cardOwnerKeys(card, lookup)[0] ?? null
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), card])
    }
    const groups = [...byOwner.entries()]
    const ownerKey = botId
      ? teammateKey(botId)
      : ((groups.find(([, list]) => list.length > 1) ?? groups[0])?.[0] ?? null)
    const cards = byOwner.get(ownerKey) ?? []
    if (cards.length === 0) return NO_ITEM
    const bot = await ownerBot(caller, ownerKey, source.workspaceIds)
    if (bot === undefined) return NO_ITEM
    const speaker = bot ? speakerFor(bot, caller.voice) : 'Native Intelligence'
    const voice = speaker ? { person: 'third' as const, speaker } : {}
    return {
      ok: true,
      value: {
        id: key,
        type: 'cards',
        bot: botOf(bot),
        line: batchLine(speaker, cards),
        status: 'pending',
        cards: cards.map((c) => {
          const text = cardReading(c)?.text
          return {
            card_id: c.id,
            kind: c.kind,
            line: narrateItem({ card: c, ...voice }).line,
            ...(text ? { text: text.length > BATCH_CARD_TEXT_MAX ? `${text.slice(0, BATCH_CARD_TEXT_MAX - 1)}…` : text } : {}),
          }
        }),
      },
    }
  } catch (err) {
    return failed('cards', err)
  }
}

// ── A Mail draft ─────────────────────────────────────────────────────────────

/** A Mail draft of the caller's own, as findOwnDraft reads it. */
export interface OwnDraft {
  id: string
  workspace_id: string
  status: string
  subject: string | null
  to_emails: string[] | null
  body_text: string | null
  created_at: string
  /** The bot it lists under (draftWriters); null when there is none to reach. */
  bot: BotRef | null
}

const OWN_DRAFT_SELECT = 'id, workspace_id, status, subject, to_emails, body_text, created_at'

/** A draft's text in a reading, at most this many characters. */
const DRAFT_TEXT_MAX = 8000

/**
 * A Mail draft item (`draft:<email_draft row id>`) when it is the caller's own:
 * their row (`user_id = the caller`) in one of their workspaces, any status (a
 * settled one answers as such). Its bot is the one it lists under. Null for
 * anything else: one answer for all. Throws on a failed read.
 */
export async function findOwnDraft(caller: BotWorkCaller, itemId: string): Promise<OwnDraft | null> {
  const { supabase, userId } = caller
  const rowId = itemId.trim().slice(AGENT_DRAFT_ITEM_PREFIX.length)
  if (!itemId.trim().startsWith(AGENT_DRAFT_ITEM_PREFIX) || !UUID.test(rowId)) return null
  const memberships = await readMemberships(supabase, userId)
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]
  if (workspaceIds.length === 0) return null
  const { data, error } = await supabase
    .from('email_draft')
    .select(OWN_DRAFT_SELECT)
    .eq('id', rowId)
    .eq('user_id', userId)
    .in('workspace_id', workspaceIds)
    .maybeSingle()
  if (error) throw new ReadFailed(`draft: ${error.message}`)
  const row = data as Omit<OwnDraft, 'bot'> | null
  if (!row) return null
  const owners = await loadBotOwners(supabase, { userId, workspaceIds: [row.workspace_id], teammateIds: [] })
  const writer = (await draftWriters(supabase, userId, [row.workspace_id], owners)).get(row.workspace_id)
  const bot = writer ? ((await readReachableBots(supabase, userId, [writer], workspaceIds)).get(writer) ?? null) : null
  return { ...row, bot }
}

/** One Mail draft in full: who it goes to, its subject and its text, and the id revise_email_draft takes. */
async function readDraftItem(caller: BotWorkCaller, itemId: string): Promise<BotWorkResult<BotItemReading>> {
  try {
    const own = await findOwnDraft(caller, itemId)
    if (!own) return NO_ITEM
    const to = Array.isArray(own.to_emails) ? own.to_emails : []
    const reading = draftReading({ subject: own.subject, recipients: to, bodyText: own.body_text?.slice(0, DRAFT_TEXT_MAX) ?? null })
    const draft = { id: own.id, to: to[0] ?? null, subject: own.subject?.trim() || null }
    return {
      ok: true,
      value: {
        id: `${AGENT_DRAFT_ITEM_PREFIX}${own.id}`,
        type: 'review',
        bot: botOf(own.bot),
        area: 'mail',
        line: draftLine(draft, own.bot, caller.voice).line,
        status: own.status,
        read_kind: 'email_draft',
        ...(own.subject?.trim() ? { title: own.subject.trim() } : {}),
        ...(reading?.text ? { text: reading.text } : {}),
        draft_ids: [own.id],
      },
    }
  } catch (err) {
    return failed('draft', err)
  }
}
