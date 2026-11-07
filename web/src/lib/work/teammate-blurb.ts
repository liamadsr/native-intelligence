/**
 * What a teammate is, in one line: the Agents page's roster tooltip, and the
 * first line of a bot's page's About (docs/plans/bots-v4.md, "A bot's page").
 * A custom agent's work bot names its agent (bots-v3 Phase 6), a loop's work
 * bot its loops (bots-v3 Phase 3), a system teammate its job, else its role.
 * Pure, and client-safe.
 */
import type { RosterTeammate } from './agent-roster'
import { WORK_ROLE_LABELS } from './roles'
import { SYSTEM_TEAMMATE_BLURBS, type SystemTeammateKey } from './system-teammates'

const ROLE_LABELS: Record<string, string> = WORK_ROLE_LABELS

export type BlurbTeammate = Pick<RosterTeammate, 'fronts_only' | 'speaks_for_agent' | 'fronts' | 'is_system' | 'system_key' | 'role'>

export function teammateBlurb(m: BlurbTeammate): string {
  if (m.fronts_only && m.speaks_for_agent) {
    return m.fronts.length > 0 ? `The agent for ${m.speaks_for_agent} and ${m.fronts.join(', ')}` : `The agent for ${m.speaks_for_agent}`
  }
  if (m.fronts_only) {
    return m.fronts.length > 0 ? `The agent for ${m.fronts.join(', ')}` : 'An agent made for a loop'
  }
  if (m.is_system && m.system_key && m.system_key in SYSTEM_TEAMMATE_BLURBS) {
    return SYSTEM_TEAMMATE_BLURBS[m.system_key as SystemTeammateKey]
  }
  if (m.role) return ROLE_LABELS[m.role] ?? m.role
  return 'Teammate'
}
