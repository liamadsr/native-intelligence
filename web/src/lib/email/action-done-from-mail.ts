/**
 * Arriving mail marks a matching open to-do done (migration 450; Liam,
 * 2026-10-27: a meeting prep said the rental car "still isn't handled" while
 * three Enterprise confirmations sat in the inbox, because nothing ever put
 * the mail beside the board).
 *
 * The arrival pass (./understand-arrivals.ts) hands over each thread
 * email.understand read as a confirmation-like kind (DONE_EVIDENCE_KINDS: a
 * receipt, a booking, a delivery, an account notice, another automated
 * notice; never a conversation or a newsletter) that carries no trust mark
 * and sits in the inbox or the archive (EVIDENCE_FOLDERS: never spam, where
 * the provider files a sender that fails its checks, nor trash). Dial8 reads
 * no sender authentication of its own, so the provider's filing is the check.
 * Jev's action.done_by_email puts its newest messages beside the person's own
 * open to-dos and picks the one it clearly settles, or none (the bar is
 * higher than a plain pick: ../ai/decisions/tasks/action-done-by-email.ts).
 *
 * The to-dos: the person's own to-do list in the push's workspace (decision
 * 3: the mail's own workspace, never another), as ../actions/open-work.ts
 * defines it (assigned to them, top level, accepted, in an open state),
 * created before the newest message (a to-do made from this very mail is not
 * settled by it); never one mail closed before (a to-do the person reopened,
 * by Undo or by hand, stays open), and never one linked to Linear, Jira or
 * Asana (their status echoes would carry the close out of Dial8, past Undo).
 * And only while the person has a home thread: Undo lives there.
 *
 * Closing: one action_mail_done row first (unique per to-do: a retried pass
 * closes nothing twice), then the to-do moves to its team's done state only
 * while it still sits where it was read (another change in between wins, and
 * the row goes). The status change fires flows as an agent's would (a flow
 * opts in to those), never as the person's. Then ONE message in the home
 * thread says so, with Undo (./action-done-part.ts), and the agent's log gets
 * a line. Apply with undo, not an approval queue (Liam, 2026-10-20), and no
 * setting: Undo is the control. At most MAX_CLOSED_PER_PASS a pass.
 *
 * Undo (undoActionDoneFromMail, the chip's button) puts the to-do back where
 * the row says it was, and only while it is still in the done state mail put
 * it in; moved since, it is left where the person put it. Either way the row
 * stays, so mail never closes that to-do again.
 *
 * Until migration 450 is applied the reads fail and nothing closes. Never
 * throws into the arrival pass.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import {
  ACTION_DONE_BODY_MAX,
  ACTION_DONE_MAX_TODOS,
  ACTION_DONE_MESSAGES,
  type ActionDoneByEmailInput,
  type ActionDoneByEmailValue,
} from '@/lib/ai/decisions/tasks/action-done-by-email'
import type { EmailKind } from '@/lib/ai/decisions/tasks/email-understand'
import { OPEN_WORK_ASSIGNEE_EMBED, filterOpenWork, loadClosedStates } from '@/lib/actions/open-work'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
import { homeConversationId } from './auto-archive'
import type { EmailMessageForAI } from './email-read-service'
import { mailboxAddresses } from './reply-policy'
import {
  ACTION_DONE_MESSAGE_KIND,
  ACTION_DONE_PART_TYPE,
  ACTION_DONE_TITLE_MAX,
  actionDoneMessageId,
  senderDomainOf,
  type ActionDonePartData,
} from './action-done-part'

/** What email.understand calls mail that can confirm something was done. */
export const DONE_EVIDENCE_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>(['receipt_or_bill', 'meeting', 'delivery', 'account_or_security', 'other_notice'])
/**
 * Where the thread must sit: mail the provider left in the inbox, or the
 * person's own filters archived. Spam (where a spoofed sender lands), trash,
 * sent mail and drafts never close anything.
 */
export const EVIDENCE_FOLDERS: ReadonlySet<string> = new Set(['inbox', 'archive'])
/** At most this many to-dos closed by one arrival pass (a flood of confirmations waits for Undo, not a sweep). */
export const MAX_CLOSED_PER_PASS = 3
/** Open to-dos read for the person, the most recently touched first (before the created-after filter). */
const TODO_ROWS = 60
/** The decision's input, as JSON, within the task's state budget (its option keys and note ride on top). */
const INPUT_BUDGET = 20_000
/** A to-do's description in the input. */
const DETAILS_MAX = 240

const TABLE = 'action_mail_done'

/** A read or write that failed because migration 450 isn't applied yet. */
function isPre450Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, TABLE)
}

export interface MailDoneScope {
  workspaceId: string
  userId: string
}

/** One of the person's open to-dos, as a pass reads it. */
export interface OpenTodo {
  id: string
  identifier: string | null
  title: string
  description: string | null
  dueAt: string | null
  teamId: string
  statusId: string
  createdAt: string | null
}

/**
 * The person's open to-dos in the workspace that mail may close (see the
 * header), the most recently touched first. Null when they can't be read
 * (migration 450 not applied, a failed read): the pass closes nothing.
 */
export async function readOpenTodos(supabase: SupabaseClient, scope: MailDoneScope): Promise<OpenTodo[] | null> {
  try {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', scope.workspaceId)
      .eq('user_id', scope.userId)
      .maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (memberError || typeof memberId !== 'string') return null
    const closedStates = await loadClosedStates(supabase, scope.workspaceId)
    // The person's to-do list: open-work.ts's one definition, closed states left out in the query.
    const { data, error } = await filterOpenWork(
      supabase
        .from('actions')
        .select(`id, identifier, title, description, due_at, team_id, status_id, created_at, is_dismissed, ${OPEN_WORK_ASSIGNEE_EMBED}`)
        .eq('workspace_id', scope.workspaceId),
      { confirmedOnly: true, closedStateIds: closedStates.ids, memberId },
    )
      .order('updated_at', { ascending: false })
      .limit(TODO_ROWS)
    if (error) return null
    const open = ((data as Array<Record<string, unknown>> | null) ?? []).flatMap((r): OpenTodo[] => {
      if (r.is_dismissed === true) return []
      if (typeof r.id !== 'string' || typeof r.title !== 'string' || !r.title.trim() || typeof r.team_id !== 'string' || typeof r.status_id !== 'string') return []
      return [{
        id: r.id,
        identifier: typeof r.identifier === 'string' ? r.identifier : null,
        title: r.title,
        description: typeof r.description === 'string' ? r.description : null,
        dueAt: typeof r.due_at === 'string' ? r.due_at : null,
        teamId: r.team_id,
        statusId: r.status_id,
        createdAt: typeof r.created_at === 'string' ? r.created_at : null,
      }]
    })
    if (!open.length) return []
    const ids = open.map((t) => t.id)
    // Never one mail closed before (also how a pass finds 450 missing), and never one
    // linked to Linear, Jira or Asana: their echoes would carry the close out of Dial8.
    const [{ data: closed, error: closedError }, { data: linked, error: linkedError }] = await Promise.all([
      supabase.from(TABLE).select('action_id').in('action_id', ids),
      supabase.from('action_external_task').select('action_id').eq('workspace_id', scope.workspaceId).in('action_id', ids),
    ])
    if (closedError || linkedError) {
      if (closedError && !isPre450Error(closedError)) console.warn('[action-done-from-mail] closed to-dos not read:', closedError.message)
      if (linkedError) console.warn('[action-done-from-mail] linked to-dos not read:', linkedError.message)
      return null
    }
    const off = new Set([...((closed as Array<{ action_id?: unknown }> | null) ?? []), ...((linked as Array<{ action_id?: unknown }> | null) ?? [])].map((r) => r.action_id))
    return open.filter((t) => !off.has(t.id))
  } catch (err) {
    console.warn('[action-done-from-mail] to-dos not read:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Squash a to-do's description for the state: one line, clipped. */
function oneLine(text: string | null, max: number): string | undefined {
  const s = (text ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

/**
 * action.done_by_email's input for a thread and the person's open to-dos: the
 * newest messages (drafts left out), oldest first, each body clipped; the
 * to-dos created before the newest message, at most ACTION_DONE_MAX_TODOS,
 * the least recently touched dropped first until it fits the budget. Null
 * when there is no message, the newest is the person's own, or no to-do is
 * left. Pure.
 */
export function doneInput(args: { mailbox: string; now: string; messages: readonly EmailMessageForAI[]; todos: readonly OpenTodo[] }): ActionDoneByEmailInput | null {
  const own = mailboxAddresses(args.mailbox)[0] ?? args.mailbox.trim().toLowerCase()
  const sent = args.messages.filter((m) => !m.isDraft)
  const latest = sent.at(-1)
  if (!latest || mailboxAddresses(latest.from)[0] === own) return null
  const latestMs = Date.parse(latest.dateISO ?? latest.date)
  const todos = args.todos
    .filter((t) => !Number.isFinite(latestMs) || !t.createdAt || !(Date.parse(t.createdAt) >= latestMs))
    .slice(0, ACTION_DONE_MAX_TODOS)
  if (!todos.length) return null
  const input: ActionDoneByEmailInput = {
    now: args.now.slice(0, 100),
    messages: sent.slice(-ACTION_DONE_MESSAGES).map((m) => {
      const from = mailboxAddresses(m.from)[0] ?? null
      return {
        from: m.from.slice(0, 500),
        direction: from === null ? ('unknown' as const) : from === own ? ('outbound' as const) : ('inbound' as const),
        date: (m.dateISO ?? m.date).slice(0, 100),
        subject: (m.subject ?? '').slice(0, 1000),
        body: (m.bodyText ?? '').slice(0, ACTION_DONE_BODY_MAX),
      }
    }),
    todos: todos.map((t) => {
      const details = oneLine(t.description, DETAILS_MAX)
      return {
        id: t.id,
        title: t.title.trim().slice(0, 300),
        ...(details ? { details } : {}),
        ...(t.dueAt && /^\d{4}-\d{2}-\d{2}/.test(t.dueAt) ? { due: t.dueAt.slice(0, 10) } : {}),
      }
    }),
  }
  while (input.todos.length > 1 && JSON.stringify(input).length > INPUT_BUDGET) input.todos = input.todos.slice(0, -1)
  return JSON.stringify(input).length > INPUT_BUDGET ? { ...input, messages: input.messages.map((m) => ({ ...m, body: m.body.slice(0, 1_000) })) } : input
}

/**
 * Write (or rewrite, on Undo) a close's message in the home thread: one data
 * part, the server's own words. Never throws: a lost message leaves the log
 * line, and the to-do still reopens from its own page.
 */
export async function writeActionDoneMessage(
  supabase: SupabaseClient,
  scope: MailDoneScope & { conversationId: string },
  data: ActionDonePartData,
): Promise<boolean> {
  try {
    const messageId = actionDoneMessageId(data.record_id)
    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: scope.conversationId,
        user_id: scope.userId,
        workspace_id: scope.workspaceId,
        role: 'assistant',
        ui_message: {
          id: messageId,
          role: 'assistant',
          parts: [{ type: ACTION_DONE_PART_TYPE, id: messageId, data }],
          metadata: { kind: ACTION_DONE_MESSAGE_KIND, record_id: data.record_id, action_id: data.action_id },
        },
      },
      { onConflict: 'conversation_id,ui_message_id' },
    )
    if (error) {
      console.warn('[action-done-from-mail] message not written:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[action-done-from-mail] message not written:', err instanceof Error ? err.message : String(err))
    return false
  }
}

export interface MailDoneDeps {
  writeMessage?: typeof writeActionDoneMessage
  appendLog?: typeof appendLogLine
  emit?: typeof emitStatusChange
  homeThread?: (supabase: SupabaseClient, scope: MailDoneScope) => Promise<string | null>
}

export type CloseResult =
  | { status: 'closed'; recordId: string }
  /** Mail closed it before; it moved since it was read; no done state; 450 missing; a failed write. */
  | { status: 'already' | 'moved' | 'no_done_state' | 'unavailable' | 'failed' }

/** The team's done state (its first `completed` one), or null. */
async function doneStateOf(supabase: SupabaseClient, teamId: string): Promise<string | null> {
  const { data } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('category', 'completed')
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle()
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/**
 * Mark one to-do done for the mail that settles it (see the header): the
 * row, the move, the message and the log line. Never throws.
 */
export async function closeTodoFromMail(
  supabase: SupabaseClient,
  args: MailDoneScope & {
    /** The person's home thread, where its Undo goes: no thread, no close. */
    conversationId: string
    todo: OpenTodo
    accountId: string | null
    threadId: string
    messageId: string
    from: string | null
    nowMs?: number
  },
  deps: MailDoneDeps = {},
): Promise<CloseResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString()
  try {
    const doneStatusId = await doneStateOf(supabase, args.todo.teamId)
    if (!doneStatusId) return { status: 'no_done_state' }
    const senderDomain = senderDomainOf(args.from)
    const { data: row, error: insertError } = await supabase
      .from(TABLE)
      .insert({
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        action_id: args.todo.id,
        prior_status_id: args.todo.statusId,
        done_status_id: doneStatusId,
        account_id: args.accountId,
        thread_id: args.threadId.slice(0, 500),
        message_id: args.messageId.slice(0, 500),
        sender_domain: senderDomain,
      })
      .select('id')
      .single()
    if (insertError) {
      if (insertError.code === '23505') return { status: 'already' }
      if (isPre450Error(insertError)) return { status: 'unavailable' }
      console.warn('[action-done-from-mail] row not written:', insertError.message)
      return { status: 'failed' }
    }
    const recordId = (row as { id: string }).id

    // Only while it sits where it was read: a change in between wins.
    const { data: moved, error: moveError } = await supabase
      .from('actions')
      .update({ status_id: doneStatusId })
      .eq('id', args.todo.id)
      .eq('workspace_id', scope.workspaceId)
      .eq('status_id', args.todo.statusId)
      .select('id')
    if (moveError || !(moved as unknown[] | null)?.length) {
      await supabase.from(TABLE).delete().eq('id', recordId)
      if (moveError) console.warn('[action-done-from-mail] to-do not moved:', moveError.message)
      return { status: moveError ? 'failed' : 'moved' }
    }

    // As an agent's change: a flow fires on it only when it opts in to those.
    ;(deps.emit ?? emitStatusChange)({
      entityType: 'action',
      entityId: args.todo.id,
      workspaceId: scope.workspaceId,
      teamId: args.todo.teamId,
      fromStatusId: args.todo.statusId,
      toStatusId: doneStatusId,
      actorUserId: scope.userId,
      origin: { actor: 'agent', depth: 1 },
    })

    await (deps.writeMessage ?? writeActionDoneMessage)(supabase, { ...scope, conversationId: args.conversationId }, {
      record_id: recordId,
      action_id: args.todo.id,
      identifier: args.todo.identifier,
      title: args.todo.title.trim().slice(0, ACTION_DONE_TITLE_MAX),
      sender_domain: senderDomain,
    })
    const line = logLineFor({ type: 'action_done_from_mail', identifier: args.todo.identifier, title: args.todo.title, from: senderDomain })
    if (line) {
      await (deps.appendLog ?? appendLogLine)(
        { ...scope, kind: line.kind, line: line.line, refType: 'action', refId: args.todo.id, dedupeKey: logDedupeKey.actionDoneFromMail(recordId), at: nowIso },
        supabase,
      )
    }
    return { status: 'closed', recordId }
  } catch (err) {
    console.warn('[action-done-from-mail] close skipped:', err instanceof Error ? err.message : String(err))
    return { status: 'failed' }
  }
}

/** What one arrival pass needs to put mail beside the person's to-dos. */
export interface MailDonePass {
  /**
   * Put one understood thread beside the open to-dos, and close the one it
   * settles. 'skipped': not a confirmation-like kind, no to-do left, the
   * pass's cap reached, or the to-dos can't be read. Never throws.
   */
  consider(args: {
    kind: EmailKind | null
    trust: string | null
    /** The index's folder for the thread: inbox or archive only (never spam, trash, sent or a draft). */
    folder: string | null
    threadId: string
    messageId: string
    messages: readonly EmailMessageForAI[]
    runId: string
  }): Promise<'closed' | 'none' | 'skipped'>
  closed(): number
}

export interface MailDonePassDeps extends MailDoneDeps {
  readTodos?: typeof readOpenTodos
  decide?: (input: ActionDoneByEmailInput, ctx: { userId: string; workspaceId: string; runId: string }) => Promise<DecisionResult<ActionDoneByEmailValue>>
  close?: typeof closeTodoFromMail
  nowMs?: number
}

/**
 * One arrival pass's closer: the to-dos are read once, on the first thread
 * that could settle one, and a closed one leaves the list.
 */
export function mailDonePass(
  supabase: SupabaseClient,
  scope: MailDoneScope & { accountId: string | null; mailbox: string; now: string },
  deps: MailDonePassDeps = {},
): MailDonePass {
  let todos: OpenTodo[] | null | undefined
  let home: string | null = null
  let closedCount = 0
  const decide = deps.decide ?? ((input, ctx) => runDecision('action.done_by_email', input, ctx))
  return {
    closed: () => closedCount,
    async consider(args) {
      try {
        if (!args.kind || !DONE_EVIDENCE_KINDS.has(args.kind) || args.trust || closedCount >= MAX_CLOSED_PER_PASS) return 'skipped'
        if (!args.folder || !EVIDENCE_FOLDERS.has(args.folder)) return 'skipped'
        if (todos === undefined) {
          // Undo lives in the home thread: none yet (or unreadable), nothing closes.
          home = await (deps.homeThread ?? homeConversationId)(supabase, scope).catch(() => null)
          todos = home ? await (deps.readTodos ?? readOpenTodos)(supabase, scope) : null
        }
        if (!todos?.length || !home) return 'skipped'
        const input = doneInput({ mailbox: scope.mailbox, now: scope.now, messages: args.messages, todos })
        if (!input) return 'skipped'
        const decided = await decide(input, { userId: scope.userId, workspaceId: scope.workspaceId, runId: args.runId })
        if (decided.status !== 'accepted' || !decided.value.actionId) return 'none'
        const todo = todos.find((t) => t.id === decided.value.actionId)
        if (!todo) return 'none'
        const latest = args.messages.filter((m) => !m.isDraft).at(-1)
        const result = await (deps.close ?? closeTodoFromMail)(
          supabase,
          { ...scope, conversationId: home, todo, accountId: scope.accountId, threadId: args.threadId, messageId: args.messageId, from: latest?.from ?? null, nowMs: deps.nowMs },
          deps,
        )
        // Closed, or no longer closable by mail: either way it leaves the list.
        if (result.status === 'closed' || result.status === 'already' || result.status === 'moved') todos = todos.filter((t) => t.id !== todo.id)
        if (result.status !== 'closed') return 'none'
        closedCount += 1
        return 'closed'
      } catch (err) {
        console.warn('[action-done-from-mail] thread skipped:', err instanceof Error ? err.message : String(err))
        return 'skipped'
      }
    },
  }
}

export type UndoActionDoneResult =
  /**
   * `reopened`: back where it was. `changed`: moved since mail closed it, so
   * left where the person put it. `gone`: deleted since. `already`: undone before.
   */
  | { ok: true; status: 'reopened' | 'changed' | 'gone' | 'already' }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'read_failed' }

interface DoneRow {
  id: string
  action_id: string
  prior_status_id: string | null
  done_status_id: string | null
  sender_domain: string | null
  undone_at: string | null
}

/**
 * Undo one close (see the header): put the to-do back, mark the row undone,
 * rewrite its message and log it. Safe to repeat. The row is read for this
 * person and workspace only.
 */
export async function undoActionDoneFromMail(
  supabase: SupabaseClient,
  args: MailDoneScope & { recordId: string; nowMs?: number },
  deps: MailDoneDeps = {},
): Promise<UndoActionDoneResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, action_id, prior_status_id, done_status_id, sender_domain, undone_at')
    .eq('id', args.recordId)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .maybeSingle()
  if (error) return { ok: false, reason: isPre450Error(error) ? 'unavailable' : 'read_failed' }
  const row = data as DoneRow | null
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.undone_at) return { ok: true, status: 'already' }

  const { data: actionData, error: actionError } = await supabase
    .from('actions')
    .select('id, identifier, title, team_id, status_id')
    .eq('id', row.action_id)
    .eq('workspace_id', scope.workspaceId)
    .maybeSingle()
  if (actionError) return { ok: false, reason: 'read_failed' }
  const action = actionData as { id: string; identifier: string | null; title: string | null; team_id: string; status_id: string } | null

  let status: 'reopened' | 'changed' | 'gone' = action ? 'changed' : 'gone'
  if (action && row.done_status_id && action.status_id === row.done_status_id) {
    const back = await reopenStateOf(supabase, action.team_id, row.prior_status_id)
    if (back) {
      const { data: moved, error: moveError } = await supabase
        .from('actions')
        .update({ status_id: back })
        .eq('id', action.id)
        .eq('workspace_id', scope.workspaceId)
        .eq('status_id', row.done_status_id)
        .select('id')
      if (moveError) return { ok: false, reason: 'read_failed' }
      if ((moved as unknown[] | null)?.length) {
        status = 'reopened'
        // The person's own click.
        ;(deps.emit ?? emitStatusChange)({
          entityType: 'action',
          entityId: action.id,
          workspaceId: scope.workspaceId,
          teamId: action.team_id,
          fromStatusId: row.done_status_id,
          toStatusId: back,
          actorUserId: scope.userId,
        })
      }
    }
  }

  const { error: markError } = await supabase.from(TABLE).update({ undone_at: nowIso }).eq('id', row.id).is('undone_at', null)
  if (markError) console.warn(`[action-done-from-mail] ${TABLE} undo mark failed:`, markError.message)
  if (action) {
    const line = logLineFor({ type: 'action_done_from_mail', identifier: action.identifier, title: action.title, undone: true })
    if (line && status === 'reopened') {
      await (deps.appendLog ?? appendLogLine)(
        { ...scope, kind: line.kind, line: line.line, refType: 'action', refId: action.id, dedupeKey: logDedupeKey.actionDoneFromMail(row.id, true), at: nowIso },
        supabase,
      )
    }
    const conversationId = await (deps.homeThread ?? homeConversationId)(supabase, scope).catch(() => null)
    if (conversationId) {
      await (deps.writeMessage ?? writeActionDoneMessage)(supabase, { ...scope, conversationId }, {
        record_id: row.id,
        action_id: action.id,
        identifier: action.identifier,
        title: (action.title ?? '').trim().slice(0, ACTION_DONE_TITLE_MAX) || 'To-do',
        sender_domain: row.sender_domain,
        undone: true,
        ...(status === 'changed' ? { changed: true } : {}),
      })
    }
  }
  return { ok: true, status }
}

/** Where Undo puts a to-do: its state before, while it is still its team's; else the team's default. */
async function reopenStateOf(supabase: SupabaseClient, teamId: string, priorStatusId: string | null): Promise<string | null> {
  if (priorStatusId) {
    const { data } = await supabase.from('workflow_state').select('id').eq('id', priorStatusId).eq('team_id', teamId).maybeSingle()
    if (typeof (data as { id?: unknown } | null)?.id === 'string') return priorStatusId
  }
  const { data } = await supabase.from('workflow_state').select('id').eq('team_id', teamId).eq('is_default', true).limit(1).maybeSingle()
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}
