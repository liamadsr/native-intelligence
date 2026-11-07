/**
 * The one agent editor's data and its save (docs/plans/bots-v4.md, Phase B1).
 * Client-safe and pure apart from the two runners, which take `fetch`.
 *
 *   - What the editor reads: GET /api/account/agent-editor, opened on an agent
 *     (the Personas page) or on a bot (its page's Customize). An agent with
 *     every bot on it the caller can reach; a bot whose persona is no agent of
 *     its own (a system teammate, a loop's work bot) alone.
 *   - How it saves: the agent first, then this bot, each through the route
 *     that checks its own rule (planEditorSave, runEditorSave):
 *       1. the agent's fields   PATCH /api/account/agents/[id]
 *       2. the agent's skills   PUT   /api/account/agents/[id]/skills (every bot on it)
 *       3. this bot's fields    PATCH /api/account/teams/[team]/ai-members/[id], or
 *                               PATCH /api/account/work-bots/[id] for a work bot
 *                               (its name, face, voice and team)
 *       4. its bounds           PATCH /api/account/workspace/agent-autonomy/teammates/[id]
 *     A step that fails stops the rest, and the editor says what saved and
 *     what didn't.
 *   - "Make a copy for this bot" (makeCopyForBot): the persona's copy, then
 *     this bot pointed at it, so an edit reaches it alone (decision 11).
 */
import {
  AGENT_FIELDS,
  BOT_FIELDS,
  BOUNDS_CLASSES,
  boundsChoiceOf,
  fieldRule,
  skillsRouteFor,
  type BotKind,
  type BoundsChoice,
  type EditorField,
  type FieldRule,
  type PersonaKind,
} from './editable-fields'

/** The persona, as the editor reads it (the recipe row, plus what kind it is). */
export interface EditorAgent {
  id: string
  name: string
  description: string | null
  system_prompt: string | null
  agent_config: Record<string, unknown> | null
  visibility: 'personal' | 'workspace' | 'public'
  is_system: boolean
  created_by: string | null
  icon: string | null
  color: string | null
  kind: PersonaKind
}

/** A bot, as the editor reads it. */
export interface EditorBot {
  id: string
  name: string
  team_id: string | null
  team_name: string | null
  bot_character: string | null
  /** The voice it chose (`ai_team_member.voice`, migration 308): a desktop voice id; null or absent, Automatic. */
  voice?: string | null
  is_system: boolean
  system_key: string | null
  fronts_only: boolean
  role: string | null
  autonomy: string | null
  allowed_side_effects: string[]
  /** The skills it always checks, in order. */
  skill_ids: string[]
  kind: BotKind
  /** What it speaks from when it has no agent of its own: a system teammate's job, a loop bot's loops. */
  about: string | null
}

/** A face worn in the workspace (for the face picker's warning), and the voice it chose (for the voice picker's). */
export interface EditorFace {
  id: string
  name: string | null
  bot_character: string
  /** Set only when it chose one (workspace-faces.ts). */
  voice?: string
}

/** What GET /api/account/agent-editor answers. */
export interface AgentEditorData {
  /** The agent; null for a bot built on no agent of its own (a system teammate, a loop's work bot). */
  agent: EditorAgent | null
  /** The bots on it the caller can reach, oldest first. */
  bots: EditorBot[]
  /** Bots on it the caller can't reach (a private team they aren't on): a save changes them too. */
  hidden_bots: number
  /** The bot the editor opens on: the one asked for, else the agent's first. */
  focus: string | null
  caller: { user_id: string; role: string | null; lead_team_ids: string[] }
  /** The teams the caller may put a full teammate on. */
  teams: Array<{ id: string; name: string; is_private: boolean }>
  workspace_faces: EditorFace[]
}

/** Every field's rule for one bot of the editor (or for the agent alone, with no bot). */
export function editorRules(data: Pick<AgentEditorData, 'agent' | 'caller'>, bot: EditorBot | null): Record<EditorField, FieldRule> {
  const persona = { kind: data.agent?.kind ?? ('anchor' as const), createdBy: data.agent?.created_by ?? null }
  const caller = {
    userId: data.caller.user_id,
    role: data.caller.role,
    leadsBotTeam: !!bot?.team_id && data.caller.lead_team_ids.includes(bot.team_id),
    reachesBot: true,
  }
  // No bot yet (an agent with none): the agent's fields follow its rule; the bot's wait for one.
  const kind: BotKind = bot?.kind ?? 'agent_teammate'
  const out = {} as Record<EditorField, FieldRule>
  for (const field of [...AGENT_FIELDS, ...BOT_FIELDS]) {
    out[field] = fieldRule({ kind, field, persona, caller })
  }
  return out
}

/** "Riley in Sales, Writer in Ops, and 1 on a private team": the other bots a save of the agent changes. */
export function otherBotsPhrase(bots: ReadonlyArray<Pick<EditorBot, 'name' | 'team_name'>>, hidden: number): string {
  const named = bots.map((b) => (b.team_name ? `${b.name} in ${b.team_name}` : b.name))
  if (hidden > 0) named.push(`${hidden} on ${hidden === 1 ? 'a private team' : 'private teams'}`)
  if (named.length <= 1) return named[0] ?? ''
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}

/** The agent's fields as the PATCH takes them (buildSubmitBody's agent body). */
export interface AgentFields {
  name: string
  visibility: 'personal' | 'workspace' | 'public'
  description?: string
  system_prompt: string
  agent_config: Record<string, unknown>
}

/** This bot's own fields, as the editor holds them. */
export interface BotFields {
  name: string
  bot_character: string | null
  /** A desktop voice id; null or absent, Automatic. */
  voice?: string | null
  team_id: string | null
  bounds: BoundsChoice
}

export function botFieldsOf(bot: EditorBot): BotFields {
  return {
    name: bot.name,
    bot_character: bot.bot_character,
    voice: bot.voice ?? null,
    team_id: bot.team_id,
    bounds: boundsChoiceOf(bot.allowed_side_effects),
  }
}

/** One request of a save, in order. `label` says what it saves, for "what didn't save". */
export interface SaveStep {
  key: 'agent' | 'new_bot' | 'agent_skills' | 'bot' | 'bounds'
  label: string
  method: 'POST' | 'PATCH' | 'PUT'
  url: string
  body: Record<string, unknown>
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Which editor field each agent key belongs to. */
const AGENT_KEY_FIELD: Record<keyof AgentFields, EditorField> = {
  name: 'agent_name',
  visibility: 'sharing',
  description: 'description',
  system_prompt: 'instructions',
  agent_config: 'tools',
}

/**
 * The requests a save makes, agent first, then this bot. Only what changed is
 * sent, and only what the rules let this caller change (a locked field the
 * editor drew read-only never reaches a route). With `newBot` (or
 * `newBotFace`, a face to start it on), a persona with no teammate is given
 * one (after its own fields, so a personal persona just shared gets it),
 * before its skills, which live on its teammates; `newBotVoice` is the voice
 * it starts with (none: Automatic).
 *
 * A voice is this bot's own (decision 11): it goes in this bot's step only,
 * never the agent's, so it reaches no other bot on the agent. Null is a
 * change too: back to Automatic.
 */
export function planEditorSave(args: {
  agentId: string | null
  bot: EditorBot | null
  rules: Record<EditorField, FieldRule>
  agentBefore: AgentFields | null
  agentAfter: AgentFields | null
  skillsBefore: readonly string[]
  skillsAfter: readonly string[]
  botBefore: BotFields | null
  botAfter: BotFields | null
  newBot?: boolean
  newBotFace?: string | null
  newBotVoice?: string | null
}): SaveStep[] {
  const { agentId, bot, rules } = args
  const steps: SaveStep[] = []

  if (agentId && args.agentBefore && args.agentAfter) {
    const body: Record<string, unknown> = {}
    for (const key of Object.keys(AGENT_KEY_FIELD) as Array<keyof AgentFields>) {
      if (!rules[AGENT_KEY_FIELD[key]].editable) continue
      const before = key === 'description' ? (args.agentBefore.description ?? '') : args.agentBefore[key]
      const after = key === 'description' ? (args.agentAfter.description ?? '') : args.agentAfter[key]
      if (!same(before, after)) body[key] = after
    }
    if (Object.keys(body).length > 0) {
      steps.push({ key: 'agent', label: 'the persona', method: 'PATCH', url: `/api/account/agents/${agentId}`, body })
    }
  }

  if (agentId && !bot && (args.newBot || args.newBotFace)) {
    steps.push({
      key: 'new_bot',
      label: 'its agent',
      method: 'POST',
      url: `/api/account/agents/${agentId}/bot`,
      body: { ...(args.newBotFace ? { bot_character: args.newBotFace } : {}), ...(args.newBotVoice ? { voice: args.newBotVoice } : {}) },
    })
  }

  const skillsChanged = !same(args.skillsBefore, args.skillsAfter) && rules.skills.editable
  const skillsRoute = bot ? skillsRouteFor(bot.kind) : 'agent'
  if (skillsChanged && skillsRoute === 'agent' && agentId) {
    steps.push({
      key: 'agent_skills',
      label: 'the skills it always checks',
      method: 'PUT',
      url: `/api/account/agents/${agentId}/skills`,
      body: { skill_recipe_ids: [...args.skillsAfter] },
    })
  }

  if (bot && args.botBefore && args.botAfter) {
    const before = args.botBefore
    const after = args.botAfter
    const body: Record<string, unknown> = {}
    const name = after.name.trim()
    if (rules.name.editable && name && name !== before.name) body.name = name
    if (rules.face.editable && after.bot_character && after.bot_character !== before.bot_character) body.bot_character = after.bot_character
    if (rules.voice.editable && (after.voice ?? null) !== (before.voice ?? null)) body.voice = after.voice ?? null
    const workBot = bot.kind === 'agent_work_bot' || bot.kind === 'loop_work_bot'
    if (!workBot && rules.team.editable && after.team_id && after.team_id !== before.team_id) body.team_id = after.team_id
    if (skillsChanged && skillsRoute === 'bot') body.skill_recipe_ids = [...args.skillsAfter]
    if (Object.keys(body).length > 0) {
      steps.push({
        key: 'bot',
        label: 'this agent',
        method: 'PATCH',
        // A work bot saves through its own route; a full teammate through its team's, at the team it's on now.
        url: workBot ? `/api/account/work-bots/${bot.id}` : `/api/account/teams/${bot.team_id}/ai-members/${bot.id}`,
        body,
      })
    }
    if (rules.bounds.editable && after.bounds !== before.bounds) {
      steps.push({
        key: 'bounds',
        label: 'what it may change on its own',
        method: 'PATCH',
        url: `/api/account/workspace/agent-autonomy/teammates/${bot.id}`,
        body: { allowed_side_effects: [...BOUNDS_CLASSES[after.bounds]] },
      })
    }
  }
  return steps
}

/**
 * How a save went. `warnings`: what a step that did save says it missed (a new
 * bot made without its agent's skills: `skills_error`), to show beside the
 * outcome.
 */
export type SaveOutcome =
  | { ok: true; saved: string[]; warnings: string[] }
  | { ok: false; saved: string[]; notSaved: string[]; error: string; warnings: string[] }

/** Headers that point a request at the bot's workspace when it isn't the active one. */
export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> {
  return workspaceId ? { 'x-workspace-id': workspaceId } : {}
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' && body.error ? body.error : fallback
}

/** What a step that saved says it missed, or null. */
async function warningOf(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { skills_error?: unknown } | null
  return typeof body?.skills_error === 'string' && body.skills_error ? body.skills_error : null
}

/** Run a save's steps in order; the first that fails stops the rest. */
export async function runEditorSave(
  steps: readonly SaveStep[],
  opts: { fetcher?: typeof fetch; workspaceId?: string | null } = {},
): Promise<SaveOutcome> {
  const fetcher = opts.fetcher ?? fetch
  const saved: string[] = []
  const warnings: string[] = []
  for (const [index, step] of steps.entries()) {
    let res: Response
    try {
      res = await fetcher(step.url, {
        method: step.method,
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders(opts.workspaceId) },
        body: JSON.stringify(step.body),
      })
    } catch {
      return { ok: false, saved, notSaved: steps.slice(index).map((s) => s.label), error: 'The network failed.', warnings }
    }
    if (!res.ok) {
      return { ok: false, saved, notSaved: steps.slice(index).map((s) => s.label), error: await errorOf(res, `Couldn’t save ${step.label}.`), warnings }
    }
    saved.push(step.label)
    // A new bot's own skills come next when the save sets them: only then is a missed copy moot.
    const warning = step.key === 'new_bot' && !steps.some((s) => s.key === 'agent_skills') ? await warningOf(res) : null
    if (warning) warnings.push(warning)
  }
  return { ok: true, saved, warnings }
}

/** "Saved the persona. Didn't save this agent: <why>" for a save that stopped part way. */
export function saveFailureMessage(outcome: Extract<SaveOutcome, { ok: false }>): string {
  const head = outcome.saved.length > 0 ? `Saved ${outcome.saved.join(' and ')}. ` : ''
  return `${head}Didn’t save ${outcome.notSaved.join(' or ')}: ${outcome.error}`
}

export type CopyOutcome = { ok: true; agentId: string } | { ok: false; error: string }

/**
 * "Make a copy for this bot": copy the persona (POST .../copy, `forked_from`),
 * then point this bot at the copy, through its own route (ai-members for a
 * full teammate, work-bots for a work bot). The bot keeps its skills (they
 * live on it). If the bot can't be pointed at the copy, the copy is deleted
 * again, so nothing is left behind.
 */
export async function makeCopyForBot(args: {
  agentId: string
  bot: Pick<EditorBot, 'id' | 'team_id' | 'kind'>
  name: string
  fetcher?: typeof fetch
  workspaceId?: string | null
}): Promise<CopyOutcome> {
  const fetcher = args.fetcher ?? fetch
  const headers = { 'Content-Type': 'application/json', ...workspaceHeaders(args.workspaceId) }
  const copied = await fetcher(`/api/account/agents/${args.agentId}/copy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: args.name }),
  }).catch(() => null)
  if (!copied) return { ok: false, error: 'The network failed.' }
  if (!copied.ok) return { ok: false, error: await errorOf(copied, 'Couldn’t copy the persona.') }
  const copyId = ((await copied.json().catch(() => null)) as { agent?: { id?: string } } | null)?.agent?.id
  if (!copyId) return { ok: false, error: 'Couldn’t copy the persona.' }

  const workBot = args.bot.kind === 'agent_work_bot'
  const repoint = await fetcher(
    workBot ? `/api/account/work-bots/${args.bot.id}` : `/api/account/teams/${args.bot.team_id}/ai-members/${args.bot.id}`,
    { method: 'PATCH', headers, body: JSON.stringify({ agent_recipe_id: copyId }) },
  ).catch(() => null)
  if (!repoint || !repoint.ok) {
    const error = repoint ? await errorOf(repoint, 'Couldn’t point this agent at the copy.') : 'The network failed.'
    // The copy is the caller's own: they may delete it.
    await fetcher(`/api/account/agents/${copyId}`, { method: 'DELETE', headers: workspaceHeaders(args.workspaceId) }).catch(() => null)
    return { ok: false, error }
  }
  return { ok: true, agentId: copyId }
}
