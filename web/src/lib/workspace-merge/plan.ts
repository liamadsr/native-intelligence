/**
 * The one thing the person decides: per source team, "arrives as its own
 * team" or "folds into one of ours". The plan sent back to the preflight
 * carries only those choices; the server derives names, slugs and prefixes
 * (it reserves every source team's, folded or not), and the merge is then
 * called with the preflight's normalised plan. Pure, client-safe.
 */
import type { MergePlan, PreflightTeam } from './types'

export type TeamChoice = { mode: 'own' } | { mode: 'fold'; destination_team_id: string }

export const OWN: TeamChoice = { mode: 'own' }

/** The choice a preflight row currently reflects. */
export function choiceOf(team: PreflightTeam): TeamChoice {
  return team.mode === 'fold' && team.destination_team_id ? { mode: 'fold', destination_team_id: team.destination_team_id } : OWN
}

/** Every team's current choice, keyed by source team id. */
export function choicesOf(teams: PreflightTeam[]): Record<string, TeamChoice> {
  return Object.fromEntries(teams.map((t) => [t.source_team_id, choiceOf(t)]))
}

/** The plan to send back to the preflight: choices only. */
export function planFromChoices(teams: PreflightTeam[], choices: Record<string, TeamChoice>): MergePlan {
  return {
    teams: teams.map((t) => {
      const c = choices[t.source_team_id] ?? OWN
      return c.mode === 'fold'
        ? { source_team_id: t.source_team_id, mode: 'fold', destination_team_id: c.destination_team_id }
        : { source_team_id: t.source_team_id, mode: 'own' }
    }),
  }
}

/** The <select> value of a choice: 'own' or 'fold:<destination team id>'. */
export function choiceValue(c: TeamChoice): string {
  return c.mode === 'fold' ? `fold:${c.destination_team_id}` : 'own'
}

/** Back from the <select> value; anything unreadable is "own". */
export function parseChoice(value: string): TeamChoice {
  if (value.startsWith('fold:') && value.length > 5) return { mode: 'fold', destination_team_id: value.slice(5) }
  return OWN
}
