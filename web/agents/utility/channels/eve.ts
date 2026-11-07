/**
 * eve HTTP channel + route-auth policy for the `utility` agent (WS-4).
 *
 * INTERNAL-ONLY — copied from the skill-runner's channel. The only caller is
 * the Next app's runUtilityTask (src/lib/eve/utility/run-utility.ts); see
 * ../lib/auth.ts for the auth walk. No cookie/session AuthFn and no
 * session-ownership ACL: no user-facing session access exists here, and each
 * call's tenancy lives inside the HMAC-signed utility token, re-verified on
 * the internal spec route.
 *
 * NO vercelOidc(): eve's admits any token minted for this Vercel project,
 * preview and development deployments' included, and `subjects` cannot narrow
 * that (they only add other projects). Nothing calls this agent with one.
 *
 * `GET /eve/v1/health` is always public and skips the walk.
 */
import { defaultEveAuth, eveChannel } from 'eve/channels/eve'
import { localDevOffVercel, sharedSecretAuth } from '../lib/auth.js'

/**
 * The fixed title of every utility session. Without one, eve derives
 * `$eve.title` from the first 125 characters of the first message
 * (deriveSessionTitle in eve's execution/eve-workflow-attributes.js) and keeps
 * that run metadata even with `retention: 0`. Utility messages carry workspace
 * content such as mail bodies, which Dial8 never stores, so the title must
 * never come from the message.
 */
const UTILITY_SESSION_TITLE = 'utility'

export default eveChannel({
  auth: [sharedSecretAuth(), localDevOffVercel()],
  // Same session auth as the default onMessage (the route-auth caller,
  // unchanged); only the title is pinned.
  onMessage: (ctx) => ({ auth: defaultEveAuth(ctx), title: UTILITY_SESSION_TITLE }),
})
