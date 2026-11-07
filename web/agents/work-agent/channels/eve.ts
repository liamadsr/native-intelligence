/**
 * eve HTTP channel + route-auth policy for the `work-agent` agent (Loops v3 work
 * proposals — docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SIBLING of agents/coding-agent/channels/eve.ts (eve roots cannot share    │
 * │ imports). Keep in sync; the auth walk is identical (same secret env var).  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * INTERNAL-ONLY. This agent is never browser-driven — it runs headless work runs
 * dispatched server-to-server by the Next app. The auth walk (see ../lib/auth.ts
 * for the full rationale):
 *
 *   1. sharedSecretAuth() — constant-time bearer check of AGENT_RUN_INTERNAL_SECRET
 *      (falling back to RUN_SKILL_INTERNAL_SECRET). The primary same-deployment
 *      trust proof; stamps the run token onto the principal's attributes for the
 *      dynamic resolvers and the finish_work tool.
 *   2. localDevOffVercel() — eve's dev fallback so `eve dev` / local smoke
 *      works; it never admits anyone on a Vercel deployment.
 *
 * NO vercelOidc(): eve's admits any token minted for this Vercel project,
 * preview and development deployments' included, and `subjects` cannot narrow
 * that (they only add other projects). Nothing calls this agent with one.
 *
 * There is deliberately NO cookie/session AuthFn and NO session-ownership ACL:
 * no user-facing session access exists here, and run tenancy is carried inside
 * the HMAC-signed run token (re-verified on the internal routes), not chosen by
 * any caller.
 *
 * `GET /eve/v1/health` is always public and skips the walk.
 */
import { eveChannel } from 'eve/channels/eve'
import { localDevOffVercel, sharedSecretAuth } from '../lib/auth.js'

export default eveChannel({
  auth: [sharedSecretAuth(), localDevOffVercel()],
})
