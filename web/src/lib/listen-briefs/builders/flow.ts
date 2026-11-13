import { row, rows, type BriefContext, type OneResult, type Result } from '../context'
import { Speech, clause, count, listOf, numberWord } from '../speech'
import { describeWhen, type Clock } from '../when'

/**
 * A flow (an automation): what it's called and whether it's on, what it's
 * for, when it runs, what it does step by step, then when it runs next and
 * how its last run went (Liam, 2026-09-28: "when you click into a flow, it
 * tells you what the flow does at a high level").
 *
 *   "Weekly digest, a flow. Sums up the week for the team. It runs every
 *    Friday at 4 PM. It runs the Weekly digest skill, saves the result as a
 *    document and notifies you. It runs next on Friday at 4 PM. It last ran
 *    last Friday at 4 PM, and it worked."
 *
 * Plain words from the flow's own settings, no model (listen briefs never use
 * one). Read on the user's own client, in this workspace, as the flow routes
 * read it; its runs through flow_run's own fence (the flow's workspace).
 */
export async function flowSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, workspaceId } = ctx

  const flowRes = await supabase
    .from('flow')
    .select('id, name, description, enabled, trigger_type, trigger_config, actions, next_run_at')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (flowRes.error) {
    console.warn('[listen-brief] flow failed:', flowRes.error.message)
    return null
  }
  const flow = flowRes.data as FlowRow | null
  if (!flow) return null

  // What its steps and trigger name by id: skills and agents, and the board
  // states an action moves between.
  const steps = stepsOf(flow.actions)
  const recipeIds = [...new Set(steps.flatMap((s) => [s.config.skill_id, s.config.agent_id]).filter(isId))]
  const trigger = flow.trigger_config ?? {}
  const stateIds =
    flow.trigger_type === 'entity_status_change' && (trigger.entity_type ?? 'action') === 'action'
      ? [trigger.from_status_id, trigger.to_status_id].filter(isId)
      : []
  const [recipesRes, statesRes, lastRunRes] = await Promise.all([
    recipeIds.length ? supabase.from('recipe').select('id, name').in('id', recipeIds) : NO_ROWS,
    stateIds.length ? supabase.from('workflow_state').select('id, name').in('id', stateIds) : NO_ROWS,
    supabase.from('flow_run').select('status, fired_at').eq('flow_id', flow.id).order('fired_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const names = new Map<string, string>()
  for (const r of [...rows('flow recipes', recipesRes as Result<NamedRow>), ...rows('flow states', statesRes as Result<NamedRow>)]) {
    if (r.name) names.set(r.id, r.name)
  }
  return flowWords({ flow, names, lastRun: row('last run', lastRunRes as OneResult<RunRow>) }, ctx)
}

type NamedRow = { id: string; name: string | null }
const NO_ROWS: Promise<Result<NamedRow>> = Promise.resolve({ data: [], error: null })

/** Steps read one by one; past these, "and N more". */
const MAX_STEPS = 5

/** What the rows say, as words. Pure. `names`: recipe and board-state names by id. */
export function flowWords(
  data: { flow: FlowRow; names: ReadonlyMap<string, string>; lastRun: RunRow | null },
  who: { clock: Clock },
): Speech {
  const { flow, names, lastRun } = data
  const { clock } = who
  const speech = new Speech()

  // What it is, whether it's on, and what it's for.
  speech.say(`${clause(flow.name) || 'This flow'}, ${flow.enabled ? 'a flow' : 'a paused flow'}`)
  speech.say(flow.description)

  // When it runs.
  speech.say(whenItRuns(flow, names, clock))

  // What it does, step by step.
  const steps = stepsOf(flow.actions)
  const on = steps.filter((s) => s.enabled)
  if (!on.length) speech.say(steps.length ? 'All its steps are turned off' : "It doesn't have any steps yet")
  on.slice(0, MAX_STEPS).forEach((step, i) => {
    const does = whatItDoes(step, names)
    const gated = step.conditioned ? ', when its conditions match' : ''
    speech.say(`${i === 0 ? 'It' : 'Then it'} ${does}${gated}`)
  })
  if (on.length > MAX_STEPS) speech.say(`And ${count(on.length - MAX_STEPS, 'more step')}`)
  const off = steps.length - on.length
  if (on.length && off) speech.say(off === 1 ? 'One step is turned off' : `${numberWord(off)} steps are turned off`)

  // When it runs next (a clock it keeps), and how its last run went.
  const next = flow.enabled ? describeWhen(flow.next_run_at, clock) : null
  if (next && Date.parse(flow.next_run_at ?? '') > clock.now.getTime()) speech.say(`It runs next ${next}`)
  const last = lastRun ? describeWhen(lastRun.fired_at, clock) : null
  if (!lastRun) speech.say("It hasn't run yet")
  else if (lastRun.status === 'success') speech.say(`It last ran ${last}, and it worked`)
  else if (lastRun.status === 'failed') speech.say(`Its last run, ${last}, failed`)
  else speech.say(`Its last run started ${last} and hasn't finished`)
  return speech
}

/** "It runs every weekday at 9 AM", "It runs after every meeting, once its
 *  notes are ready", "It runs when an action moves to Done", "It runs 30
 *  minutes before each Couples Counseling". */
function whenItRuns(flow: FlowRow, names: ReadonlyMap<string, string>, clock: Clock): string | null {
  const t = flow.trigger_config ?? {}
  switch (flow.trigger_type) {
    case 'schedule': {
      const at = clockTime(t.time)
      const zone = t.timezone && t.timezone !== clock.timeZone ? `, ${cityOf(t.timezone)} time` : ''
      switch (t.cadence) {
        case 'hourly':
          return 'It runs every hour'
        case 'daily':
          return at && `It runs every day at ${at}${zone}`
        case 'weekdays':
          return at && `It runs every weekday at ${at}${zone}`
        case 'weekly': {
          const day = typeof t.weekday === 'number' ? WEEKDAYS[t.weekday] : undefined
          return day && at ? `It runs every ${day} at ${at}${zone}` : null
        }
        case 'monthly':
          return typeof t.day_of_month === 'number' && at ? `It runs every month on the ${ordinal(t.day_of_month)} at ${at}${zone}` : null
        case 'cron':
          return 'It runs on a custom schedule'
        case 'once':
          return 'It runs one time'
        default:
          return null
      }
    }
    case 'capture_processed':
      return 'It runs after every meeting, once its notes are ready'
    case 'calendar_event': {
      const event = clause(t.event_title)
      if (!event) return null
      const minutes = typeof t.offset_minutes === 'number' ? t.offset_minutes : 0
      if (minutes === 0) return `It runs as each ${event} starts`
      return `It runs ${span(Math.abs(minutes))} ${minutes < 0 ? 'before' : 'after'} each ${event}`
    }
    case 'entity_status_change': {
      const entity = t.entity_type ?? 'action'
      const state = (id: string | null | undefined) =>
        id ? (entity === 'action' ? names.get(id) : id.replace(/_/g, ' ')) : undefined
      const to = state(t.to_status_id)
      const from = state(t.from_status_id)
      const a = entity === 'action' || entity === 'initiative' ? 'an' : 'a'
      if (!to) return `It runs when ${a} ${entity} changes status`
      return `It runs when ${a} ${entity} moves ${from ? `from ${from} ` : ''}to ${to}`
    }
    case 'pr_status_changed':
      return "It runs when a pull request's status changes"
    case 'quote_received':
      return "It runs when a customer's quote arrives from the website"
    case 'email_received':
      return 'It runs when new mail arrives in your inbox'
    case 'chat_message':
      return t.mentions_only ? 'It runs when someone mentions you in team chat' : 'It runs when someone posts in a team chat channel'
    case 'document_created':
      return 'It runs when someone creates a document'
    default:
      return null
  }
}

/** What one step does: "runs the Weekly digest skill, saves the result as a
 *  document and notifies you", "sends the details to hooks.acme.com",
 *  "archives the meeting". */
function whatItDoes(step: Step, names: ReadonlyMap<string, string>): string {
  const c = step.config
  switch (step.type) {
    case 'run_skill': {
      const skill = isId(c.skill_id) && names.get(c.skill_id)
      const runs = skill ? `runs the ${skill} skill` : 'runs a skill'
      const acts = c.mode === 'act' ? ', which can make changes' : ''
      const deliver = (c.deliver ?? {}) as { document?: boolean; notification?: boolean }
      const outputs = [deliver.document !== false && 'saves the result as a document', deliver.notification !== false && 'notifies you']
      return listOf([`${runs}${acts}`, ...outputs.filter((o): o is string => !!o)], 3) ?? runs
    }
    case 'run_agent': {
      const agent = isId(c.agent_id) && names.get(c.agent_id)
      const repo = typeof c.repo === 'string' && c.repo.trim() ? ` on ${c.repo.trim()}` : ''
      return agent ? `hands the work to the ${agent} agent${repo}` : `hands the work to a coding agent${repo}`
    }
    case 'archive_capture':
      return 'archives the meeting'
    case 'run_local_agent':
      return c.mode === 'edit' ? 'starts a job on your Mac that may change files' : 'starts a job on your Mac'
    case 'http_post':
    default:
      return `sends the details to ${hostOf(c.url) ?? 'a web address'}`
  }
}

/** A step as stored in the flow's `actions` jsonb (the flows validator's
 *  shape, read loosely: a malformed step is left out). */
interface Step {
  type: string
  config: Record<string, unknown> & { skill_id?: unknown; agent_id?: unknown }
  enabled: boolean
  /** It has a condition with at least one rule. */
  conditioned: boolean
}

function stepsOf(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((a): Step[] => {
    if (!a || typeof a !== 'object') return []
    const s = a as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.type !== 'string') return []
    const condition = s.condition as { rules?: unknown } | null | undefined
    return [
      {
        type: s.type,
        config: s.config && typeof s.config === 'object' ? (s.config as Step['config']) : {},
        enabled: s.enabled !== false,
        conditioned: Array.isArray(condition?.rules) && condition.rules.length > 0,
      },
    ]
  })
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** '09:00' → "9 AM", '16:30' → "4:30 PM", '12:00' → "noon", '00:00' → "midnight". */
function clockTime(value: unknown): string | null {
  const m = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  if (min === 0 && h === 12) return 'noon'
  if (min === 0 && h === 0) return 'midnight'
  return `${h % 12 || 12}${min ? `:${m[2]}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

/** 'America/New_York' → "New York". */
function cityOf(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ')
}

/** 30 → "30 minutes", 60 → "an hour", 120 → "2 hours", 90 → "90 minutes". */
/** 1 → "1st", 2 → "2nd", 23 → "23rd". */
function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function span(minutes: number): string {
  if (minutes === 60) return 'an hour'
  if (minutes % 60 === 0) return `${minutes / 60} hours`
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/** A web address said by its host: "https://hooks.acme.com/x?y" → "hooks.acme.com". */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).host.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

export interface FlowRow {
  id: string
  name: string | null
  description: string | null
  enabled: boolean | null
  /** entity_status_change | capture_processed | pr_status_changed | schedule | calendar_event | quote_received | email_received | chat_message | document_created */
  trigger_type: string | null
  trigger_config: {
    cadence?: string
    time?: string
    weekday?: number
    day_of_month?: number
    timezone?: string
    mentions_only?: boolean
    event_title?: string
    offset_minutes?: number
    entity_type?: string
    from_status_id?: string | null
    to_status_id?: string
  } | null
  actions: unknown
  next_run_at: string | null
}

export interface RunRow {
  /** pending | success | failed */
  status: string | null
  fired_at: string | null
}
