import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { encryptCredentialOrNull } from '@/lib/crypto/credentials'
import { assertSafeMcpUrl } from '@/lib/mcp-client/url-guard'
import { assertPublicHost } from '@/lib/mcp-client/url-guard-dns'
import {
  buildAuthorizationUrl,
  discoverOAuthForServer,
  generatePkcePair,
  generateStateString,
  registerClient,
} from '@/lib/mcp-client/oauth'
import { MCP_STATE_TTL_MS, mcpBindCookie, mcpClaimSecret, mcpFlowState } from '@/lib/mcp-client/oauth-binding'
import { bindingCookieOptions } from '@/lib/oauth/state'

/** A live flow younger than this for the same server is a double click (see the rate limit below). */
const DOUBLE_CLICK_MS = 15_000

const StartSchema = z.object({
  display_name: z.string().min(1).max(100),
  server_url: z.string().url(),
  transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
  // Where the consent completes (lib/mcp-client/oauth-binding.ts): 'web' (the
  // default) binds it to this browser by cookie; 'desktop' to this window's
  // claim secret.
  source: z.enum(['web', 'desktop']).default('web'),
})

function getOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (!host) throw new Error('Cannot determine request origin')
  return `${proto}://${host}`
}

// POST /api/account/mcp-servers/oauth/start
// Discovers the remote auth server, registers a client via DCR, persists
// the in-flight state row, and returns an authorize_url for the popup.
export async function POST(req: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let body: z.infer<typeof StartSchema>
  try {
    body = StartSchema.parse(await req.json())
  } catch (err) {
    return badRequest(
      'Invalid request',
      err instanceof z.ZodError ? err.flatten() : undefined,
    )
  }

  // SSRF guard — reject before any outbound fetch.
  const urlCheck = assertSafeMcpUrl(body.server_url)
  if (!urlCheck.ok) return badRequest(urlCheck.reason)
  // And every address the name resolves to must be public (url-guard-dns.ts).
  const resolved = await assertPublicHost(urlCheck.url)
  if (!resolved.ok) return badRequest(resolved.reason)

  // Rate limit: a live state row this user started for the same server in
  // the last few seconds is a double click; refuse rather than spawn a second
  // DCR client at the provider (each creates a record there that they keep —
  // Atlassian and Linear both throttle per IP/account). An older live row is
  // a flow the person walked away from (the browser's "Open Dial8?" prompt
  // dismissed, the window reloaded and lost its claim, a denied consent): it
  // can never finish now, so it gives way to this one instead of blocking a
  // retry for the rest of its ten minutes.
  const svcForGuard = getServiceClient()
  const { data: existing } = await svcForGuard
    .from('external_mcp_oauth_state')
    .select('created_at')
    .eq('user_id', user.id)
    .eq('server_url', body.server_url)
    .gt('expires_at', new Date().toISOString())
    .gt('created_at', new Date(Date.now() - DOUBLE_CLICK_MS).toISOString())
    .limit(1)
    .maybeSingle()
  if (existing) {
    return NextResponse.json(
      {
        error: 'A connection attempt is already in progress. Finish or cancel it before retrying.',
        code: 'MCP_OAUTH_IN_PROGRESS',
      },
      { status: 429 },
    )
  }
  await svcForGuard.from('external_mcp_oauth_state').delete().eq('user_id', user.id).eq('server_url', body.server_url)

  // IMPORTANT: this URL must NOT be under /api/account/* — the routing
  // middleware (src/proxy.ts) gates that prefix behind a Dial8 session,
  // and the OAuth callback has to be reachable in a fresh browser tab
  // (especially in desktop mode, where the system browser may have no
  // Dial8 cookies). The callback authenticates via the `state` param.
  const redirectUri = `${getOrigin(req)}/api/mcp-oauth/callback`

  // Discover auth-server metadata.
  let discovered
  try {
    discovered = await discoverOAuthForServer(body.server_url)
  } catch (err) {
    console.error('[mcp-servers/oauth/start] discovery failed:', {
      server_url: body.server_url,
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    })
    return badRequest(
      `Could not discover OAuth metadata for ${body.server_url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  const auth_server = discovered.authorizationServer

  // Register as a new OAuth client via RFC 7591 DCR. Most public MCP
  // servers (Atlassian, etc.) require this since they don't pre-issue
  // client_ids to arbitrary apps.
  let client_id: string
  let client_secret: string | undefined
  if (auth_server.registration_endpoint) {
    try {
      const reg = await registerClient(auth_server.registration_endpoint, redirectUri, {
        client_name: 'Dial8',
        scopes: discovered.scopes,
      })
      client_id = reg.client_id
      client_secret = reg.client_secret
    } catch (err) {
      console.error('[mcp-servers/oauth/start] DCR failed:', {
        registration_endpoint: auth_server.registration_endpoint,
        server_url: body.server_url,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      })
      return badRequest(
        `Dynamic client registration failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  } else {
    return badRequest(
      `Server does not advertise a registration_endpoint; only DCR-capable servers are supported in this flow.`,
    )
  }

  // PKCE + state, and the flow's binding (derived before the row exists, so
  // a missing server key never strands one).
  const { verifier, challenge } = generatePkcePair()
  const desktop = body.source === 'desktop'
  const state = mcpFlowState(generateStateString(), desktop)
  const expiresAt = new Date(Date.now() + MCP_STATE_TTL_MS).toISOString()
  let bind: { name: string; value: string }
  let claimSecret: string
  try {
    bind = mcpBindCookie(state)
    claimSecret = mcpClaimSecret(state)
  } catch {
    return serverError('OAuth is not configured on this server')
  }

  // Persist via service client — the state table has no RLS read policies
  // and is server-only.
  const svc = getServiceClient()
  const { error } = await svc.from('external_mcp_oauth_state').insert({
    state,
    user_id: user.id,
    workspace_id: workspaceId,
    display_name: body.display_name,
    server_url: body.server_url,
    transport: body.transport,
    authorization_endpoint: auth_server.authorization_endpoint,
    token_endpoint: auth_server.token_endpoint,
    registration_endpoint: auth_server.registration_endpoint ?? null,
    client_id,
    // Encrypted with CREDENTIAL_ENCRYPTION_KEY. Same treatment as access
    // and refresh tokens — never persist provider secrets in plaintext.
    client_secret: encryptCredentialOrNull(client_secret ?? null),
    scopes: discovered.scopes,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    expires_at: expiresAt,
  })
  if (error) return serverError(`Could not persist OAuth state: ${error.message}`)

  const authorize_url = buildAuthorizationUrl({
    authorization_endpoint: auth_server.authorization_endpoint,
    client_id,
    redirect_uri: redirectUri,
    scopes: discovered.scopes,
    state,
    code_challenge: challenge,
  })

  if (desktop) {
    // The desktop window keeps the state and its claim secret in memory: the
    // callback deep-links the code back, and only a claim with this secret and
    // this person's session completes it (oauth-binding.ts). The state alone
    // no longer completes anything.
    return NextResponse.json({ authorize_url, state, claim_secret: claimSecret })
  }
  // Web: the state stays server-side (the provider echoes it back); this
  // browser gets the flow's binding cookie, which the callback requires.
  const response = NextResponse.json({ authorize_url })
  response.cookies.set(bind.name, bind.value, bindingCookieOptions(Math.floor(MCP_STATE_TTL_MS / 1000)))
  return response
}
