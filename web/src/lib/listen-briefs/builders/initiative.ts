import { rows, type BriefContext, type Result } from '../context'
import { Speech, clause, count, listOf, one, type OneOrMany } from '../speech'
import { describeDay, isPastDay, type Clock } from '../when'
import { dayName, pressing, progressOf, readOpenActions, sayActionItems, type OpenActionRow } from './action-items'

/**
 * An initiative (the goal a set of projects works towards): where it stands
 * (its status, who owns it, and when it's due or that its target date has
 * passed), its projects by name, then how far along their actions are and
 * the open ones one by one, the most pressing first (Liam, 2026-09-28: "now
 * lets do the same thing for projects and initiatives").
 *
 *   "Growth 2026 is active, owned by you, due on December 31. It has three
 *    projects: Q4 Launch, Pricing revamp and Beta program. Six actions are
 *    open, two of them overdue, and nine are done. Fix the checkout bug,
 *    assigned to you, overdue since Thursday. …"
 *
 * Read on the user's own client, in this workspace, as the initiative detail
 * route reads it. Its actions are its projects' actions.
 */
export async function initiativeSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, workspaceId } = ctx

  const [initiativeRes, projectsRes, standing] = await Promise.all([
    supabase
      .from('initiative')
      .select('id, name, status, target_date, owner_id, owner:member!owner_id(display_name)')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('projects')
      .select('name')
      .eq('initiative_id', id)
      .eq('workspace_id', workspaceId)
      .order('sort_order', { ascending: true })
      .limit(PROJECT_SCAN),
    readOpenActions(ctx, { initiativeId: id }),
  ])

  if (initiativeRes.error) {
    console.warn('[listen-brief] initiative failed:', initiativeRes.error.message)
    return null
  }
  const initiative = initiativeRes.data as InitiativeRow | null
  if (!initiative) return null

  return initiativeWords(
    {
      initiative,
      projects: rows('projects', projectsRes as Result<ProjectRef>),
      openActions: standing.openActions,
      counts: standing.counts,
    },
    ctx,
  )
}

/** Its projects read by name (an initiative has a handful). */
const PROJECT_SCAN = 100

/** What the rows say, as words. Pure. */
export function initiativeWords(
  data: {
    initiative: InitiativeRow
    /** Its projects, in its own order. */
    projects: ProjectRef[]
    /** The open actions across its projects, soonest due first: all of them,
     *  or the first OPEN_SCAN. */
    openActions: OpenActionRow[]
    /** Every open and done action across its projects; null when they could
     *  not be counted. */
    counts: { open: number; done: number } | null
  },
  who: { memberId: string; clock: Clock },
): Speech {
  const { initiative, projects, openActions, counts } = data
  const { memberId, clock } = who
  const speech = new Speech()

  // Where it stands. A target date matters only while it's still going.
  const name = clause(initiative.name) || 'This initiative'
  const owner = initiative.owner_id && initiative.owner_id === memberId ? 'you' : clause(one(initiative.owner)?.display_name)
  const finished = initiative.status === 'completed' || initiative.status === 'archived'
  const target = finished ? null : describeDay(initiative.target_date, clock)
  const slipped = !!target && isPastDay(initiative.target_date, clock)
  speech.say(
    [
      initiative.status ? `${name} is ${initiative.status}` : name,
      owner && `owned by ${owner}`,
      target && (slipped ? `and its target date, ${dayName(target)}, has passed` : `due ${target}`),
    ]
      .filter(Boolean)
      .join(', '),
  )

  // Its projects, by name. With none, it has no actions either.
  if (!projects.length) {
    speech.say('It has no projects yet')
    return speech
  }
  const names = listOf(projects.map((p) => clause(p.name)))
  speech.say(
    projects.length === 1
      ? ['It has one project', names].filter(Boolean).join(', ')
      : `It has ${count(projects.length, 'project')}${names ? `: ${names}` : ''}`,
  )

  // How far along their actions are, then the open ones, the most pressing first.
  if (counts) speech.say(progressOf(counts, openActions, clock))
  sayActionItems(speech, pressing(openActions, clock), who, counts?.open ?? openActions.length)
  return speech
}

export interface InitiativeRow {
  id: string
  name: string | null
  /** planned | active | completed | archived */
  status: string | null
  /** A calendar day, "2026-12-31". */
  target_date: string | null
  owner_id: string | null
  owner: OneOrMany<{ display_name: string | null }>
}

export interface ProjectRef {
  name: string | null
}
