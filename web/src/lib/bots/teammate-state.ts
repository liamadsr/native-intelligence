/**
 * What a teammate's bot is doing, read off the teammate (docs/plans/
 * bot-characters.md, "Next: a character per agent" → State; bots-v4.md Phase
 * 4b), in three states:
 *
 *   working   it has work running (countByOwner's `running`);
 *   sleeping  otherwise, while it rests (teammateRest): its autonomy is `off`,
 *             its role's breaker has paused its attempts
 *             (`RosterTeammate.breaker`), or the AI usage limit stopped it
 *             (`aiLimited`: crew-state.ts aiLimitedTeammates, or its page's
 *             last finished row);
 *   default   everything else.
 *
 * Running work wins: a paused role can still finish what it started, and a
 * teammate switched off mid-run is working until the run settles.
 *
 * Plain data, so it reads anywhere.
 */

/** What a teammate's agent is doing. */
export type BotAvatarState = 'default' | 'working' | 'sleeping'

export interface TeammateStateInput {
  autonomy: string | null
  breaker: { paused: boolean } | null
}

/** Why a teammate's bot sleeps: switched off, its attempts paused, or stopped by the AI usage limit. */
export type TeammateRest = 'off' | 'paused' | 'ai_limit'

/** What the agent's page says for each (bots-v4.md: "its bubble and page saying which"). */
export const TEAMMATE_REST_WORDS: Readonly<Record<TeammateRest, string>> = {
  off: 'Switched off',
  paused: 'Attempts paused',
  ai_limit: 'Stopped by the AI limit',
}

/**
 * Why `teammate` rests, or null while it doesn't: switched off first (it
 * attempts nothing whatever its breaker says), then its attempts paused, then
 * the AI usage limit.
 */
export function teammateRest(teammate: TeammateStateInput, aiLimited = false): TeammateRest | null {
  if (teammate.autonomy === 'off') return 'off'
  if (teammate.breaker?.paused) return 'paused'
  if (aiLimited) return 'ai_limit'
  return null
}

export function teammateBotState(teammate: TeammateStateInput, running: number, aiLimited = false): BotAvatarState {
  if (running > 0) return 'working'
  return teammateRest(teammate, aiLimited) ? 'sleeping' : 'default'
}

