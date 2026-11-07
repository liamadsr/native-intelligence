/**
 * The Mac body's tool guard (contract C2, docs/plans/teammate-agent.md).
 * Before a tool acts on the Mac (bash, read_file, write_file, finish,
 * request_folder_access), it asks the app whether the job is still on.
 *
 * The liveness probe before each model step (hooks/usage-limit-gate.ts) runs
 * before the model call, so a Stop pressed while the model was thinking would
 * not stop the tool calls it answered with. This check runs at the call
 * itself: C1's `?live=1` (lib/spec-client.ts probeChatRunLive), judged by
 * lib/mac-host.ts judgeMacLiveness, which fails closed (401/403, three misses
 * in a row, a miss after the token's own expiry, or no usable route to the
 * app; these checks count toward the three misses too). It stays cheap: an answer judged in the last MAC_GUARD_REUSE_MS is
 * reused, and calls made at the same moment share one request. A launch with
 * no session token at all (the dev path) is never stopped.
 */
import type { SessionAuth } from 'eve/context'
import { assertMacAppLive, judgeMacLiveness, macLastJudgedAt } from './mac-host.js'
import { probeChatRunLive, runTokenFromAuth } from './spec-client.js'

/** How long a judged answer stands for the next tool call (ms). */
export const MAC_GUARD_REUSE_MS = 2_000

let inflight: Promise<void> | null = null

/** Throws MAC_TOOLS_PAUSED unless the app still accepts this Mac job (see the header). */
export async function macToolGuard(auth?: SessionAuth): Promise<void> {
  // A clock set back (an NTP correction) makes the age negative: ask again.
  const age = Date.now() - macLastJudgedAt()
  if (age < 0 || age > MAC_GUARD_REUSE_MS) {
    inflight ??= probeChatRunLive((auth && runTokenFromAuth(auth)) || 'mac-tool-guard')
      .then((result) => {
        judgeMacLiveness(result)
      })
      .finally(() => {
        inflight = null
      })
    await inflight
  }
  assertMacAppLive()
}
