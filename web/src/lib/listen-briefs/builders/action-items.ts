import { counted, rows, type BriefContext, type Result } from '../context'
import { assignedTo, clause, count, listOf, numberWord, one, stringOr, type OneOrMany, type Speech } from '../speech'
import { describeDue, isPastDue, type Clock } from '../when'

/**
 * Action items as every brief says them: who owns one (an action's own brief,
 * ./action.ts), and a list of them, one sentence each (the items accepted
 * from a meeting, ./capture.ts; the open ones in a project, ./project.ts,
 * across an initiative's projects, ./initiative.ts, with a person,
 * ./contact.ts, and with people at a company, ./company.ts).
 *
 *   "Send the revised deck, assigned to you, due on Friday. Book the security
 *    review, assigned to Jessa Lin, overdue since Thursday. Share the pricing
 *    sheet, done. And two more."
 */

export interface MemberRef {
  id: string
  display_name: string | null
}

/** The columns that say who owns an action. */
export interface OwnedRow {
  context_data: Record<string, unknown> | null
  assignee: OneOrMany<MemberRef>
  assignees: Array<{ member: OneOrMany<MemberRef> }> | null
  assignee_ai_member: OneOrMany<{ name: string | null }>
  assignee_contact: OneOrMany<{ full_name: string | null }>
}

/** The embeds of an actions select that fill an OwnedRow (with context_data). */
export const OWNER_EMBEDS = `
  assignee:member!assignee_id(id, display_name),
  assignees:action_assignee(member:member(id, display_name)),
  assignee_ai_member:ai_team_member!assignee_ai_member_id(name),
  assignee_contact:contact!assignee_contact_id(full_name)
`

/** Who owns it: "assigned to you and Jordan Lee", "assigned to Nova, an AI
 *  teammate", "assigned to Jessa Lin" (a contact, or the name the meeting
 *  gave), or, with `sayUnassigned`, "not assigned to anyone yet". */
export function ownersOf(action: OwnedRow, memberId: string, sayUnassigned: boolean): string | null {
  const joined = (action.assignees ?? []).map((a) => one(a.member)).filter((m): m is MemberRef => !!m)
  const members = joined.length ? joined : [one(action.assignee)].filter((m): m is MemberRef => !!m)
  if (members.length) {
    const others = members.filter((m) => m.id !== memberId).map((m) => clause(m.display_name))
    const names = members.some((m) => m.id === memberId) ? ['you', ...others] : others
    return assignedTo(listOf(names)) ?? 'assigned to a teammate'
  }
  const ai = clause(one(action.assignee_ai_member)?.name)
  if (ai) return `assigned to ${ai}, an AI teammate`
  const outside = clause(one(action.assignee_contact)?.full_name ?? stringOr(action.context_data?.original_owner))
  if (outside) return assignedTo(outside)
  return sayUnassigned ? 'not assigned to anyone yet' : null
}

/** A workflow state an action is finished in. */
export function isClosed(category: string | null | undefined): boolean {
  return category === 'completed' || category === 'canceled'
}

/** What an action-item line is said from. */
export interface ItemRow extends OwnedRow {
  title: string | null
  due_at: string | null
  workflow_state: OneOrMany<{ category: string | null }>
}

/** Items read one by one; past these, "And N more". */
export const MAX_ITEMS = 5

/** An action item as it is said, whatever it was read from. */
export interface SaidItem {
  title: string | null
  due_at: string | null
  /** none | low | medium | high | urgent: the pressing order's tiebreak. */
  priority: string | null
  done: boolean
  /** "assigned to you", "assigned to Jessa Lin"; null says none (none known,
   *  or the list's own heading says whose they are). */
  owner: string | null
}

/** An action row as said: its owners (ownersOf), done once it's closed. */
export function saidOf(row: ItemRow & { priority?: string | null }, memberId: string): SaidItem {
  return {
    title: row.title,
    due_at: row.due_at,
    priority: row.priority ?? null,
    done: isClosed(one(row.workflow_state)?.category),
    owner: ownersOf(row, memberId, false),
  }
}

/** One action item: "Send the revised deck, assigned to you, due on Friday",
 *  "Book the security review, assigned to Jessa Lin, overdue since Thursday",
 *  "Share the pricing sheet, done". */
export function itemLine(item: SaidItem, clock: Clock): string {
  const what = clause(item.title) || 'An untitled action item'
  if (item.done) return `${what}, done`
  return [what, item.owner, dueWords(item.due_at, clock)].filter(Boolean).join(', ')
}

/** The items, a sentence each, the first MAX_ITEMS of them, then "And N
 *  more." for the rest of `total` (every item there is, read or not; "at
 *  least" when there may be more than that). */
export function sayItems(speech: Speech, items: readonly SaidItem[], clock: Clock, total = items.length, atLeast = false): void {
  const said = items.slice(0, MAX_ITEMS)
  for (const item of said) speech.say(itemLine(item, clock))
  const rest = total - said.length
  if (said.length && rest > 0) speech.say('And', atLeast && 'at least', `${numberWord(rest)} more`)
}

/**
 * A list under its own heading: a single item said in the heading's
 * sentence ("Jessa has one open action: Send the order form, due on
 * Friday."), more said after it ("Jessa has three open actions." then each
 * one). `heading(n)` is the sentence for n items, `one` its opening for a
 * single item; with `atLeast`, a lone item is still a list.
 */
export function sayItemsUnder(
  speech: Speech,
  items: readonly SaidItem[],
  clock: Clock,
  heading: { one: string; many: (n: number) => string },
  total = items.length,
  atLeast = false,
): void {
  if (!items.length) return
  if (total === 1 && !atLeast) {
    speech.say(heading.one, itemLine(items[0], clock))
    return
  }
  speech.say(heading.many(total))
  sayItems(speech, items, clock, total, atLeast)
}

/** One action row, said: see itemLine. */
export function actionItem(action: ItemRow, who: { memberId: string; clock: Clock }): string {
  return itemLine(saidOf(action, who.memberId), who.clock)
}

/** Action rows, said: see sayItems. */
export function sayActionItems(
  speech: Speech,
  items: readonly (ItemRow & { priority?: string | null })[],
  who: { memberId: string; clock: Clock },
  total = items.length,
): void {
  sayItems(speech, items.map((item) => saidOf(item, who.memberId)), who.clock, total)
}

/** When an open action is due: "due tomorrow", "overdue since Thursday", or,
 *  for a moment long gone, "due 10 days ago". */
export function dueWords(dueAt: string | null, clock: Clock): string | null {
  const due = describeDue(dueAt, clock)
  if (!due) return null
  if (!isPastDue(dueAt, clock)) return `due ${due}`
  return /\bago$|^just now$/.test(due) ? `due ${due}` : `overdue since ${dayName(due)}`
}

/** A day named inside a clause: "on Friday" → "Friday". */
export function dayName(day: string): string {
  return day.replace(/^on /, '')
}

// ── Open actions in a project, or across an initiative's ────────────────────

/** An open action as a project or an initiative reads it. */
export interface OpenActionRow extends ItemRow {
  /** none | low | medium | high | urgent */
  priority: string | null
}

/** How many open actions are read to find the overdue ones and the most
 *  pressing: past this, the overdue count is a floor. */
export const OPEN_SCAN = 100

/**
 * The open actions in a project, or in any project of an initiative, soonest
 * due first, so the overdue ones are all read (up to OPEN_SCAN); and how many
 * are open and done in all (null when they could not be counted). Dismissed
 * suggestions don't count. On the user's own client, in this workspace.
 */
export async function readOpenActions(
  ctx: BriefContext,
  scope: { projectId: string } | { initiativeId: string },
): Promise<{ openActions: OpenActionRow[]; counts: { open: number; done: number } | null }> {
  const { supabase, workspaceId } = ctx
  // An initiative's actions are its projects': joined, and filtered through it.
  const initiative = 'initiativeId' in scope
  const through = initiative ? ', project:projects!project_id!inner(initiative_id)' : ''
  const column = initiative ? 'project.initiative_id' : 'project_id'
  const value = initiative ? scope.initiativeId : scope.projectId

  const [openRes, doneRes] = await Promise.all([
    supabase
      .from('actions')
      .select(
        `title, due_at, priority, context_data, workflow_state:workflow_state!status_id!inner(category), ${OWNER_EMBEDS}${through}`,
        { count: 'exact' },
      )
      .eq(column, value)
      .eq('workspace_id', workspaceId)
      .neq('confirmation', 'dismissed')
      .not('workflow_state.category', 'in', '(completed,canceled)')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(OPEN_SCAN),
    supabase
      .from('actions')
      .select(`id, workflow_state:workflow_state!status_id!inner(category)${through}`, { count: 'exact', head: true })
      .eq(column, value)
      .eq('workspace_id', workspaceId)
      .neq('confirmation', 'dismissed')
      .eq('workflow_state.category', 'completed'),
  ])

  const openActions = rows('open actions', openRes as Result<OpenActionRow>)
  const open = openRes.error ? null : (openRes.count ?? openActions.length)
  const done = counted('done actions', doneRes)
  return { openActions, counts: open === null || done === null ? null : { open, done } }
}

/** "Six actions are open, two of them overdue, and nine are done", "One
 *  action is open and overdue, and none are done yet", "All nine of its
 *  actions are done", "It has no actions yet". The overdue count is of the
 *  open actions read; `floor` when there were more than were read. */
export function progress({ open, done }: { open: number; done: number }, overdue: number, floor: boolean): string {
  if (open === 0) {
    if (done === 0) return 'It has no actions yet'
    return done === 1 ? 'Its only action is done' : `All ${numberWord(done)} of its actions are done`
  }
  const late =
    overdue === 0
      ? null
      : floor
        ? `at least ${numberWord(overdue)} of them overdue`
        : overdue < open
          ? `${numberWord(overdue)} of them overdue`
          : 'all of them overdue'
  const standing =
    open === 1
      ? `One action is open${overdue ? ' and overdue' : ''}`
      : [`${count(open, 'action')} are open`, late].filter(Boolean).join(', ')
  return `${standing}, ${done === 0 ? 'and none are done yet' : `and ${numberWord(done)} ${done === 1 ? 'is' : 'are'} done`}`
}

/** The progress line for what was read: its overdue ones counted, "at least"
 *  when every open action read was overdue and there are more. */
export function progressOf(counts: { open: number; done: number }, openActions: readonly OpenActionRow[], clock: Clock): string {
  const overdue = openActions.filter((a) => isPastDue(a.due_at, clock)).length
  const floor = overdue > 0 && overdue === openActions.length && openActions.length < counts.open
  return progress(counts, overdue, floor)
}

/** Overdue first (the longest overdue first), then by due date, then the
 *  undated; urgent and high priority first among equals. Stable, so the rest
 *  keep the query's order (most recently touched first). */
export function pressing<T extends { due_at: string | null; priority: string | null }>(actions: readonly T[], clock: Clock): T[] {
  return actions
    .map((a) => ({
      a,
      group: !a.due_at ? 2 : isPastDue(a.due_at, clock) ? 0 : 1,
      time: (a.due_at && Date.parse(a.due_at)) || 0,
      rank: PRIORITY_RANK[a.priority ?? ''] ?? 4,
    }))
    .sort((x, y) => x.group - y.group || x.time - y.time || x.rank - y.rank)
    .map((x) => x.a)
}

const PRIORITY_RANK: Partial<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3 }
