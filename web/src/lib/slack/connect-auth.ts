/**
 * How the app authenticates to Vercel Connect off Vercel (./config.ts).
 *
 * On Vercel every Connect call sends the deployment's OIDC token (the client
 * fetches it itself), and {@link connectOptions} returns nothing. Off Vercel
 * there is none, and Connect refuses an access token as the bearer of a token
 * request ("Token subject is not accessible to this requester"). So the access
 * token is used only to make a project token: the request @vercel/oidc itself
 * makes to refresh one (`POST /v1/projects/<project>/token?source=
 * vercel-oidc-refresh[&teamId=<team>]`, token-util.js getVercelOidcToken). It
 * answers an OIDC token naming the project (environment `development`, valid
 * for hours), which Connect accepts. The connector must therefore be enabled
 * for the project's development environment as well as production.
 *
 * The project token is cached in process until shortly before it expires; one
 * request is in flight at a time and concurrent callers share it. A failed
 * request is not cached. No token is ever logged or put in an error.
 */
import 'server-only'
import { connectAccessToken, connectProjectId, connectTeamId } from './config'

/** Made anew this long before the project token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

type Cached = { key: string; token: string; expiresAt: number }

let cached: Cached | null = null
let inFlight: { key: string; promise: Promise<string> } | null = null

export class ConnectAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectAuthError'
  }
}

/**
 * The options every Connect call passes: undefined on Vercel (the client uses
 * the deployment's OIDC token), else `{ vercelToken }` with a project token
 * made with CONNECT_ACCESS_TOKEN. Throws {@link ConnectAuthError} when the
 * access token is set without CONNECT_PROJECT_ID, or the project token can't
 * be made: never falls back to sending the access token.
 */
export async function connectOptions(): Promise<{ vercelToken: string } | undefined> {
  const accessToken = connectAccessToken()
  if (!accessToken) return undefined
  const projectId = connectProjectId()
  if (!projectId) {
    throw new ConnectAuthError('CONNECT_ACCESS_TOKEN is set but CONNECT_PROJECT_ID is not: Connect needs a project token, made for that project.')
  }
  return { vercelToken: await projectToken(accessToken, projectId, connectTeamId()) }
}

/** Drop the cached project token (Connect refused it), so the next call makes a new one. */
export function forgetConnectProjectToken(): void {
  cached = null
}

async function projectToken(accessToken: string, projectId: string, teamId: string | null): Promise<string> {
  // The settings are part of the key, so a changed setting never reuses a token made with the old one.
  const key = JSON.stringify([accessToken, projectId, teamId])
  if (cached?.key === key && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token
  if (inFlight?.key === key) return inFlight.promise
  const promise = requestProjectToken(accessToken, projectId, teamId)
    .then(({ token, expiresAt }) => {
      // A token whose expiry can't be read is used once, not cached.
      if (expiresAt !== null) cached = { key, token, expiresAt }
      return token
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
  inFlight = { key, promise }
  return promise
}

async function requestProjectToken(
  accessToken: string,
  projectId: string,
  teamId: string | null,
): Promise<{ token: string; expiresAt: number | null }> {
  // A team-scoped access token may not need the team id; the request was
  // measured working with it.
  const team = teamId ? `&teamId=${encodeURIComponent(teamId)}` : ''
  const url = `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/token?source=vercel-oidc-refresh${team}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ConnectAuthError(`Making a project token for Connect failed: the request could not be sent (${error instanceof Error ? error.name : 'error'}).`)
  }
  if (!response.ok) {
    throw new ConnectAuthError(`Making a project token for Connect failed: the project-token request answered ${response.status}.`)
  }
  const body: unknown = await response.json().catch(() => null)
  const token = body && typeof body === 'object' && 'token' in body && typeof body.token === 'string' ? body.token : null
  if (!token) throw new ConnectAuthError('Making a project token for Connect failed: the project-token request answered no token.')
  return { token, expiresAt: jwtExpiry(token) }
}

/** The `exp` of a JWT in milliseconds, or null when it can't be read. */
function jwtExpiry(token: string): number | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const exp = payload && typeof payload === 'object' && 'exp' in payload ? payload.exp : null
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}
