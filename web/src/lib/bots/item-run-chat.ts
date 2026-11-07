/**
 * Items continue their run's chat (bots-v2.md "Items continue their run's
 * chat"): a bot's bubble pages a teammate's new items, and for an item a work
 * run produced ("here's an email I put together") the conversation to have
 * about it is THAT run's: its parked eve session, which holds everything the
 * run did and its tools (/api/account/agent-runs/[id]/chat, RunChatTransport).
 * Open on the item opens that run's view and chat in a tab; a reply to the
 * item, typed or said, goes to it.
 *
 * Which items have one (pure, from what the shared source holds):
 *
 *   a work run's row (`kind: 'work_run'`) with its agent run
 *     (`agent_run_id`: the column; the mirror's `source.agent_run_id` for a
 *     row read without it). Waiting on review, replies go to the run's chat;
 *     waiting on an answer (`needs_input`) the run isn't settled, so its chat
 *     can't be had yet: Open shows the run with its question, and a reply IS
 *     the answer (answerRunQuestion: the run's respond route, as the run
 *     view's question form sends it), and the run picks up from there.
 *   a LOOP run's row (`flow_run` / `skill_run`), its card, or its batch of
 *     cards, when the run parked its session (bots v3 Phase 4: the row's
 *     `source.run_chat`; bubbleItems marks the cards' items `runChat`): that
 *     session, under the id `loop:<row id>` (run-chat-ref.ts →
 *     /api/account/activity/[id]/chat), so "why did you dismiss the second
 *     one?" is asked in the chat that made the verdict. A loop run never asks
 *     mid-run (`asking` is false).
 *   anything else has none, and keeps the teammate's own thread plus the
 *     run's "about" section: a coding run (a task session, never parked: the
 *     route refuses its kind), a loop run that didn't park (one from before
 *     Phase 4, one nobody fronts, one that failed), a card no parked run left
 *     (a proposal to start work), and a row with no run (an email drafting
 *     pass, a fixture).
 *
 * Who may chat is the chat route's to say, never this module's: only the
 * person who started the run, a member of its workspace. A run the signed-in
 * user didn't start (a cron's, someone else's) is refused there (403), and the
 * caller falls back to the teammate's own thread, saying why
 * (runChatRefusalLine).
 */
import { itemWorkItemId, rowHasRunChat, type BubbleItem, type BubbleRow } from './bubble-items'
import { isAboutId, type TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import { loopRunChatId } from '@/lib/agent-run/run-chat-ref'
import { isOwnRun } from './own-run'
import { isOwnerFallback } from '@/lib/work/bot-owner'

/** An item a run produced, and the run whose chat continues it. */
export interface ItemRunChat {
  kind: 'run'
  itemId: string
  runId: string
  /** The item's (and so the run's) workspace. */
  workspaceId: string
  /** The run is waiting on an answer: Open shows its question; a reply answers it (answerRunQuestion). */
  asking: boolean
  /**
   * The run is the person's own (bots-v4 Phase 5): the bot was routed to its
   * row for attribution only (`source.teammate_routed`), so its chat is the
   * person's own run's, on its own limits, never the bot speaking. The chat
   * says so (aboutLineLabel, OWN_RUN_SPEAKER).
   */
  own?: true
}

/** Why an item has no run chat (every one keeps the teammate's own thread). */
/** `fallback`: the Assistant shows it for a bot you can't reach (lib/work/bot-owner.ts), whose run's chat isn't yours to continue. */
export type NoRunChatWhy = 'card' | 'coding' | 'loop' | 'no-run' | 'fallback'

export interface ItemNoRunChat {
  kind: 'none'
  itemId: string
  why: NoRunChatWhy
}

export type ItemChat = ItemRunChat | ItemNoRunChat

const ID = /^[\w:.-]{1,128}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/** The agent run behind a row: its column, else what the mirror wrote in `source`. Null for none (or one that isn't an id). */
export function itemRunId(row: { agent_run_id?: string | null; source?: Record<string, unknown> | null }): string | null {
  if (isId(row.agent_run_id)) return row.agent_run_id
  const fromSource = row.source?.agent_run_id
  return isId(fromSource) ? fromSource : null
}

/** Where the conversation about `item` is: its run's chat, or none (the teammate's own thread). */
export function itemChat(item: BubbleItem): ItemChat {
  // A loop run's card, or its cards folded (bots v3 1b): the chat that made the
  // verdict when its run parked its session (Phase 4, bubbleItems `runChat`),
  // else the teammate's own thread plus the run's "about" section.
  if (item.kind === 'card' || item.kind === 'batch') {
    const workItemId = itemWorkItemId(item)
    const workspaceId = (item.kind === 'card' ? item.card : item.cards[0])?.workspace_id ?? null
    if (item.runChat && workItemId && isId(workItemId) && workspaceId) {
      return { kind: 'run', itemId: item.id, runId: loopRunChatId(workItemId), workspaceId, asking: false }
    }
    return { kind: 'none', itemId: item.id, why: item.kind === 'card' ? 'card' : 'loop' }
  }
  const row = item.row
  // Shown by the Assistant for a bot you can't reach: that run's chat runs as
  // the other bot, on its ceiling, so its own thread takes the message instead.
  if (isOwnerFallback(row)) return { kind: 'none', itemId: item.id, why: 'fallback' }
  if (row.kind === 'coding_run') return { kind: 'none', itemId: item.id, why: 'coding' }
  if (row.kind === 'flow_run' || row.kind === 'skill_run') {
    // A loop's run that parked its session (source.run_chat): that chat. A loop run
    // never asks mid-run, so a reply is always a follow-up turn.
    return rowHasRunChat(row) && isId(row.id)
      ? { kind: 'run', itemId: item.id, runId: loopRunChatId(row.id), workspaceId: row.workspace_id, asking: false }
      : { kind: 'none', itemId: item.id, why: 'loop' }
  }
  if (row.kind !== 'work_run') return { kind: 'none', itemId: item.id, why: 'no-run' }
  const runId = itemRunId(row)
  if (!runId) return { kind: 'none', itemId: item.id, why: 'no-run' }
  return {
    kind: 'run',
    itemId: item.id,
    runId,
    workspaceId: row.workspace_id,
    asking: row.status === 'needs_input',
    ...(isOwnRun(row) ? { own: true as const } : {}),
  }
}

// A person's own run's helpers (bots-v4 Phase 5) live in ./own-run.ts, a pure
// module the server's relay (bot-relay.ts) reads too; re-exported here for the
// bubble and the bot's page.
export { aboutLineLabel, isOwnRun, OWN_RUN_SPEAKER } from './own-run'

/**
 * The run a reply to `item` goes to: a run-backed item's. Waiting on review,
 * its follow-up chat; asking (`asking`), the reply answers its question
 * (answerRunQuestion). Null: the teammate's own thread.
 */
export function replyRun(item: BubbleItem | null | undefined): ItemRunChat | null {
  if (!item) return null
  const chat = itemChat(item)
  return chat.kind === 'run' ? chat : null
}

/**
 * What a message to the teammate's own thread is about, for `item` (bots v3
 * 1d, docs/plans/bots-v3.md "Talk about this run"): the item's run, attached
 * server-side as the "About this item" section (its verdict and reasons, its
 * cards, its capture; teammate-about.ts). Ids only:
 *   a batch    its ledger row (`workItemId`), else its first card;
 *   a card     the run it names (`payload.work_item_id`), else itself;
 *   a row      itself (a `tracked_job` row: a loop's run, a coding run, a
 *              work run whose chat was refused or isn't there).
 * Null for an item that names neither (a fixture). The mint checks the item is
 * the caller's own, and the spec re-checks it, so this is never trusted.
 */
export function itemAboutRef(item: BubbleItem | null | undefined): TeammateAboutRef | null {
  if (!item) return null
  if (item.kind === 'batch') {
    if (isAboutId(item.workItemId)) return { workItemId: item.workItemId }
    const first = item.cards[0]
    return first ? cardAboutRef(first) : null
  }
  if (item.kind === 'card') return cardAboutRef(item.card)
  return isAboutId(item.row.id) ? { workItemId: item.row.id } : null
}

function cardAboutRef(card: { id: string; payload?: Record<string, unknown> | null }): TeammateAboutRef | null {
  const named = card.payload?.work_item_id
  if (isAboutId(named)) return { workItemId: named }
  return isAboutId(card.id) ? { cardId: card.id } : null
}

/**
 * The conversation about one work item, found from its row (bots-v4.md "An
 * item opens on its bot's page", Phase 2: the bot's page in item view), the
 * same way the bubble finds it for an item it shows: a work run's agent run
 * (`runId`; asking while it waits on an answer, when what's sent answers it),
 * or a loop run's parked session (`loop:<work item id>`); else the teammate's
 * own thread with the item attached (`context`). TeammateChat's `about`,
 * without its title and its `off`.
 */
export interface ItemConversation {
  runId?: string
  context?: TeammateAboutRef
  asking?: boolean
  workspaceId?: string
  /** A person's own run a bot was routed to: its chat is theirs (ItemRunChat `own`). */
  own?: true
}

export function rowConversation(row: BubbleRow): ItemConversation | null {
  const item: BubbleItem = { kind: 'row', id: row.id, row }
  const run = replyRun(item)
  const context = itemAboutRef(item)
  if (run) {
    return { runId: run.runId, ...(context ? { context } : {}), asking: run.asking, workspaceId: run.workspaceId, ...(run.own ? { own: true as const } : {}) }
  }
  return context ? { context } : null
}

/** How answering a run's question went: sent; refused (it isn't the user's to answer, or isn't asking now); or failed in passing. */
export type RunAnswerResult = { ok: true } | { ok: false; refusal: RunChatRefusal | null }

/** Answers the respond route turns down for good (not the user's run, not asking now, gone): the reply goes to the teammate instead. */
const ANSWER_REFUSED = new Set([400, 403, 404, 409])

/**
 * Answers the question run `runId` waits on with `text`, as the run view's
 * question form does (POST /api/account/agent-runs/[id]/respond: only the
 * person who started the run, a member of its workspace; the route decides).
 * The question is read first (the run, in its own workspace `workspaceId`):
 * the reply answers what it asks, every question at once (one free-text
 * reply, as the form's "Other"). Resolves `{ ok: true }` once the run has it
 * (it resumes); a refusal (the route's 400/403/404/409, or a run not asking a
 * question now) says the reply belongs elsewhere; `refusal: null` is a
 * failure in passing (the network, 401, 5xx): try again.
 */
export async function answerRunQuestion(runId: string, workspaceId: string | null, text: string): Promise<RunAnswerResult> {
  const answer = text.trim()
  if (!answer || !isId(runId) || typeof fetch !== 'function') return { ok: false, refusal: null }
  const route = `/api/account/agent-runs/${encodeURIComponent(runId)}`
  const refusalOf = async (res: Response): Promise<RunAnswerResult> => {
    if (!ANSWER_REFUSED.has(res.status)) return { ok: false, refusal: null }
    const detail = (await Promise.resolve(res.json?.()).catch(() => ({}))) as { code?: unknown } | undefined
    return { ok: false, refusal: { status: res.status, code: typeof detail?.code === 'string' ? detail.code : null } }
  }
  try {
    const read = await fetch(route, {
      credentials: 'include',
      cache: 'no-store',
      headers: workspaceId && isId(workspaceId) ? { 'x-workspace-id': workspaceId } : undefined,
    })
    if (!read.ok) return refusalOf(read)
    const { run } = ((await read.json().catch(() => ({}))) ?? {}) as { run?: { status?: unknown; pending_input?: unknown } }
    const questions = askedQuestions(run?.pending_input)
    if (run?.status !== 'needs_input' || questions.length === 0) {
      return { ok: false, refusal: { status: 409, code: 'NOT_NEEDS_INPUT' } }
    }
    const res = await fetch(`${route}/respond`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ question: questions.join(' / ').slice(0, 2000), answer: answer.slice(0, 2000) }] }),
    })
    return res.ok ? { ok: true } : refusalOf(res)
  } catch {
    return { ok: false, refusal: null }
  }
}

/** The questions a run's `pending_input` asks (none for a handoff to teammates, which no person answers). */
function askedQuestions(pending: unknown): string[] {
  if (!pending || typeof pending !== 'object') return []
  const p = pending as { kind?: unknown; questions?: unknown }
  if (p.kind === 'delegation' || !Array.isArray(p.questions)) return []
  return p.questions
    .map((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question.trim() : ''))
    .filter(Boolean)
}

/** What the chat route said no with (GET or POST /api/account/agent-runs/[id]/chat). */
export interface RunChatRefusal {
  status: number
  code: string | null
}

/**
 * The quiet line a bubble shows when an item's run chat can't be had, so the
 * reply goes to the teammate's own thread instead: who started it, or that
 * there's no chat to continue.
 */
export function runChatRefusalLine(refusal: RunChatRefusal, name: string): string {
  if (refusal.status === 403) return `Someone else started this run, so this goes to ${name}’s own chat.`
  if (refusal.code === 'NOT_TERMINAL') return `${name} is still on this, so this goes to ${name}’s own chat.`
  if (refusal.code === 'NOT_NEEDS_INPUT' || refusal.code === 'NO_PENDING_INPUT' || refusal.code === 'WAITING_ON_TEAMMATE') {
    return `This run isn’t waiting on an answer now, so this went to ${name}’s own chat.`
  }
  return `This run has no chat to continue, so this goes to ${name}’s own chat.`
}

/** The quiet line once a reply answered a run's question. */
export function runAnsweredLine(name: string): string {
  return `Answer sent. ${name} picks up from there.`
}

/** The item's title as an "About:" line shows it, at most this many characters. */
export const ABOUT_TITLE_CHARS = 120

/** `title` as one line, cut to ABOUT_TITLE_CHARS (an ellipsis when cut); `fallback` when blank. */
export function aboutTitle(title: string | null | undefined, fallback = 'this item'): string {
  const one = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return fallback
  return one.length <= ABOUT_TITLE_CHARS ? one : `${one.slice(0, ABOUT_TITLE_CHARS - 1).trimEnd()}…`
}
