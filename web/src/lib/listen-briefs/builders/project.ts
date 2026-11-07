import { rows, type BriefContext, type Result } from '../context'
import { Speech, clause, one, type OneOrMany } from '../speech'
import { describeDay, describeWhen, isPastDay, type Clock } from '../when'
import { dayName, pressing, progressOf, readOpenActions, sayActionItems, type OpenActionRow } from './action-items'

/**
 * A project: where it stands (its status, who leads it, and when it's due or
 * that its target date has passed), how far along it is, its open action
 * items one by one, the most pressing first (Liam, 2026-09-28, after the
 * capture brief read its action items: "now lets do the same thing for
 * projects"), its next milestone, and its latest meeting.
 *
 *   "Q4 Launch is active, led by you, due on October 16. Six actions are open,
 *    two of them overdue, and nine are done. Fix the checkout bug, assigned
 *    to you, overdue since Thursday. … The next milestone is Beta, due on
 *    Friday."
 *
 * Read on the user's own client, in this workspace, as the project detail
 * route reads it; its meetings with the capture list's fences (private → only
 * its creator; evaluation, archived and skipped captures left out), and only
 * ones that were recorded (a scheduled capture is not a meeting yet).
 */
export async function projectSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, workspaceId, userId } = ctx

  const [projectRes, milestonesRes, standing, meetingsRes] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, status, target_date, is_archived, lead_id, lead:member!lead_id(display_name)')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('milestone')
      .select('name, status, target_date')
      .eq('project_id', id)
      .order('sort_order', { ascending: true })
      .limit(50),
    readOpenActions(ctx, { projectId: id }),
    supabase
      .from('captures')
      .select('title, started_at')
      .eq('project_id', id)
      .eq('workspace_id', workspaceId)
      .or(`visibility.eq.workspace,user_id.eq.${userId}`)
      .neq('is_eval', true)
      .neq('status', 'archived')
      .or('auto_capture_status.is.null,auto_capture_status.neq.skipped')
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1),
  ])

  if (projectRes.error) {
    console.warn('[listen-brief] project failed:', projectRes.error.message)
    return null
  }
  const project = projectRes.data as ProjectRow | null
  if (!project) return null

  return projectWords(
    {
      project,
      milestones: rows('milestones', milestonesRes as Result<MilestoneRow>),
      openActions: standing.openActions,
      counts: standing.counts,
      meetings: rows('meetings', meetingsRes as Result<MeetingRow>),
    },
    ctx,
  )
}

/** What the rows say, as words. Pure. */
export function projectWords(
  data: {
    project: ProjectRow
    milestones: MilestoneRow[]
    /** Its open actions, soonest due first: all of them, or the first OPEN_SCAN. */
    openActions: OpenActionRow[]
    /** Every open and done action in it; null when they could not be counted. */
    counts: { open: number; done: number } | null
    /** Its latest meetings, newest first. */
    meetings: MeetingRow[]
  },
  who: { memberId: string; clock: Clock },
): Speech {
  const { project, openActions, counts } = data
  const { memberId, clock } = who
  const speech = new Speech()

  // Where it stands. A target date matters only while the project is still
  // going: once it's done (or called off), the date is history.
  const name = clause(project.name) || 'This project'
  const lead = project.lead_id && project.lead_id === memberId ? 'you' : clause(one(project.lead)?.display_name)
  const finished = project.status === 'completed' || project.status === 'canceled'
  const target = finished ? null : describeDay(project.target_date, clock)
  const slipped = !!target && isPastDay(project.target_date, clock)
  speech.say(
    [
      project.status ? `${name} is ${project.status.replace(/_/g, ' ')}` : name,
      lead && `led by ${lead}`,
      target && (slipped ? `and its target date, ${dayName(target)}, has passed` : `due ${target}`),
    ]
      .filter(Boolean)
      .join(', '),
  )
  if (project.is_archived) speech.say("It's archived")

  // How far along it is, then its open action items, the most pressing first.
  if (counts) speech.say(progressOf(counts, openActions, clock))
  sayActionItems(speech, pressing(openActions, clock), who, counts?.open ?? openActions.length)

  // What it's working towards next.
  const next = nextMilestone(data.milestones)
  const milestone = clause(next?.name)
  if (next && milestone) {
    const due = describeDay(next.target_date, clock)
    speech.say(
      `The next milestone is ${milestone}`,
      due && (isPastDay(next.target_date, clock) ? `, which was due ${due}` : `, due ${due}`),
    )
  }

  // Its latest meeting.
  const meeting = data.meetings[0]
  const met = meeting && [clause(meeting.title), describeWhen(meeting.started_at, clock)].filter(Boolean).join(', ')
  if (met) speech.say(`The latest meeting in it was ${met}`)
  return speech
}

export interface ProjectRow {
  id: string
  name: string | null
  /** planned | active | paused | completed | canceled */
  status: string | null
  /** A calendar day, "2026-10-16". */
  target_date: string | null
  is_archived: boolean | null
  lead_id: string | null
  lead: OneOrMany<{ display_name: string | null }>
}

export interface MilestoneRow {
  name: string
  /** pending | in_progress | completed */
  status: string
  target_date: string | null
}

export type { OpenActionRow } from './action-items'

export interface MeetingRow {
  title: string | null
  started_at: string | null
}

/** Of the milestones not reached, the one due soonest (an overdue one first),
 *  else the first in the project's order. */
function nextMilestone(milestones: MilestoneRow[]): MilestoneRow | null {
  const ahead = milestones.filter((m) => m.status !== 'completed')
  const dated = ahead
    .filter((m): m is MilestoneRow & { target_date: string } => !!m.target_date)
    .sort((a, b) => a.target_date.localeCompare(b.target_date))
  return dated[0] ?? ahead[0] ?? null
}
