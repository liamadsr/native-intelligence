/**
 * What the main agent does with the bots' work (docs/plans/bots-v4.md, "The
 * main agent talks to the bots", Phase A2): the writes behind the main chat's
 * `settle_work_item` and `send_work_answer` (src/lib/ai/tools/bot-work.ts).
 * "Mark Writer's draft reviewed" and "tell Researcher the deadline is Friday"
 * happen from the main chat, with the same effects as the person's click.
 *
 *   settleBotWorkItem      Reviewed or Dismiss on a review (a ledger row
 *                          waiting on review), through the item's own review
 *                          verbs' path (resolve.ts settleWorkReview, which the
 *                          activity PATCH runs): the row settles `done` with
 *                          its outcome, its handoffs waiting on review with it,
 *                          and its notices are read. Dismiss also stops waiting
 *                          on a question nobody can answer any more (its run is
 *                          gone, or no longer parked on it: the item's own
 *                          "Stop waiting", work/stale-questions.ts); a question
 *                          its run still waits on is refused (send_work_answer).
 *                          Dismiss on a Mail draft (`draft:<id>`, GEN-1165)
 *                          discards it from the mailbox and Native Intelligence with its
 *                          reason (src/lib/email/discard-drafts.ts, exactly
 *                          discard_email_draft's path); Reviewed on one is
 *                          refused: a draft is settled by sending or
 *                          discarding it.
 *   answerBotWorkQuestion  the answer to a question a work run is waiting on,
 *                          through the run's respond path
 *                          (agent-run/respond-to-run.ts respondToWorkRun, which
 *                          POST /api/account/agent-runs/[id]/respond runs): one
 *                          free-text answer to every question it asks, as a
 *                          reply in the bot's bubble sends it
 *                          (item-run-chat.ts answerRunQuestion). The item is
 *                          then opened, as the bubble's answer opens it
 *                          (resolve.ts markOpened, markItemNoticesRead), so its
 *                          bot stops calling for it and its notice is read.
 *
 * So the item leaves the bubble and the bot's page and the dot clears as if
 * the person had clicked: the writes are the clicks' own, and the realtime
 * UPDATEs on `tracked_job` and `notification` carry them to every open window.
 *
 * Which items. Only the ids list_bot_work and get_bot_item give, and only
 * the caller's own: findOwnItem (bot-work-server.ts), the fence get_bot_item
 * reads through, on the tool routes' SERVICE client: the row's member is the
 * caller's own member row in the row's workspace, and its bot is one they may
 * talk to (a private team's bot they aren't on is not found). A card, a run's
 * cards (`work:` / `run:`) or a row that isn't waiting on what the tool does
 * is refused, saying which tool it takes. Every reply names what changed:
 * which item (its id and title) and which bot. The title is run-written, so
 * the lines a model reads (`said`, the refusals) carry it fenced
 * (`<teammate-text>`), never bare; the tool fences the `title` field too.
 *
 * No model is called: every line is a template.
 */
import { isBatchKey } from './batch'
import { fenceTeammateText } from '@/lib/chat/teammate-report'
import { findOwnDraft, findOwnItem, type BotRef, type BotWorkCaller, type OwnItemRow } from './bot-work-server'
import { AGENT_DRAFT_ITEM_PREFIX, agentDraftSentence } from '@/lib/email/agent-drafts'
import { discardEmailDrafts } from '@/lib/email/discard-drafts'
import type { DraftDismissReason } from '@/lib/evals/flywheel/types'
import { markItemNoticesRead, markOpened, settleWorkReview } from '@/lib/work/resolve'
import { stopWaitingOnQuestion } from '@/lib/work/stale-questions'
import { WORK_TERMINAL_STATUSES } from '@/lib/work/types'
import { MAX_ANSWER_CHARS, pendingQuestionTexts, respondToWorkRun, type RespondRefusalCode } from '@/lib/agent-run/respond-to-run'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL = new Set<string>(WORK_TERMINAL_STATUSES)
/** A title in a reply, at most this many characters. */
const TITLE_MAX = 120

export type BotWorkActCode =
  | 'INPUT_INVALID'
  | 'NOT_FOUND'
  | 'NOT_A_REVIEW'
  | 'NOT_A_QUESTION'
  | 'NOT_WAITING'
  | 'WAITING_ON_TEAMMATE'
  | 'NOT_YOURS_TO_ANSWER'
  | 'WRITE_FAILED'
  /** An approval card (A5): only the person settles it, on the card. */
  | 'APPROVAL_PERSON_ONLY'

export type BotWorkActResult<T> = { ok: true; value: T } | { ok: false; code: BotWorkActCode; error: string }

/** The item a write touched, as its reply names it. */
export interface ActedItem {
  item_id: string
  title: string
  /** The bot it's from; null for work no bot speaks for. */
  bot: Pick<BotRef, 'bot_id' | 'name'> | null
  /** Its workspace (the item's own, which may not be the chat's). */
  workspace_id: string
}

export interface SettledWorkItem extends ActedItem {
  /** False: it was already settled, and nothing changed. */
  changed: boolean
  outcome: 'reviewed' | 'dismissed'
  /** A Mail draft's dismissal: whether its mailbox copy went too ('none': it had none; 'not_found': the mailbox no longer had it under Native Intelligence's id). */
  mailbox?: 'deleted' | 'none' | 'not_found'
  /** Its status now. */
  status: string
  /** Handoffs waiting on review, settled with it. */
  handoffs_settled: number
  /** Its notices, now read. */
  notices_read: number
  /** What changed, in one line, to say back. */
  said: string
}

export interface AnsweredWorkItem extends ActedItem {
  /** The run that was waiting: it picks up from here. */
  run_id: string
  /** What it asked. */
  questions: string[]
  /** What was sent. */
  answer: string
  /** Its notices, now read. */
  notices_read: number
  said: string
}

export const SETTLE_WORK_ACTIONS = ['reviewed', 'dismiss'] as const
export type SettleWorkAction = (typeof SETTLE_WORK_ACTIONS)[number]

function refuse(code: BotWorkActCode, error: string): { ok: false; code: BotWorkActCode; error: string } {
  return { ok: false, code, error }
}

const NOT_FOUND = refuse('NOT_FOUND', 'No item of yours with that id: list_bot_work gives the ids.')

function oneLine(title: string | null | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return 'this item'
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

function acted(row: OwnItemRow, bot: BotRef | null): ActedItem {
  return {
    item_id: row.id,
    title: oneLine(row.title),
    bot: bot ? { bot_id: bot.bot_id, name: bot.name } : null,
    workspace_id: row.workspace_id,
  }
}

/**
 * "Writer's <teammate-text>Reply to Alex</teammate-text>", or the fenced title
 * alone for work no bot speaks for. The title is run-written, so every line a
 * model reads here (the `said` line, a refusal) fences it, as teammate reports
 * do (fenceTeammateText); the bot's name is the workspace's.
 */
function whose(item: ActedItem): string {
  const title = fenceTeammateText(item.title)
  return item.bot ? `${item.bot.name}'s ${title}` : title
}

/** The id as the tools take it, or why not. */
function itemIdOf(raw: string): { id: string } | { ok: false; code: BotWorkActCode; error: string } {
  const id = raw.trim()
  if (isBatchKey(id)) {
    return refuse(
      'INPUT_INVALID',
      "That id is a run's cards, not one item: read them with get_bot_item, then settle each card by its card_id with settle_card.",
    )
  }
  if (!UUID.test(id)) return refuse('INPUT_INVALID', 'item_id is an item id from list_bot_work.')
  return { id }
}

function failed(what: string, err: unknown): { ok: false; code: 'WRITE_FAILED'; error: string } {
  console.error(`[bot-work] ${what} failed:`, err instanceof Error ? err.message : err)
  return { ok: false, code: 'WRITE_FAILED', error: 'Could not do that right now: nothing was changed.' }
}

// ── Reviewed or Dismiss ──────────────────────────────────────────────────────

/**
 * Reviewed or Dismiss on one of the caller's reviews, as their click would (see
 * the header). `reason`: why a Mail draft is dismissed (its label for the
 * drafting passes); read for a draft only, 'other' when not given.
 */
export async function settleBotWorkItem(
  caller: BotWorkCaller,
  itemId: string,
  action: SettleWorkAction,
  opts: { reason?: DraftDismissReason } = {},
): Promise<BotWorkActResult<SettledWorkItem>> {
  if (action !== 'reviewed' && action !== 'dismiss') return refuse('INPUT_INVALID', "action is 'reviewed' or 'dismiss'.")
  if (itemId.trim().startsWith(AGENT_DRAFT_ITEM_PREFIX)) return settleDraft(caller, itemId.trim(), action, opts.reason ?? 'other')
  const checked = itemIdOf(itemId)
  if (!('id' in checked)) return checked
  const outcome = action === 'reviewed' ? 'reviewed' : 'dismissed'
  try {
    const own = await findOwnItem(caller, checked.id)
    if (!own) return NOT_FOUND
    if (own.kind === 'card' && own.card.kind === 'approval') {
      return refuse('APPROVAL_PERSON_ONLY', "That's an approval card: only the person can approve or decline it, on the card itself.")
    }
    if (own.kind === 'card') {
      return refuse('NOT_A_REVIEW', "That's a card, not a review: settle it with settle_card (accept, dismiss or start).")
    }
    const { row, bot } = own
    const item = acted(row, bot)
    if (row.status === 'needs_input') {
      if (action === 'dismiss') return stopWaiting(caller, row, item)
      return refuse(
        'NOT_A_REVIEW',
        `${whose(item)} is waiting on an answer, not a review: send their answer with send_work_answer (if its run is gone, dismiss stops waiting on it).`,
      )
    }
    if (TERMINAL.has(row.status)) return { ok: true, value: unchanged(item, outcome, row.status) }
    if (row.status !== 'needs_review') {
      return refuse('NOT_WAITING', `${whose(item)} isn't waiting on a review: it is still ${row.status === 'waiting_on_child' ? 'waiting on a teammate it handed work to' : 'running'}.`)
    }

    // The item's own review verbs' path (the activity PATCH's), fenced on its member.
    const done = await settleWorkReview(caller.supabase, row, outcome)
    if (!done.changed) {
      // Lost the race to another settle (another window, the deliverable's own
      // surface), or the write failed: say which, from what is stored now.
      const now = await caller.supabase.from('tracked_job').select('status').eq('id', row.id).eq('member_id', row.member_id).maybeSingle()
      const status = (now.data as { status?: string } | null)?.status
      if (status && TERMINAL.has(status)) return { ok: true, value: unchanged(item, outcome, status) }
      return failed('settle', now.error ?? 'the review did not settle')
    }
    const also = done.handoffs > 0 ? `, and ${done.handoffs === 1 ? 'the handoff' : `the ${done.handoffs} handoffs`} under it` : ''
    return {
      ok: true,
      value: {
        ...item,
        changed: true,
        outcome,
        status: 'done',
        handoffs_settled: done.handoffs,
        notices_read: done.noticesRead,
        said: outcome === 'reviewed' ? `Marked ${whose(item)} reviewed${also}.` : `Dismissed ${whose(item)}${also}.`,
      },
    }
  } catch (err) {
    return failed('settle', err)
  }
}

/**
 * Dismiss on a Mail draft: discarded from the mailbox and Native Intelligence, with its
 * reason (discardEmailDrafts, the fence findOwnDraft's); Reviewed is refused.
 */
async function settleDraft(
  caller: BotWorkCaller,
  itemId: string,
  action: SettleWorkAction,
  reason: DraftDismissReason,
): Promise<BotWorkActResult<SettledWorkItem>> {
  try {
    const own = await findOwnDraft(caller, itemId)
    if (!own) return NOT_FOUND
    const item: ActedItem = {
      item_id: itemId,
      title: oneLine(agentDraftSentence({ to: own.to_emails?.[0] ?? null, subject: own.subject?.trim() || null })),
      bot: own.bot ? { bot_id: own.bot.bot_id, name: own.bot.name } : null,
      workspace_id: own.workspace_id,
    }
    if (action === 'reviewed') {
      return refuse(
        'NOT_A_REVIEW',
        `${whose(item)} is an email draft waiting in Mail: it is settled by sending it (their click in Mail) or discarding it (dismiss), never marked reviewed.`,
      )
    }
    const done = await discardEmailDrafts(caller.supabase, caller.userId, { draftIds: [own.id], reason, by: 'agent' })
    const result = done.results[0]
    if (result?.discarded) {
      return {
        ok: true,
        value: {
          ...item,
          changed: true,
          outcome: 'dismissed',
          status: 'discarded',
          mailbox: result.mailbox,
          handoffs_settled: 0,
          notices_read: 0,
          said:
            result.mailbox === 'not_found'
              ? `Discarded ${whose(item)} in Native Intelligence. ${result.note ?? ''} Nothing was sent.`.replace(/\s+/g, ' ')
              : `Discarded ${whose(item)}${result.mailbox === 'deleted' ? ', in Native Intelligence and in their mailbox' : ' in Native Intelligence'}. Nothing was sent.`,
        },
      }
    }
    if (result?.code === 'ALREADY_SETTLED') return { ok: true, value: unchanged(item, 'dismissed', own.status) }
    if (result?.code === 'MAILBOX_FAILED') return refuse('WRITE_FAILED', result.error)
    return failed('discard', result && !result.discarded ? result.error : done.message)
  } catch (err) {
    return failed('discard', err)
  }
}

/**
 * Dismiss on a question: stop waiting on it when its run is gone or no longer
 * parked on it (stale-questions.ts stopWaitingOnQuestion, the item's own
 * "Stop waiting"); a question its run still waits on is refused.
 */
async function stopWaiting(caller: BotWorkCaller, row: OwnItemRow, item: ActedItem): Promise<BotWorkActResult<SettledWorkItem>> {
  const result = await stopWaitingOnQuestion(caller.supabase, row)
  if (result.outcome === 'live') {
    return refuse(
      'NOT_A_REVIEW',
      `${whose(item)} is a question its run is still waiting on: send their answer with send_work_answer. It can't be dismissed while the run waits.`,
    )
  }
  if (result.outcome === 'not_waiting') {
    if (TERMINAL.has(result.status)) return { ok: true, value: unchanged(item, 'dismissed', result.status) }
    return failed('stop waiting', `the question did not settle (${result.status})`)
  }
  return {
    ok: true,
    value: {
      ...item,
      changed: true,
      outcome: 'dismissed',
      status: result.status,
      handoffs_settled: 0,
      notices_read: 0,
      said:
        result.status === 'running'
          ? `${whose(item)} wasn't waiting on an answer any more: its run picked the work back up.`
          : result.status === 'needs_review'
            ? `${whose(item)} wasn't waiting on an answer any more: its run had finished, and its result now waits on their review.`
            : `Stopped waiting on ${whose(item)}: the run that asked it is gone or already finished.`,
    },
  }
}

function unchanged(item: ActedItem, outcome: 'reviewed' | 'dismissed', status: string): SettledWorkItem {
  return {
    ...item,
    changed: false,
    outcome,
    status,
    handoffs_settled: 0,
    notices_read: 0,
    said: `Nothing changed: ${whose(item)} was already settled (${status}).`,
  }
}

// ── An answer ────────────────────────────────────────────────────────────────

/** The run a row's question belongs to: its column, else what the mirror wrote in `source`. */
function runIdOf(row: Pick<OwnItemRow, 'agent_run_id' | 'source'>): string | null {
  if (typeof row.agent_run_id === 'string' && row.agent_run_id) return row.agent_run_id
  const fromSource = row.source?.agent_run_id
  return typeof fromSource === 'string' && fromSource ? fromSource : null
}

/** A question whose run is gone: nothing to answer, and how to clear it. */
const GONE_HINT = (item: ActedItem) =>
  `The run that asked ${whose(item)} is gone, so nothing was sent. settle_work_item dismiss stops waiting on it.`

/** What respondToWorkRun's refusals mean here. */
function respondRefusal(code: RespondRefusalCode, item: ActedItem, detail?: string): { ok: false; code: BotWorkActCode; error: string } {
  switch (code) {
    case 'NOT_FOUND':
    case 'NOT_MEMBER':
      return NOT_FOUND
    case 'NOT_STARTER':
      return refuse('NOT_YOURS_TO_ANSWER', `Someone else started the run behind ${whose(item)}, so only they can answer it.`)
    case 'WAITING_ON_TEAMMATE':
      return refuse('WAITING_ON_TEAMMATE', `${whose(item)} is waiting on a teammate it handed work to, not on an answer.`)
    case 'INVALID_KIND':
      return refuse('NOT_A_QUESTION', `${whose(item)} can't be answered from here: open it on its agent's page.`)
    case 'NOT_NEEDS_INPUT':
    case 'NO_PENDING_INPUT':
      return refuse('NOT_WAITING', `${whose(item)} isn't waiting on an answer any more: nothing was sent. settle_work_item dismiss stops waiting on it.`)
    default:
      return failed('answer', detail ?? code)
  }
}

/** The person's answer to a question one of their bots' runs is waiting on (see the header). */
export async function answerBotWorkQuestion(
  caller: BotWorkCaller,
  itemId: string,
  answerText: string,
): Promise<BotWorkActResult<AnsweredWorkItem>> {
  const answer = (answerText ?? '').trim()
  if (!answer) return refuse('INPUT_INVALID', 'answer is the person’s answer, in their words.')
  if (answer.length > MAX_ANSWER_CHARS) return refuse('INPUT_INVALID', `answer is at most ${MAX_ANSWER_CHARS} characters.`)
  const checked = itemIdOf(itemId)
  if (!('id' in checked)) return checked
  const { supabase, userId } = caller
  try {
    const own = await findOwnItem(caller, checked.id)
    if (!own) return NOT_FOUND
    if (own.kind === 'card' && own.card.kind === 'approval') {
      return refuse('APPROVAL_PERSON_ONLY', "That's an approval card: only the person can approve or decline it, on the card itself. Nothing was sent.")
    }
    if (own.kind === 'card') {
      return refuse(
        'NOT_A_QUESTION',
        own.card.kind === 'question'
          ? "That's a question card: no run is waiting on an answer to it. settle_card with accept acknowledges it."
          : "That's a card, not a question: settle it with settle_card.",
      )
    }
    const { row, bot } = own
    const item = acted(row, bot)
    if (row.status === 'needs_review') {
      return refuse('NOT_A_QUESTION', `${whose(item)} is waiting on a review, not an answer: settle_work_item marks it reviewed or dismisses it.`)
    }
    if (row.status === 'waiting_on_child') {
      return refuse('WAITING_ON_TEAMMATE', `${whose(item)} is waiting on a teammate it handed work to, not on an answer.`)
    }
    if (row.status !== 'needs_input') {
      return refuse('NOT_WAITING', `${whose(item)} isn't waiting on an answer (it is ${row.status}).`)
    }
    const runId = runIdOf(row)
    if (!row.agent_run_id && row.kind === 'work_run') return refuse('NOT_WAITING', GONE_HINT(item))
    if (row.kind !== 'work_run' || !runId) {
      return refuse('NOT_A_QUESTION', `${whose(item)} can't be answered from here: open it on its agent's page.`)
    }

    // What the run asks, from the run itself in the row's workspace (the
    // bubble's reply reads it the same way before it answers).
    const runRead = await supabase
      .from('agent_run')
      .select('id, workspace_id, status, triggered_by, pending_input')
      .eq('id', runId)
      .eq('workspace_id', row.workspace_id)
      .maybeSingle()
    if (runRead.error) throw new Error(`run: ${runRead.error.message}`)
    const run = runRead.data as { id: string; status: string; triggered_by: string | null; pending_input: unknown } | null
    if (!run) return refuse('NOT_WAITING', GONE_HINT(item))
    if (run.triggered_by !== userId) return respondRefusal('NOT_STARTER', item)
    const pending = run.pending_input as { kind?: unknown } | null
    if (pending && typeof pending === 'object' && pending.kind === 'delegation') return respondRefusal('WAITING_ON_TEAMMATE', item)
    const questions = pendingQuestionTexts(run.pending_input)
    if (run.status !== 'needs_input' || questions.length === 0) return respondRefusal('NOT_NEEDS_INPUT', item)

    // The respond route's own path: every check again, the CAS, the resume.
    const sent = await respondToWorkRun(supabase, {
      userId,
      runId,
      response: { answers: [{ question: questions.join(' / ').slice(0, MAX_ANSWER_CHARS), answer }] },
    })
    if (!sent.ok) return respondRefusal(sent.code, item, sent.error)

    // Answered is opened (the bubble stamps its item opened when it answers):
    // its bot stops calling for it, and its notice is read.
    const nowIso = new Date().toISOString()
    await markOpened(supabase, row, { nowIso })
    const noticesRead = await markItemNoticesRead(supabase, row, { nowIso })
    // A fallback row (a teammate the caller can't reach, shown with the
    // Assistant) resumes as that teammate's run, so no bot is named.
    const speaker = own.fallback ? undefined : item.bot?.name
    return {
      ok: true,
      value: {
        ...item,
        run_id: runId,
        questions,
        answer,
        notices_read: noticesRead,
        said: speaker
          ? `Sent your answer to ${whose(item)}. ${speaker} picks up from there.`
          : `Sent your answer to ${whose(item)}. The run picks up from there.`,
      },
    }
  } catch (err) {
    return failed('answer', err)
  }
}
