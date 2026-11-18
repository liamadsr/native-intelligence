/**
 * The app's side of the call notes' preflight (the recorder's `--check`,
 * recorder/src/check.ts, asks it through POST /api/internal/team-call-recorder/
 * check with the feed's secret): what is on here, and whether the live agent
 * answers. Costs nothing: no call, no model, no write.
 *
 *   recorder         TEAM_CALL_RECORDER on, calling on, the feed's secret its own
 *   liveAgent        TEAM_CALL_LIVE_AGENT on (and the recorder)
 *   liveAgentHealth  the live agent's own health answer through the app's
 *                    address, as a turn reaches it ('ready', 'status_<n>',
 *                    'unreachable'), or 'off'
 *   turnKey          the app can sign a turn on a call's capture (an internal
 *                    secret for the live agent is set)
 *   livekit          LiveKit's settings are there
 *
 * Server only. No setting's value is ever in the answer.
 */
import 'server-only'
import { appUrl } from '@/lib/app-url'
import { callTurnKey } from '@/lib/live-agent/call-turn-key'
import { teamCallsConfig } from './livekit'
import { teamCallLiveAgentOn } from './live-turns'
import { teamCallRecorderOn } from './recorder'

export interface RecorderCheck {
  recorder: boolean
  liveAgent: boolean
  liveAgentHealth: string
  turnKey: boolean
  livekit: boolean
}

export type CheckFetch = (url: string, init: RequestInit) => Promise<Response>

/** The live agent's health, as the app reaches it: 'ready', 'status_<n>', 'not_ready', or 'unreachable'. */
export async function liveAgentHealth(doFetch: CheckFetch = (url, init) => fetch(url, init)): Promise<string> {
  try {
    const res = await doFetch(`${appUrl()}/eve/live-agent/v1/health`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return `status_${res.status}`
    const json = (await res.json().catch(() => null)) as { status?: unknown } | null
    return json?.status === 'ready' ? 'ready' : 'not_ready'
  } catch {
    return 'unreachable'
  }
}

export async function recorderCheck(env: NodeJS.ProcessEnv = process.env, doFetch?: CheckFetch): Promise<RecorderCheck> {
  const liveAgent = teamCallLiveAgentOn(env)
  return {
    recorder: teamCallRecorderOn(env),
    liveAgent,
    liveAgentHealth: liveAgent ? await liveAgentHealth(doFetch) : 'off',
    turnKey: !!callTurnKey('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000'),
    livekit: !!teamCallsConfig(env),
  }
}
