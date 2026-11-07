/**
 * One face for the agent (docs/plans/always-on-agent.md §2c "One face",
 * decision 11): the main agent has one face and one name everywhere, and the
 * area faces (Captures, Mail, Prospecting, Evals, CRM; migration 318) stop
 * being characters of their own. Work still records its area and its area
 * face (the `ai_team_member` rows stay as attribution), so this is display
 * only: who a row shows with is the owner rule's (lib/work/bot-owner.ts: an
 * area face's work shows with its workspace's Assistant), and how the
 * teammates are drawn is this module's.
 *
 *   - The agent's look is ONE character everywhere (AGENT_FACE, `chat` for
 *     now), whatever each workspace's Assistant row wears in `bot_character`.
 *   - Its name is the person's saved assistant name (Settings → Preferences,
 *     device-only: lib/voice/assistant-name.ts), else "Assistant". The server
 *     can't see a device-only name, so the client names it (agentName).
 *   - An area face is never drawn or listed (isAreaFaceTeammate): the crew,
 *     the roamers, the desktop's cast and the For you column leave it out
 *     (teammate-faces.ts drawnBots), and anything
 *     that names one (a deep link, an old notice) opens the agent instead
 *     (agentTeammateIdFor).
 *   - The face collision guard: a teammate other than the Assistant wearing
 *     AGENT_FACE would be drawn as part of the agent (one bot per face), so
 *     the face picker no longer offers the agent's face to anyone
 *     (bot-face-picker.tsx), and no default hands it out
 *     (RESERVED_BOT_CHARACTERS). One that already wears it (from before
 *     bots-v4 decision 7's back-fill) keeps it, and its bubble's switcher
 *     tells it from the agent.
 *
 * Custom agents, role teammates and loop bots keep their own faces (decision 12).
 *
 * Pure (no React, no server imports), so the client, the server and the tests
 * share it.
 */
import type { BotCharacterType } from '@/lib/bots/bot-faces'
import { ASSISTANT_SYSTEM_KEY } from '@/lib/work/bot-owner'
import { isAreaFaceKey, type AreaFaceKey } from '@/lib/work/work-area'

/** The agent's one look (the catalogue's Assistant, migration 310's reserved face). */
export const AGENT_FACE: BotCharacterType = 'chat'

/**
 * Why a write is refused the agent's face (the server-side face reservation:
 * one face, always-on-agent §2c). Starts with the field's name, so a caller
 * that names the field from the message (flows.ts) names this one.
 */
export const AGENT_FACE_RESERVED_ERROR = 'bot_character "chat" is your assistant’s own character: pick another one for this agent'

/**
 * Whether a write may put `face` on a teammate: anything but the agent's face
 * on anyone, and the agent's face only on a workspace's Assistant (`target`,
 * the row written; absent for a new teammate, which is never the Assistant).
 * The face picker hides it too (bot-face-picker.tsx); this is the server's
 * side, in every write that sets bot_character.
 */
export function agentFaceRefused(
  face: unknown,
  target?: Pick<AgentFaceFacts, 'is_system' | 'system_key'> | null,
): boolean {
  return face === AGENT_FACE && !isAgentTeammate(target)
}

/** The agent's name when the person hasn't saved one of their own. */
export const AGENT_DEFAULT_NAME = 'Assistant'

/** What the rule reads of a teammate. */
export interface AgentFaceFacts {
  id?: string
  workspace_id?: string
  is_system?: boolean | null
  system_key?: string | null
  bot_character?: string | null
  name?: string | null
}

/** The workspace's Assistant system teammate: the agent's own row (the anchor for attribution, counts and notices). */
export function isAgentTeammate(t: Pick<AgentFaceFacts, 'is_system' | 'system_key'> | null | undefined): boolean {
  return t?.is_system === true && t.system_key === ASSISTANT_SYSTEM_KEY
}

/** An area face (migration 318): attribution only, never drawn, its work the agent's. */
export function isAreaFaceTeammate(t: Pick<AgentFaceFacts, 'is_system' | 'system_key'> | null | undefined): boolean {
  return t?.is_system === true && isAreaFaceKey(t.system_key)
}

/** The area an area face stands for, or null for any other teammate. */
export function areaFaceKeyOf(t: Pick<AgentFaceFacts, 'is_system' | 'system_key'> | null | undefined): AreaFaceKey | null {
  return t && isAreaFaceTeammate(t) ? (t.system_key as AreaFaceKey) : null
}

/** The agent's name: the person's saved assistant name, else "Assistant". */
export function agentName(saved: string | null | undefined): string {
  const name = typeof saved === 'string' ? saved.trim() : ''
  return name || AGENT_DEFAULT_NAME
}

/**
 * A teammate as the one-face rule draws it: the Assistant wearing AGENT_FACE
 * (and `name`, when given); anyone else as it is. The same object when
 * nothing changes.
 */
export function withAgentFace<T extends AgentFaceFacts>(t: T, name?: string | null): T {
  if (!isAgentTeammate(t)) return t
  const named = name ? name : t.name
  if (t.bot_character === AGENT_FACE && named === t.name) return t
  return { ...t, bot_character: AGENT_FACE, name: named } as T
}

/**
 * A roster as the one-face rule has it (withAgentFace on each entry; the area
 * faces are kept, so an id that names one still resolves: agentTeammateIdFor,
 * and the owner rule reads them). The same array when nothing changes.
 */
export function agentFacedRoster<T extends AgentFaceFacts>(roster: readonly T[], name?: string | null): T[] {
  let out: T[] | null = null
  for (let i = 0; i < roster.length; i++) {
    const next = withAgentFace(roster[i], name)
    if (next !== roster[i] && !out) out = roster.slice(0, i)
    out?.push(next)
  }
  return out ?? (roster as T[])
}

/**
 * The teammates the one-face rule draws, each as withAgentFace draws it:
 * every one but the area faces whose workspace's Assistant is in the roster
 * (their work shows with it: bot-owner.ts). An area face whose Assistant
 * isn't held keeps its work (the owner rule moves nothing without one), so
 * it stays drawn rather than its work showing nowhere.
 */
export function withoutAreaFaces<T extends AgentFaceFacts>(roster: readonly T[]): T[] {
  const agents = new Set<string>()
  for (const t of roster) if (isAgentTeammate(t) && t.workspace_id) agents.add(t.workspace_id)
  return agentFacedRoster(roster.filter((t) => !(isAreaFaceTeammate(t) && !!t.workspace_id && agents.has(t.workspace_id))))
}

/** Who stands for a teammate's notices and counts: the teammate itself, or for an area face its workspace's Assistant. */
export type TeammateOwnerOf = (teammateId: string) => string

/** Every teammate stands for itself (no roster, or a test). */
export const SELF_OWNER: TeammateOwnerOf = (teammateId) => teammateId

/**
 * Who stands for each teammate, off a roster (one face): an area face's
 * notices and counts are its workspace's Assistant's, when the roster holds
 * it; anyone else stands for itself. One pass over the roster, then a map
 * read per id (agentTeammateIdFor, for many ids at once).
 */
export function teammateOwnerOf(
  roster: ReadonlyArray<Pick<AgentFaceFacts, 'id' | 'workspace_id' | 'is_system' | 'system_key'>>,
): TeammateOwnerOf {
  const agents = new Map<string, string>()
  const faces = new Map<string, string>()
  for (const t of roster) {
    if (!t.id || !t.workspace_id) continue
    if (isAgentTeammate(t) && !agents.has(t.workspace_id)) agents.set(t.workspace_id, t.id)
    else if (isAreaFaceTeammate(t)) faces.set(t.id, t.workspace_id)
  }
  if (faces.size === 0) return SELF_OWNER
  return (teammateId) => {
    const ws = faces.get(teammateId)
    return (ws && agents.get(ws)) || teammateId
  }
}

/**
 * The teammate a page, a bubble or a notice for `teammateId` opens: the
 * workspace's Assistant when `teammateId` is an area face it holds (its work
 * is the agent's now, and so is its page), else `teammateId` itself. An area
 * face whose workspace has no Assistant in the roster stays itself.
 */
export function agentTeammateIdFor(
  roster: ReadonlyArray<Pick<AgentFaceFacts, 'id' | 'workspace_id' | 'is_system' | 'system_key'>>,
  teammateId: string,
): string {
  const mate = roster.find((t) => t.id === teammateId)
  if (!mate || !isAreaFaceTeammate(mate)) return teammateId
  return roster.find((t) => t.workspace_id === mate.workspace_id && isAgentTeammate(t))?.id ?? teammateId
}
