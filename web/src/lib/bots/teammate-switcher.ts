/**
 * The same agent in the person's other workspaces, as an agent's page lists
 * them in its switcher (teammate-chat-page.tsx): which roster entries are
 * that agent (sameAgentIds), who they are off the roster, what each chip
 * says, and the order the chips stand in. Pure.
 */
import { hasDot, teammateKey, type OwnerCounts } from '@/lib/work/agent-work-lanes'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { isAgentTeammate } from './agent-face'

/** What sameAgentIds reads off a roster entry. */
export type AgentIdentity = Pick<RosterTeammate, 'id' | 'workspace_id' | 'name'> &
  Partial<Pick<RosterTeammate, 'is_system' | 'system_key' | 'role' | 'agent_recipe_id'>>

const nameKey = (name: string | null | undefined) => (name ?? '').trim().toLocaleLowerCase()

/**
 * The roster entries that are `mate` itself in other workspaces, `mate` first:
 * the same built-in teammate (`system_key`, e.g. the Assistant), else the same
 * persona under the same name (`agent_recipe_id` + name), else the same role
 * under the same name. At most one per workspace, and none from `mate`'s own
 * workspace but `mate`. Never grouped by face: two agents that happen to hold
 * the same `bot_character` are not one agent. Just `mate` when nothing
 * matches (or the roster doesn't know it).
 */
export function sameAgentIds(mate: AgentIdentity | null | undefined, roster: readonly AgentIdentity[]): string[] {
  if (!mate) return []
  const same = (t: AgentIdentity): boolean => {
    if (mate.is_system || t.is_system) return !!mate.is_system && !!t.is_system && !!mate.system_key && t.system_key === mate.system_key
    if (nameKey(t.name) !== nameKey(mate.name) || !nameKey(mate.name)) return false
    if (mate.agent_recipe_id) return t.agent_recipe_id === mate.agent_recipe_id
    return !!mate.role && t.role === mate.role && !t.agent_recipe_id
  }
  const ids = [mate.id]
  const seen = new Set([mate.workspace_id])
  for (const t of roster) {
    if (t.id === mate.id || seen.has(t.workspace_id) || !same(t)) continue
    seen.add(t.workspace_id)
    ids.push(t.id)
  }
  return ids
}

/** One of the agent's entries in the switcher. */
export interface BubbleTeammate {
  id: string
  name: string
  /** Where it works (null when the roster doesn't say). */
  workspaceId: string | null
  /** Something's new from it. */
  hasNew: boolean
  /**
   * It is the agent (its workspace's Assistant: one face, always-on-agent
   * §2c): talking to it is the person's home thread, not a teammate thread.
   * Absent: a teammate like any other.
   */
  home?: boolean
}

/** The switcher's entries, in `teammateIds` order, named off the roster. */
export function bubbleTeammates(
  teammateIds: readonly string[],
  roster: readonly (Pick<RosterTeammate, 'id' | 'name' | 'workspace_id'> & Partial<Pick<RosterTeammate, 'is_system' | 'system_key'>>)[],
  counts: ReadonlyMap<string, OwnerCounts>,
): BubbleTeammate[] {
  return [...new Set(teammateIds)].map((id) => {
    const mate = roster.find((t) => t.id === id)
    return {
      id,
      name: mate?.name?.trim() || 'Teammate',
      workspaceId: mate?.workspace_id ?? null,
      // A parked question asks in the chat, not with the dot (P13).
      hasNew: hasDot(counts.get(teammateKey(id))),
      ...(isAgentTeammate(mate) ? { home: true } : {}),
    }
  })
}

/** What a switcher chip says, and its tooltip (its teammate's name and workspace in full). */
export interface SwitcherChip {
  label: string
  title: string
}

/**
 * What each switcher chip says (one agent in several workspaces): only what
 * tells it from the others, since the header names the one on show. The same
 * teammate in several workspaces (the usual case): its workspace. Teammates of
 * different names: the name, with the workspace too where two share a name. A
 * workspace the list doesn't know stands as the name. `workspaceName` says a
 * workspace id's name (null: unknown).
 */
export function switcherChips(
  teammates: readonly BubbleTeammate[],
  workspaceName: (id: string | null) => string | null,
): SwitcherChip[] {
  const named = (t: BubbleTeammate) => t.name.trim().toLocaleLowerCase()
  const sameName = new Set(teammates.map(named)).size <= 1
  return teammates.map((t) => {
    const where = workspaceName(t.workspaceId)
    const title = where ? `${t.name} · ${where}` : t.name
    if (sameName) return { label: where ?? t.name, title }
    const shared = teammates.filter((o) => named(o) === named(t)).length > 1
    return { label: shared && where ? title : t.name, title }
  })
}

/**
 * The order the switcher's chips stand in, the same for every agent: the
 * workspace on screen first, then the others by workspace name (one the list
 * doesn't know last), and within a workspace by the teammate's name. Only the
 * row's order: `teammates` keeps its own. Indexes into `teammates`.
 */
export function switcherOrder(
  teammates: readonly BubbleTeammate[],
  currentWorkspaceId: string | null,
  workspaceName: (id: string | null) => string | null,
): number[] {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  const keyed = teammates.map((t, index) => {
    const where = workspaceName(t.workspaceId)
    const rank = currentWorkspaceId !== null && t.workspaceId === currentWorkspaceId ? 0 : where ? 1 : 2
    return { index, rank, where: where?.trim() ?? '', name: t.name.trim() }
  })
  keyed.sort((a, b) => a.rank - b.rank || compare(a.where, b.where) || compare(a.name, b.name) || a.index - b.index)
  return keyed.map((k) => k.index)
}
