/**
 * Sign in with ChatGPT, with ChatGPT plan usage: OpenAI's endpoints and the
 * OAuth client Dial8 uses (docs/plans/chatgpt-free-tier.md, phase 1).
 *
 * One consent grants identity AND plan usage, so a free-tier person's AI can
 * run on their own ChatGPT plan. Dial8 runs the flow itself (not Supabase's
 * custom provider): OpenAI requires `resource` on the code exchange as well as
 * on the authorize request, and a generic OIDC client can't send it.
 *
 * Two kinds of client, chosen by env:
 *   partner      OpenAI's Sign in with ChatGPT partner client (production).
 *                CHATGPT_CLIENT_ID=oaiapp_…, CHATGPT_CLIENT_SECRET (a
 *                confidential client: client_secret_basic), and the exact
 *                registered CHATGPT_REDIRECT_URI.
 *   self-serve   OpenAI's self-serve client for locally run apps (local dev
 *                only, never in production). CHATGPT_DEV_HOST_ID=urn:uuid:…
 *                names this machine (OpenAI's ext_agent_host_id). The first
 *                sign-in registers a client (client_id=dynamic_agent_client)
 *                and logs the issued id; set it as CHATGPT_CLIENT_ID so later
 *                sign-ins reuse it. Its redirect must be a 127.0.0.1 loopback
 *                URL, so local dev is opened at http://127.0.0.1:<port>.
 * Neither configured → the "Continue with ChatGPT" button is hidden.
 */

export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`
export const CHATGPT_REVOKE_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`
export const CHATGPT_JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`

/** The audience plan-usage tokens are issued for; sent on authorize, code
 *  exchange and refresh alike. */
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1'
/** The grant that lets AI requests run on the person's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_PLAN_SCOPE,
].join(' ')

/** The self-serve flow's first-registration entry point. Never stored. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
/** The app name OpenAI shows when a person approves the self-serve client. */
export const AGENT_NAME = 'Dial8'

export interface ChatGptClient {
  /** The issued client, or DYNAMIC_CLIENT_ID for a first self-serve registration. */
  clientId: string
  /** Partner client only (client_secret_basic). */
  clientSecret: string | null
  /** Self-serve only: this machine's ext_agent_host_id. */
  hostId: string | null
}

/** The configured client, or null when "Continue with ChatGPT" is off. */
export function chatGptClient(): ChatGptClient | null {
  const clientId = env('CHATGPT_CLIENT_ID')
  const hostId = env('CHATGPT_DEV_HOST_ID')
  const selfServe = !!hostId && process.env.NODE_ENV !== 'production'
  if (!clientId && !selfServe) return null
  return {
    clientId: clientId ?? DYNAMIC_CLIENT_ID,
    clientSecret: selfServe ? null : env('CHATGPT_CLIENT_SECRET'),
    hostId: selfServe ? hostId : null,
  }
}

/** The exact registered callback: CHATGPT_REDIRECT_URI, else
 *  `<origin>/auth/chatgpt/callback`. */
export function chatGptRedirectUri(origin: string): string {
  return env('CHATGPT_REDIRECT_URI') ?? `${origin}/auth/chatgpt/callback`
}

/** Is "Continue with ChatGPT" offered? */
export function isChatGptSignInEnabled(): boolean {
  return chatGptClient() !== null
}

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}
