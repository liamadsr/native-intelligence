/**
 * Binding an MCP connector's OAuth completion to the person who started it
 * (security review 2026-10-31, the MCP sibling of P0-2).
 *
 * The state row (`external_mcp_oauth_state`) proves the flow is ours, not WHO
 * is finishing it: an attacker could start a connect for their own account,
 * send the provider's consent link to a victim, and the victim's consent would
 * store the victim's connector tokens under the attacker. So completion now
 * needs proof from the initiator:
 *
 *   WEB: the start route sets a per-flow httpOnly binding cookie
 *   (`__Host-` in production, so no subdomain can plant one) in the browser
 *   that started; the callback (same browser, a top-level navigation, so a Lax
 *   cookie rides along) requires it. Nothing else stands in for it.
 *
 *   DESKTOP: the start runs in the app's webview, the consent in the SYSTEM
 *   browser (no webview cookies). A desktop flow's state starts with
 *   `desk.`; its callback never completes the connect. It deep-links the code
 *   back (dial8desktop://mcp-oauth/complete) without consuming the row, and
 *   the claim route completes it only for the row's own signed-in person
 *   presenting the flow's claim secret, which only the starting window got.
 *   The code itself is bound to the row by PKCE (its verifier never leaves the
 *   server), so a stolen deep link redeems nothing anywhere else.
 *
 * Every per-flow value is derived from the state with the server's OAuth state
 * key (lib/oauth/state.ts), domain-separated, so nothing new is stored.
 */
import crypto from 'crypto'
import { bindingCookieName, oauthStateSecret } from '@/lib/oauth/state'

export { readCookie, secretsEqual as mcpSecretsEqual } from '@/lib/oauth/state'

/** A desktop flow's state starts with this; base64url state never contains a `.`. */
const DESKTOP_STATE_PREFIX = 'desk.'

/** The in-flight state's life (the start route's row TTL). */
export const MCP_STATE_TTL_MS = 10 * 60 * 1000

/** How long past the row's expiry a desktop claim may still finish (it follows a callback that passed). */
export const MCP_CLAIM_GRACE_MS = 5 * 60 * 1000

/** The longest a desktop flow can still complete after it starts: the row's life plus the claim's grace. */
export const MCP_FLOW_MAX_MS = MCP_STATE_TTL_MS + MCP_CLAIM_GRACE_MS

function derive(purpose: string, state: string): string {
  return crypto.createHmac('sha256', oauthStateSecret()).update(`dial8-mcp-oauth-${purpose}-v1:${state}`).digest('base64url')
}

/** A new flow's state: the random value, `desk.`-prefixed for a desktop flow. */
export function mcpFlowState(random: string, desktop: boolean): string {
  return desktop ? `${DESKTOP_STATE_PREFIX}${random}` : random
}

export function isDesktopMcpState(state: string): boolean {
  return state.startsWith(DESKTOP_STATE_PREFIX)
}

/** The web flow's binding cookie: a per-flow name and a value only this server can compute. */
export function mcpBindCookie(state: string): { name: string; value: string } {
  return { name: bindingCookieName(`mcp_oauth_${derive('id', state).slice(0, 16)}`), value: derive('bind', state) }
}

/** The desktop flow's claim secret, handed only to the window that started it. */
export function mcpClaimSecret(state: string): string {
  return derive('claim', state)
}
