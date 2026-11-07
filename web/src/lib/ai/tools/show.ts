/**
 * Pages in the chat (docs/plans/one-agent-and-chat-pages.md, Part 1).
 *
 *   show       put a page in the chat: a filtered list (or board) of records,
 *              or one record as its detail panel. The result is the cleaned-up
 *              description the chat draws the live page from, the count and
 *              the first ten rows, so the agent's words match the card.
 *   read_card  the rows a card shows the person NOW, their changes by hand
 *              included, with the fields asked for: it re-runs the card's
 *              current spec, which the client sends with the turn
 *              (systemContext.cards → the chat tool route's `cards`).
 *
 * Both only read. read_card is attended only (ATTENDED_ONLY_TOOL_NAMES): only
 * a chat with cards on screen has anything for it to read.
 *
 * Calendar and mail cards (P2) are the person's own data. They show only
 * where the caller says the matching tools are allowed (`personalKinds`:
 * the main chat, when its ceiling holds get_calendar_events / list_emails);
 * everywhere else (MCP, unattended runs, a teammate's chat) they are refused
 * and the existing tools are the way, so a card never reads more than those
 * tools may.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CARD_LIST_ENTITIES, CARD_RECORD_TYPES, ENTITY_NOUN, type CardListEntity } from '@/lib/chat-cards/kinds'
import { normalizeShowInput } from '@/lib/chat-cards/validate'
import { SHOW_KINDS, fenceOf, runListQuery, loadRecord, type CardScope } from '@/lib/chat-cards/server'
import { listCalendarRange, resolveCalendarAccounts } from '@/lib/chat-cards/server-calendar'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { findMailThread, listMailThreads, resolveMailAccounts } from '@/lib/chat-cards/server-mail'
import { focusedCard, type CardContextEntry } from '@/lib/chat-cards/context'
import { compactValue, rowLabel } from '@/lib/chat-cards/rows'
import { SHOW_PAGE_KIND_NAMES, isPageKind } from '@/lib/chat-cards/pages'
import { normalizePageInput } from '@/lib/chat-cards/page-validate'
import { readPageCard, showPage } from '@/lib/chat-cards/page-server'

/** The most rows read_card returns: a page of the card. */
export const READ_CARD_MAX_ROWS = 50

const filterSchema = z.object({
  field: z
    .string()
    .describe(
      'A field of entity_type, exactly as named (e.g. assignee_id, due_at, status_type, project_id, title). ' +
        'Open (unfinished) actions: status_type is_none_of ["completed", "canceled"], never just "is not completed"',
    ),
  operator: z
    .string()
    .describe('is, is_not, is_any_of, is_none_of, contains, does_not_contain, gt, gte, lt, lte, between, is_relative, includes, excludes, is_empty, is_not_empty'),
  value: z
    .unknown()
    .optional()
    .describe(
      'A value: "@me" for yourself, a name or id for people, projects, teams, labels and statuses, an ISO date, a list for is_any_of, ' +
        '{"unit":"week","direction":"this"} (or "this week", "next 7 days") for is_relative. Omit for is_empty / is_not_empty',
    ),
})

/** The per-person card kinds and the tool each stands in for: allowed only where that tool is. */
export const PERSONAL_CARD_TOOLS = { calendar: 'get_calendar_events', mail: 'list_emails' } as const
export type PersonalCardKind = keyof typeof PERSONAL_CARD_TOOLS

export const showInputSchema = z.object({
  kind: z
    .enum(['list', 'board', 'record', 'calendar', 'mail', ...SHOW_PAGE_KIND_NAMES])
    .describe(
      "'list': a filtered page of records; 'board': the same as a board; 'record': one record; 'calendar': a day, week or month of events; 'mail': a mail folder or one thread. " +
        'A whole page: team_board (one team\'s actions by state), sequences, prospecting, flows, evals, campaigns, knowledge, ' +
        'library (agents & skills), teams, browser',
    ),
  title: z.string().describe('What the card says, short: "Due this week · Atlas"'),
  entity_type: z.enum(CARD_LIST_ENTITIES).optional().describe('list / board: what to list'),
  filters: z.array(filterSchema).optional().describe('list / board: all must match (AND)'),
  ordering: z
    .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() }))
    .optional()
    .describe('list / board: sort, e.g. [{"field":"due_at","direction":"asc"}]. Omit for the page default'),
  grouping: z
    .object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() })
    .nullable()
    .optional()
    .describe('list / board: group rows by a field (a board\'s columns), e.g. {"field":"status_id"}'),
  layout: z.enum(['list', 'board']).optional(),
  columns: z.array(z.string()).optional().describe('list / board: columns to show, left to right. Omit for the page default'),
  record: z
    .object({ type: z.enum(CARD_RECORD_TYPES), id: z.string() })
    .optional()
    .describe('record: which one, by id (an action also by identifier, e.g. GEN-42)'),
  calendar: z
    .object({
      from: z.string().optional().describe('First day, YYYY-MM-DD'),
      to: z.string().optional().describe('Last day, YYYY-MM-DD; omit for the view\'s own range'),
      view: z.string().optional().describe('day, week (Sunday to Saturday) or month'),
      accounts: z.array(z.string()).optional().describe('Only these calendar accounts, by email; omit for all'),
    })
    .optional()
    .describe('calendar: e.g. {"from":"2026-10-05","view":"week"}'),
  mail: z
    .object({
      folder: z.string().optional().describe('inbox (default), starred, sent, drafts, archive, spam or trash'),
      search: z.string().optional().describe('Text to find in subject, preview or sender'),
      unread: z.boolean().optional().describe('true: only unread threads'),
      thread_id: z.string().optional().describe('One thread, from list_emails, read_email or search'),
      accounts: z.array(z.string()).optional().describe('Only these mailboxes, by email; omit for all'),
    })
    .optional()
    .describe('mail: e.g. {"folder":"inbox","search":"acme","unread":true}'),
  target: z
    .string()
    .optional()
    .describe(
      'A page: what to open it on, by name or id: the team (team_board, required; teams), a sequence, a prospect list, an eval suite, ' +
        'a knowledge package, an agent or skill (library). Omit for the whole page',
    ),
  tab: z.string().optional().describe('A page: evals (overview, cases, runs), knowledge (claims, library), library (agents, skills)'),
})

export const readCardInputSchema = z.object({
  card: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The card number ("card 3"). Omit for the card the person is looking at'),
  fields: z
    .array(z.string())
    .max(12)
    .optional()
    .describe('Row fields to include besides id, identifier and title, e.g. ["workflow_state","priority","due_at","assignee"]'),
})

const SHOW_DESCRIPTION =
  'Put a page in the chat for the person: a live list or board of records filtered your way, one record, ' +
  'their calendar for a day, week or month, or a mail folder or thread. ' +
  'Use it whenever the answer is a set of records ("what\'s due this week", "my open deals", "captures with Acme", "my week", "unread from Acme") instead of listing them in prose, ' +
  'and to open one record. The card is the real page: the person can filter, sort, open rows and keep it as a saved view. ' +
  'It also shows a whole page (a team board, sequences, prospecting, flows, evals, campaigns, knowledge, agents & skills, teams, the browser), opened on a target by name. ' +
  'Returns the cleaned-up spec, the count and the first 10 rows, so say in one line what it shows and what stands out; do not repeat the rows. ' +
  'To change what is shown, call show again (a new card); never describe an old card as changed. ' +
  'Filters use the entity\'s own fields; a refusal names the fix and the valid fields.'

const READ_CARD_DESCRIPTION =
  'Read the rows a card in this chat shows the person right now, including their own changes by hand (filters, sort, search, the dates or folder they moved to), ' +
  'with the fields you ask for. Use it when a question is about what they are looking at ("which of these are blocked?", "close the second one"). ' +
  'Pass the card number, or omit it for the card on screen. Returns up to 50 rows with ids to act on, and the total.'

/** The fields a row offers, for a refusal naming them. */
function rowFields(row: Record<string, unknown> | undefined): string[] {
  return row ? Object.keys(row).filter((k) => !['workspace_id'].includes(k)) : []
}

/** Why a per-person card is refused here, naming what to use instead. */
function personalRefusal(kind: PersonalCardKind): string {
  return kind === 'mail'
    ? "kind 'mail' shows only in a Dial8 chat that can read mail. Here, use list_emails and read_email instead"
    : "kind 'calendar' shows only in a Dial8 chat that can read the calendar. Here, use get_calendar_events instead"
}

export function createShowTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  cards?: CardContextEntry[],
  personalKinds: readonly PersonalCardKind[] = [],
  /** The browser's IANA zone this turn (checked by the caller): a calendar card's days are its local days. */
  timeZone?: string | null,
) {
  const scope: CardScope = { supabase, workspaceId, userId, ...(isTimeZone(timeZone) ? { timeZone } : {}) }
  const allowed = (kind: PersonalCardKind) => personalKinds.includes(kind)
  return {
    show: tool({
      description: SHOW_DESCRIPTION,
      inputSchema: showInputSchema,
      execute: async (input) => {
        if (isPageKind(input.kind)) {
          const page = normalizePageInput(input)
          if (!page.ok) return { success: false, code: 'INPUT_INVALID', error: page.error }
          // What the person may see, for every read below (a required argument).
          const shown = await showPage(scope, await fenceOf(scope), page.value)
          if (!shown.ok) return { success: false, code: 'INPUT_INVALID', error: shown.error }
          const { card, count, items, item } = shown.value
          return {
            success: true,
            card,
            ...(count !== undefined ? { count } : {}),
            ...(items ? { items } : {}),
            ...(item ? { item } : {}),
          }
        }
        const checked = normalizeShowInput(input)
        if (!checked.ok) return { success: false, code: 'INPUT_INVALID', error: checked.error }
        const spec = checked.value
        if ((spec.kind === 'calendar' || spec.kind === 'mail') && !allowed(spec.kind)) {
          return { success: false, code: 'NOT_AVAILABLE', error: personalRefusal(spec.kind) }
        }
        // What the person may see, for every read below (a required argument).
        const fence = await fenceOf(scope)
        const shown =
          spec.kind === 'list'
            ? await SHOW_KINDS.list(scope, fence, spec)
            : spec.kind === 'record'
              ? await SHOW_KINDS.record(scope, fence, spec)
              : spec.kind === 'calendar'
                ? await SHOW_KINDS.calendar(scope, fence, spec)
                : await SHOW_KINDS.mail(scope, fence, spec)
        if (!shown.ok) return { success: false, code: 'INPUT_INVALID', error: shown.error }
        // A calendar or mail card loads its area's pack in the chat-agent's show
        // proxy (attachCardExpertise, by the registry's card kinds 'calendar' and 'mail').
        const { card, count, items, item } = shown.value
        return {
          success: true,
          card,
          ...(count !== undefined ? { count } : {}),
          ...(items ? { items } : {}),
          ...(item ? { item } : {}),
        }
      },
    }),

    read_card: tool({
      description: READ_CARD_DESCRIPTION,
      inputSchema: readCardInputSchema,
      execute: async ({ card, fields }) => {
        const all = cards ?? []
        if (all.length === 0) {
          return { success: false, code: 'NO_CARDS', error: 'No card is open in this chat. Use show to put one here.' }
        }
        const entry = card === undefined ? focusedCard(all) : all.find((c) => c.n === card)
        if (!entry) {
          const known = all.map((c) => `card ${c.n} (${c.title})`).join(', ')
          return { success: false, code: 'INPUT_INVALID', error: `There is no card ${card} here. Cards: ${known}` }
        }
        if (isPageKind(entry.kind)) return readPageCard(scope, await fenceOf(scope), entry, fields ?? [])
        if (entry.kind === 'calendar' && entry.cal) {
          if (!allowed('calendar')) return { success: false, code: 'NOT_AVAILABLE', error: personalRefusal('calendar') }
          const cur = entry.cal.cur
          const accounts = await resolveCalendarAccounts(scope, cur.accounts)
          if (!accounts.ok) return { success: false, error: accounts.error }
          // The zone the card was drawn in, else the turn's.
          const events = await listCalendarRange(scope, cur, accounts.value, entry.cal.tz)
          return {
            success: true,
            card: entry.n,
            title: entry.title,
            range: { from: cur.from, to: cur.to, view: cur.view },
            total: events.length,
            ...(events.length > READ_CARD_MAX_ROWS ? { showing: READ_CARD_MAX_ROWS } : {}),
            ...(entry.open ? { open_inside: entry.open } : {}),
            events: events.slice(0, READ_CARD_MAX_ROWS),
          }
        }
        if (entry.kind === 'mail' && entry.mail) {
          if (!allowed('mail')) return { success: false, code: 'NOT_AVAILABLE', error: personalRefusal('mail') }
          const cur = entry.mail.cur
          const accounts = await resolveMailAccounts(scope, cur.accounts)
          if (!accounts.ok) return { success: false, error: accounts.error }
          if (cur.thread_id) {
            // A thread card shows one thread; read_email has its messages.
            const thread = await findMailThread(scope, accounts.value, cur.thread_id)
            if (!thread) return { success: false, error: `card ${entry.n}'s thread is not in your mailboxes here any more` }
            return { success: true, card: entry.n, title: entry.title, thread }
          }
          const page = await listMailThreads(scope, accounts.value, cur, READ_CARD_MAX_ROWS)
          return {
            success: true,
            card: entry.n,
            title: entry.title,
            folder: cur.folder,
            ...(cur.search ? { search: cur.search } : {}),
            ...(cur.unread ? { unread: true } : {}),
            total: page.count,
            ...(page.count > page.items.length ? { showing: page.items.length } : {}),
            ...(entry.open ? { open_inside: entry.open } : {}),
            threads: page.items,
          }
        }
        if (entry.kind === 'record' && entry.record) {
          const found = await loadRecord(scope, await fenceOf(scope), entry.record.type, entry.record.id)
          if (!found.ok) return { success: false, error: found.error }
          return { success: true, card: entry.n, title: entry.title, record: { type: entry.record.type, ...found.value } }
        }
        if (!entry.entity) return { success: false, error: `card ${entry.n} has no rows to read` }
        if (!entry.cur) {
          return { success: false, code: 'CARD_TOO_BIG', error: `card ${entry.n} is too big to read back. Show it again with fewer values in its filters, then read that card` }
        }
        const entity = entry.entity as CardListEntity
        const page = await runListQuery(scope, await fenceOf(scope), entity, entry.cur, READ_CARD_MAX_ROWS)
        const wanted = fields ?? []
        const offered = rowFields(page.rows[0])
        const unknown = page.rows.length ? wanted.filter((f) => !offered.includes(f)) : []
        if (unknown.length) {
          return {
            success: false,
            code: 'INPUT_INVALID',
            error: `${ENTITY_NOUN[entity].plural} rows have no ${unknown.join(', ')}. Fields: ${offered.join(', ')}`,
          }
        }
        const rows = page.rows.map((row) => {
          const out: Record<string, unknown> = { ...rowLabel(row) }
          for (const f of wanted) out[f] = compactValue(row[f])
          return out
        })
        return {
          success: true,
          card: entry.n,
          title: entry.title,
          total: page.count,
          ...(page.count > rows.length ? { showing: rows.length } : {}),
          ...(entry.open ? { open_inside: entry.open } : {}),
          rows,
        }
      },
    }),
  }
}
