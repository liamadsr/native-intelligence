/**
 * What the one agent editor may change for each kind of bot, and who may
 * change it (docs/plans/bots-v4.md, Phase B1; decisions 11 and 12). Pure and
 * client-safe: the editor reads it to draw each field (editable, or read-only
 * with the reason), and the routes read it to refuse a locked field.
 *
 * The editor has two parts:
 *   - THE AGENT, shared by every bot built on it (decision 11): its name in
 *     Personas, its sharing, description, instructions (the persona's
 *     `system_prompt`), which tools (its tool tree) and the skills it always
 *     checks (saved to every bot on it). The recipe's rule says who may change
 *     them (migration 191): its author, or a workspace owner or admin. A
 *     built-in agent (a Native Intelligence system recipe) is nobody's to change: "Make a
 *     copy for this bot" first.
 *   - THIS BOT, its own: name, face, voice (Phase B2: one of the desktop's
 *     voices, or Automatic), team, and what it may change on its own (its
 *     bounds, decision 12: owners and admins only). Face, name and voice stay
 *     each bot's own (decision 11): never copied across an agent's bots.
 *
 * The kind of bot decides what its editor offers at all (the plan's table):
 *   - a custom agent's bot: a full teammate, or a work bot for a plain member,
 *     which stays on its team and keeps a work bot's read-and-propose limits;
 *   - a role teammate (Researcher, Writer, Correspondent, Developer): like a
 *     custom agent's full teammate, on its `role-<role>` persona;
 *   - a system teammate (Triage, Extraction, Email drafts, Reconciler, and
 *     since bots-v4 Phase 5 the Assistant, which brings you the AI work no
 *     other teammate takes on): it speaks from its job, so only its name, face,
 *     voice and skills change (it is its own agent: no other bot shares its
 *     skills, so they follow the teammate rule, as before);
 *   - a loop's work bot: it speaks from its loops, so only its name, face and
 *     voice.
 */
import { isWorkRole } from '@/lib/work/roles'

/** Each skill a bot always checks loads in full into every prompt it has, so at most five. */
export const MAX_PINNED_SKILLS = 5

export type BotKind = 'agent_teammate' | 'agent_work_bot' | 'role_teammate' | 'system_teammate' | 'loop_work_bot'

/** The persona a bot is built on, as the rules see it. */
export type PersonaKind =
  /** This workspace's own agent recipe: a custom agent, or a role teammate's `role-<role>` persona. */
  | 'workspace'
  /** One of Native Intelligence's built-in agents (a system recipe). */
  | 'builtin'
  /** A system teammate's loop recipe or the loop work-bot anchor (migrations 283, 302), or anything else no session may bind. */
  | 'anchor'

/** The recipe facts {@link personaKindOf} reads. */
export interface PersonaRecipeFacts {
  is_system?: boolean | null
  workspace_id?: string | null
  category?: string | null
}

/**
 * What kind of persona a recipe is in `workspaceId`. The identity anchors are
 * neither system recipes nor any workspace's (workspace_id NULL, is_system
 * false), so they fall to 'anchor', as does another workspace's recipe.
 */
export function personaKindOf(recipe: PersonaRecipeFacts | null | undefined, workspaceId: string): PersonaKind {
  if (!recipe || (recipe.category != null && recipe.category !== 'agent')) return 'anchor'
  if (recipe.is_system === true) return 'builtin'
  if (recipe.workspace_id && recipe.workspace_id === workspaceId) return 'workspace'
  return 'anchor'
}

/** The teammate facts {@link botKindOf} reads. */
export interface BotKindFacts {
  is_system?: boolean | null
  fronts_only?: boolean | null
  role?: string | null
}

/** What kind of bot a teammate is, given the kind of persona it's built on. */
export function botKindOf(bot: BotKindFacts, persona: PersonaKind): BotKind {
  if (bot.is_system === true) return 'system_teammate'
  // A custom agent's work bot is built on the agent; a loop's on the anchor.
  if (bot.fronts_only === true) return persona === 'anchor' ? 'loop_work_bot' : 'agent_work_bot'
  if (isWorkRole(bot.role)) return 'role_teammate'
  return 'agent_teammate'
}

export const AGENT_FIELDS = ['agent_name', 'sharing', 'description', 'instructions', 'tools', 'skills'] as const
export type AgentField = (typeof AGENT_FIELDS)[number]
export const BOT_FIELDS = ['name', 'face', 'voice', 'team', 'bounds'] as const
export type BotField = (typeof BOT_FIELDS)[number]
export type EditorField = AgentField | BotField

export type FieldRule = { editable: true } | { editable: false; reason: string }

const OPEN: FieldRule = { editable: true }
const locked = (reason: string): FieldRule => ({ editable: false, reason })

/** Why a field is read-only, in the words the editor shows. */
export const FIELD_REASONS = {
  systemSpeaks: 'A built-in teammate speaks from its job, so this is built in.',
  systemTeam: 'A built-in teammate stays on the team it was set up on.',
  systemBounds: 'It reads, and settles or proposes what its own job leaves for you. That’s built in.',
  loopSpeaks: 'A loop’s agent speaks from the loops it fronts, so it has no instructions or tools of its own.',
  loopSkills: 'A loop’s agent runs its loops’ skills. Change them in the loop.',
  loopTeam: 'A loop’s agent stays on its loop’s team.',
  loopBounds: 'A loop’s agent reads and proposes changes for you to approve.',
  workBotTeam: 'A work agent stays on the team it was made on.',
  workBotBounds:
    'A work agent reads and proposes changes for you to approve. An owner, admin or team lead can field its persona as a full agent to let it do more.',
  builtinAgent: 'This persona is built into Native Intelligence. Make a copy for this agent to change it.',
  noAgent: 'This agent has no persona to change here.',
  hiddenAgent: 'It’s built on a persona only its author can see, so its persona can’t be changed here.',
  agentAuthorOnly: 'Only the persona’s author, or a workspace owner or admin, can change it.',
  agentBotAuthorOnly: 'This agent speaks for its persona: only the persona’s author, or a workspace owner or admin, can change it.',
  botManagersOnly: 'Only workspace admins and this team’s leads can change it.',
  boundsOwnersOnly: 'Only workspace owners and admins choose what an agent may change on its own.',
  unreachable: 'This agent is on a private team you’re not on.',
} as const

/** What each kind of bot can't change at all, whoever asks (the plan's field table). */
const KIND_LOCKS: Record<BotKind, Partial<Record<EditorField, string>>> = {
  agent_teammate: {},
  role_teammate: {},
  agent_work_bot: { team: FIELD_REASONS.workBotTeam, bounds: FIELD_REASONS.workBotBounds },
  system_teammate: {
    agent_name: FIELD_REASONS.systemSpeaks,
    sharing: FIELD_REASONS.systemSpeaks,
    description: FIELD_REASONS.systemSpeaks,
    instructions: FIELD_REASONS.systemSpeaks,
    tools: FIELD_REASONS.systemSpeaks,
    team: FIELD_REASONS.systemTeam,
    bounds: FIELD_REASONS.systemBounds,
  },
  loop_work_bot: {
    agent_name: FIELD_REASONS.loopSpeaks,
    sharing: FIELD_REASONS.loopSpeaks,
    description: FIELD_REASONS.loopSpeaks,
    instructions: FIELD_REASONS.loopSpeaks,
    tools: FIELD_REASONS.loopSpeaks,
    skills: FIELD_REASONS.loopSkills,
    team: FIELD_REASONS.loopTeam,
    bounds: FIELD_REASONS.loopBounds,
  },
}

/** Whether a kind of bot can change a field at all (before asking who). Every kind's voice is its own (Phase B2). */
export function kindAllows(kind: BotKind, field: EditorField): FieldRule {
  const reason = KIND_LOCKS[kind][field]
  return reason ? locked(reason) : OPEN
}

export function isOwnerOrAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** The person asking, as the rules need them. */
export interface EditorCaller {
  userId: string
  /** Their role in the bot's workspace. */
  role: string | null | undefined
  /** Whether they lead this bot's team. */
  leadsBotTeam?: boolean
  /** Whether they can reach this bot (the private-team rule, callerCanReachTeammate). Unset: yes. */
  reachesBot?: boolean
}

/** The persona facts the recipe's rule reads. */
export interface PersonaFacts {
  kind: PersonaKind
  createdBy?: string | null
}

/**
 * The recipe's rule (migration 191): its author, or a workspace owner or
 * admin. A built-in agent and an anchor are nobody's to change.
 */
export function personaRule(persona: PersonaFacts, caller: Pick<EditorCaller, 'userId' | 'role'>): FieldRule {
  if (persona.kind === 'builtin') return locked(FIELD_REASONS.builtinAgent)
  if (persona.kind === 'anchor') return locked(FIELD_REASONS.noAgent)
  if (persona.createdBy && persona.createdBy === caller.userId) return OPEN
  if (isOwnerOrAdmin(caller.role)) return OPEN
  return locked(FIELD_REASONS.agentAuthorOnly)
}

/**
 * The rule for a bot's own fields: a full teammate's are for owners, admins
 * and its team's leads (ai_team_member's RLS); a work bot's for anyone who can
 * edit what it fronts (the work-bot routes): a loop's bot fronts loops, which
 * any member may edit, so any member who can reach it; a custom agent's work
 * bot fronts its agent, so the agent's rule (its author, or an owner or
 * admin). Otherwise anyone who reaches a plain member's agent's bot could
 * point it at a copy of their own and speak through it.
 */
export function botRule(kind: BotKind, caller: EditorCaller, persona?: PersonaFacts): FieldRule {
  if (caller.reachesBot === false) return locked(FIELD_REASONS.unreachable)
  if (kind === 'loop_work_bot') return OPEN
  if (kind === 'agent_work_bot') {
    const rule = personaRule(persona ?? { kind: 'anchor' }, caller)
    return rule.editable || isOwnerOrAdmin(caller.role) ? OPEN : locked(FIELD_REASONS.agentBotAuthorOnly)
  }
  if (isOwnerOrAdmin(caller.role) || caller.leadsBotTeam === true) return OPEN
  return locked(FIELD_REASONS.botManagersOnly)
}

/** Whether `caller` may change `field` in this bot's editor: what the kind allows, then who may. */
export function fieldRule(args: { kind: BotKind; field: EditorField; persona: PersonaFacts; caller: EditorCaller }): FieldRule {
  const { kind, field, persona, caller } = args
  const byKind = kindAllows(kind, field)
  if (!byKind.editable) return byKind
  switch (field) {
    case 'bounds':
      if (caller.reachesBot === false) return locked(FIELD_REASONS.unreachable)
      return isOwnerOrAdmin(caller.role) ? OPEN : locked(FIELD_REASONS.boundsOwnersOnly)
    case 'name':
    case 'face':
    case 'voice':
    case 'team':
      return botRule(kind, caller, persona)
    case 'skills':
      // A system teammate is its own agent: its skills keep the teammate rule.
      return kind === 'system_teammate' ? botRule(kind, caller, persona) : personaRule(persona, caller)
    default:
      return personaRule(persona, caller)
  }
}

/** Which route saves a bot's skills: the agent's (every bot on it), the teammate's (a system teammate), or none. */
export function skillsRouteFor(kind: BotKind): 'agent' | 'bot' | null {
  if (kind === 'loop_work_bot') return null
  return kind === 'system_teammate' ? 'bot' : 'agent'
}

/** Whether "Make a copy for this bot" can point this kind of bot at a copy of its agent. */
export function mayRepointToCopy(kind: BotKind): boolean {
  return kind === 'agent_teammate' || kind === 'role_teammate' || kind === 'agent_work_bot'
}

// ── What a bot may change on its own (decision 12) ───────────────────────────

export type BoundsChoice = 'read' | 'internal'

/** The two choices, as `allowed_side_effects`. Sending, publishing and other outside writes are never one. */
export const BOUNDS_CLASSES: Readonly<Record<BoundsChoice, readonly string[]>> = {
  read: ['read'],
  internal: ['read', 'internal-write'],
}

export const BOUNDS_LABELS: Readonly<Record<BoundsChoice, string>> = {
  read: 'Read only',
  internal: 'Read, and change Native Intelligence records',
}

export const BOUNDS_HINTS: Readonly<Record<BoundsChoice, string>> = {
  read: 'It looks things up and can tell you what it would change.',
  internal: 'It can also update actions, documents, contacts and your other Native Intelligence records. Never sending, publishing or anything outside Native Intelligence.',
}

/** The choice a bot's classes read as: "Read, and change Native Intelligence records" once it holds internal writes. */
export function boundsChoiceOf(classes: readonly string[] | null | undefined): BoundsChoice {
  return Array.isArray(classes) && classes.includes('internal-write') ? 'internal' : 'read'
}

/** A requested `allowed_side_effects`, when it's exactly one of the two choices; else null. */
export function parseBounds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((c) => typeof c === 'string')) return null
  const asked = [...new Set(value as string[])].sort()
  for (const choice of Object.values(BOUNDS_CLASSES)) {
    const want = [...choice].sort()
    if (asked.length === want.length && asked.every((c, i) => c === want[i])) return [...choice]
  }
  return null
}

// ── Skills a bot always checks ───────────────────────────────────────────────

/** The skill recipe facts {@link isPinnableSkill} reads. */
export interface SkillRecipeFacts {
  category?: string | null
  is_system?: boolean | null
  workspace_id?: string | null
  visibility?: string | null
}

/**
 * Whether a skill may be one a bot always checks: this workspace's own or a
 * system one (the run_skill executor's fence), and never a personal one: a
 * pinned skill is written into everyone's chat with the bot, and a personal
 * skill's words are its author's alone.
 */
export function isPinnableSkill(skill: SkillRecipeFacts | null | undefined, workspaceId: string): boolean {
  if (!skill || skill.category !== 'skill') return false
  if (skill.visibility === 'personal') return false
  return skill.is_system === true || (!!skill.workspace_id && skill.workspace_id === workspaceId)
}

/** The name "Make a copy for this agent" gives the copy: "Researcher for Riley", or "Researcher (copy)". */
export function copyNameFor(agentName: string, botName: string): string {
  const agent = agentName.trim() || 'Agent'
  const bot = botName.trim()
  return bot && bot.toLowerCase() !== agent.toLowerCase() ? `${agent} for ${bot}` : `${agent} (copy)`
}
