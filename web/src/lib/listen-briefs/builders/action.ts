import { isCaptureVisible } from '@/lib/ai/tools/_shared'
import { markdownToSentences } from '@/lib/read-aloud/speech-text'
import { row, rows, type BriefContext, type OneResult, type Result } from '../context'
import { Speech, clause, count, numberWord, one, type OneOrMany } from '../speech'
import { describeDue, describeWhen, isPastDue, type Clock } from '../when'
import { OWNER_EMBEDS, isClosed, ownersOf, pressing, saidOf, sayItemsUnder, type ItemRow, type OwnedRow } from './action-items'

/**
 * An action (a task): where it stands (its state, who owns it, when it's
 * due), what its AI agent is up to, where it came from (the meeting it was
 * pulled out of, else who created it), what it belongs to and its open
 * sub-tasks one by one, then its description, read in full as listen mode
 * read an action before briefs.
 *
 *   "Send Jessa the revised deck. It's in review, assigned to you and Jordan
 *    Lee, and was due on Friday. It came from Pricing sync, on Tuesday. …"
 *
 * Read on the user's own client, in this workspace, as the action detail
 * route reads it; its meeting only with the capture fences (private → only
 * its creator, evaluation captures left out).
 */
export async function actionSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, workspaceId, userId } = ctx

  const [actionRes, subTasksRes] = await Promise.all([
    supabase.from('actions').select(ACTION_SELECT).eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
    supabase
      .from('actions')
      .select(`title, due_at, priority, context_data, workflow_state:workflow_state!status_id(category), ${OWNER_EMBEDS}`)
      .eq('parent_id', id)
      .eq('workspace_id', workspaceId)
      .neq('confirmation', 'dismissed')
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(SUB_TASK_SCAN),
  ])

  if (actionRes.error) {
    console.warn('[listen-brief] action failed:', actionRes.error.message)
    return null
  }
  const action = actionRes.data as ActionRow | null
  if (!action) return null

  // What only the row can say to look up: its parent task, and who created
  // it when no meeting the user can see did (a member, by their user id).
  const creatorId =
    action.user_id && action.user_id !== userId && !sourceMeeting(action, userId) ? action.user_id : null
  const [creatorRes, parentRes] = await Promise.all([
    creatorId
      ? supabase.from('member').select('display_name').eq('workspace_id', workspaceId).eq('user_id', creatorId).maybeSingle()
      : null,
    action.parent_id
      ? supabase.from('actions').select('title').eq('id', action.parent_id).eq('workspace_id', workspaceId).maybeSingle()
      : null,
  ])

  return actionWords(
    {
      action,
      creator: row('creator', creatorRes as OneResult<{ display_name: string | null }> | null)?.display_name ?? null,
      parent: row('parent', parentRes as OneResult<ParentRow> | null),
      subTasks: rows('sub-tasks', subTasksRes as Result<SubTaskRow>),
    },
    ctx,
  )
}

/** What the rows say, as words. Pure. */
export function actionWords(
  data: {
    action: ActionRow
    /** Its creator's name when that isn't the user; looked up only when no
     *  meeting the user can see made it. */
    creator: string | null
    parent: ParentRow | null
    subTasks: SubTaskRow[]
  },
  who: { userId: string; memberId: string; clock: Clock },
): Speech {
  const { action } = data
  const { userId, memberId, clock } = who
  const speech = new Speech()
  const state = one(action.workflow_state)
  const closed = isClosed(state?.category)

  // Its title, not its identifier: nobody says "ENG-42" out loud.
  speech.say(clause(action.title) || 'Untitled action')

  // Where it stands: "It's in review, assigned to you and Jordan Lee, and was
  // due on Friday." Past due matters only while it is still open.
  // A closed one's due date is history: not said.
  const due = closed ? null : describeDue(action.due_at, clock)
  const late = !!due && isPastDue(action.due_at, clock)
  const standing = [stateWords(state), ownersOf(action, memberId, !closed), due && (late ? `and was due ${due}` : `due ${due}`)]
  if (standing.some(Boolean)) speech.say(`It's ${standing.filter(Boolean).join(', ')}`)
  if (!closed && action.priority === 'urgent') speech.say("It's urgent")
  if (!closed && action.priority === 'high') speech.say("It's high priority")

  speech.say(agentWords(action.agent_run_status, clause(one(action.assignee_ai_member)?.name)))
  if (action.confirmation === 'suggested') speech.say("It's a suggestion no one has confirmed yet")
  if (action.confirmation === 'dismissed') speech.say('It was dismissed')

  // Where it came from: the meeting, else who made it.
  const meeting = sourceMeeting(action, userId)
  if (meeting) {
    const when = describeWhen(meeting.started_at ?? meeting.recorded_at ?? meeting.created_at, clock)
    const title = clause(meeting.title)
    speech.say(title ? `It came from ${title}` : 'It came from a meeting', when && (title ? `, ${when}` : when))
  } else {
    const when = describeWhen(action.created_at, clock)
    const creator = action.user_id && action.user_id === userId ? 'You' : clause(data.creator)
    if (creator) speech.say(`${creator} created it`, when)
    else if (when) speech.say('It was created', when)
  }

  // What it belongs to.
  const project = clause(one(action.project)?.name)
  const milestone = clause(one(action.milestone)?.name)
  if (project || milestone) speech.say("It's part of", [project, milestone && `the ${milestone} milestone`].filter(Boolean).join(' and '))
  const parent = clause(data.parent?.title)
  if (parent) speech.say(`It's a sub-task of ${parent}`)
  // Its sub-tasks: how many are still open, then each open one, the most
  // pressing first (Liam, 2026-09-28: "read the sub-tasks one by one"). A lone
  // open one is said in the count's sentence.
  const tally = subTaskWords(data.subTasks)
  const openSubTasks = pressing(data.subTasks.filter((t) => !isClosed(one(t.workflow_state)?.category)), clock)
  if (tally && openSubTasks.length) {
    sayItemsUnder(speech, openSubTasks.map((t) => saidOf(t, memberId)), clock, { one: `${tally}:`, many: () => tally })
  } else {
    speech.say(tally)
  }

  // Then its own words, all of them.
  speech.sayAll(markdownToSentences((action.description ?? '').replace(/<!--[\s\S]*?-->/g, '')))
  return speech
}

// `source_capture` names the FK constraint, not the column: it still carries
// the pre-rename name (source_note_id → source_capture_id), as in the action
// detail route. PostgREST select strings take no comments, hence out here.
const ACTION_SELECT = `
  title, description, priority, due_at, confirmation, user_id, parent_id, created_at, agent_run_status, context_data,
  workflow_state:workflow_state!status_id(name, category),
  ${OWNER_EMBEDS},
  project:projects!project_id(name),
  milestone:milestone!milestone_id(name),
  source_capture:captures!actions_source_note_id_fkey(title, started_at, recorded_at, created_at, visibility, user_id, is_eval)
`

/** Sub-tasks read to count the open ones. */
const SUB_TASK_SCAN = 100

export interface ActionRow extends OwnedRow {
  title: string | null
  description: string | null
  /** none | low | medium | high | urgent */
  priority: string | null
  due_at: string | null
  /** suggested | confirmed | dismissed */
  confirmation: string | null
  /** Who created it: an auth user id. */
  user_id: string | null
  parent_id: string | null
  created_at: string | null
  /** idle | starting | working | pr_open | needs_input | failed */
  agent_run_status: string | null
  workflow_state: OneOrMany<{ name: string | null; category: string | null }>
  project: OneOrMany<{ name: string | null }>
  milestone: OneOrMany<{ name: string | null }>
  source_capture: OneOrMany<SourceCaptureRow>
}

export interface SourceCaptureRow {
  title: string | null
  started_at: string | null
  recorded_at: string | null
  created_at: string | null
  visibility: string | null
  user_id: string | null
  is_eval: boolean | null
}

export interface ParentRow {
  title: string | null
}

export interface SubTaskRow extends ItemRow {
  /** none | low | medium | high | urgent */
  priority: string | null
}

/** The meeting it was pulled out of, when the user may see it. */
function sourceMeeting(action: ActionRow, userId: string): SourceCaptureRow | null {
  const capture = one(action.source_capture)
  return capture && isCaptureVisible(capture, userId) ? capture : null
}

/** Its state, as said after "It's": "not started", "in review", "done". */
function stateWords(state: { name: string | null; category: string | null } | null): string | null {
  if (!state) return null
  switch (state.category) {
    case 'backlog':
      return 'in the backlog'
    case 'unstarted':
      return 'not started'
    case 'started':
      return startedWords(state.name)
    case 'completed':
      return 'done'
    case 'canceled':
      return 'canceled'
    default:
      return null
  }
}

/**
 * A started state by the team's own name when that reads after "It's" ("in
 * review", "blocked", "ready for QA", "in code review", "waiting on
 * review"), else "in progress" (for "Doing", "Started", "WIP"). Capitalised
 * words are lowercased, acronyms kept.
 */
function startedWords(name: string | null): string {
  const said = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => (/^\p{Lu}[\p{Ll}'’-]*$/u.test(w) ? w.toLowerCase() : w))
    .join(' ')
  if (/^(?:in|on|under|ready|blocked|waiting|awaiting|being|pending|paused)\b/i.test(said)) return said
  if (/^needs\s/i.test(said)) return said.replace(/^needs/i, 'waiting on')
  if (/(?:review|qa|testing)$/i.test(said)) return `in ${said}`
  return 'in progress'
}

/** What its AI agent is doing, when it is doing anything. */
function agentWords(status: string | null, name: string | null): string | null {
  switch (status) {
    case 'starting':
      return `${name ?? 'An agent'} is starting work on it`
    case 'working':
      return `${name ?? 'An agent'} is working on it right now`
    case 'needs_input':
      return `${name ?? 'Its agent'} is waiting on your answer`
    case 'pr_open':
      return name ? `${name} opened a pull request for it` : 'Its agent opened a pull request'
    case 'failed':
      return `${name ? `${name}'s` : "Its agent's"} last run failed`
    default:
      return null
  }
}

/** "One of its three sub-tasks is still open", "All its sub-tasks are done". */
function subTaskWords(subTasks: SubTaskRow[]): string | null {
  const total = subTasks.length
  if (!total) return null
  const open = subTasks.filter((t) => !isClosed(one(t.workflow_state)?.category)).length
  if (total === 1) return open ? 'Its one sub-task is still open' : 'Its one sub-task is done'
  if (!open) return 'All its sub-tasks are done'
  if (open === total) return total === 2 ? 'Both its sub-tasks are still open' : `All ${numberWord(total)} of its sub-tasks are still open`
  return `${numberWord(open)} of its ${count(total, 'sub-task')} ${open === 1 ? 'is' : 'are'} still open`
}
