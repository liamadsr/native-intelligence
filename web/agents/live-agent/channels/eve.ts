/**
 * eve HTTP channel + route-auth policy for the `live-agent` agent
 * (LIVE-AGENT-DESIGN §3.1).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SIBLING of agents/work-agent/channels/eve.ts and agents/skill-runner/     │
 * │ channels/eve.ts (eve roots cannot share imports). Same walk.              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * INTERNAL-ONLY. Each live-meeting turn is one one-shot session the cloud route
 * creates server-to-server; nothing browser-driven reaches this agent. The auth
 * walk (see ../lib/auth.ts for the full rationale):
 *
 *   1. sharedSecretAuth() — constant-time bearer check of
 *      LIVE_AGENT_INTERNAL_SECRET (falling back to RUN_SKILL_INTERNAL_SECRET);
 *      stamps the per-turn run token onto the principal for the resolvers.
 *   2. localDevOffVercel() — eve's dev fallback so `eve dev` / local smoke
 *      works; it never admits anyone on a Vercel deployment.
 *
 * NO vercelOidc(): eve's admits any token minted for this Vercel project,
 * preview and development deployments' included, and `subjects` cannot narrow
 * that (they only add other projects). Nothing calls this agent with one.
 *
 * Deliberately NO cookie/session AuthFn and NO session-ownership ACL: turn
 * tenancy lives inside the HMAC-signed run token (re-verified on the internal
 * routes), never chosen by a caller.
 *
 * `GET /eve/v1/health` is always public and skips the walk.
 */
import { eveChannel } from 'eve/channels/eve'
import { localDevOffVercel, sharedSecretAuth } from '../lib/auth.js'

export default eveChannel({
  auth: [sharedSecretAuth(), localDevOffVercel()],
})
