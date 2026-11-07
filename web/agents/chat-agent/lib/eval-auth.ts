/**
 * The eval runner's door into the chat agent (P3, deterministic safety evals;
 * docs/plans/eve-alignment.md §2 and decision 19).
 *
 * `eve eval --url <target>/eve/chat-agent` drives real chat sessions over this
 * channel, with tool stubs so a case writes nothing real. eve refuses stubs
 * unless the verified auth result says `allowToolStubs: true`, and no other
 * entry on this channel ever does. This one does, and only for one fixed test
 * principal, under every condition below at once (each one fails closed):
 *
 *   1. The caller presents `Authorization: Bearer d8eval_<secret>` (eve's
 *      runner sends EVE_EVAL_AUTH_TOKEN as the bearer for a `--url` target).
 *      Any other request skips this entry (null), so the person, device and
 *      server entries are untouched.
 *   2. The path is switched on: EVE_EVAL_AUTH_ENABLED is exactly '1'; the
 *      deployment is provably not production: VERCEL_ENV is 'preview' or
 *      'development', or VERCEL_ENV and VERCEL are both unset (a local server),
 *      and VERCEL_TARGET_ENV, when set, is 'preview' or 'development' too (eve
 *      itself treats any other value as production); and the app's database is
 *      DEV's (NEXT_PUBLIC_SUPABASE_URL's hostname, ./eval-fixture-identity.ts).
 *      Otherwise an eval bearer is refused 401 with a generic message (the
 *      reason is logged, never echoed), and never passed down the walk.
 *   3. The secret matches EVE_EVAL_SECRET (at least 32 characters), compared
 *      in constant time.
 *   4. The principal is the configured fixture, and the fixture is provably a
 *      test one (scripts/eval-fixture.ts creates it on DEV):
 *        - EVE_EVAL_USER_ID is the auth user EVAL_USER_EMAIL (read with the
 *          service role: the workspace marker alone is forgeable, since a
 *          workspace owner can PATCH their own workspace's settings);
 *        - EVE_EVAL_WORKSPACE_ID is marked `settings.eval_fixture = true`;
 *        - its ONLY member is EVE_EVAL_USER_ID, so no real person's data is
 *          reachable from it;
 *        - EVE_EVAL_CONVERSATION_ID is that user's conversation in it.
 *      Checked with the service role, cached for a minute when it passes, never
 *      when it fails; a query error refuses.
 *   5. On a route under a session id, that session must not be registered to
 *      anyone else (a chat_conversations row of another user or workspace) →
 *      403. Eval sessions are never registered (no transport writes them), so
 *      an unregistered id is admitted for this principal; a lookup error
 *      refuses.
 *      KNOWN RISK, accepted: the eval principal can reach ANY unregistered
 *      session on the deployment (an orphan, or another eval run's), because
 *      eve does not tell a channel's AuthFn who created a session (the
 *      creator is only on ctx.session.auth.initiator inside the runtime). It
 *      is confined to a non-production deployment on DEV's database, to
 *      holders of EVE_EVAL_SECRET, and to the fixture principal; and tool
 *      stubs attach only when a session is CREATED, so a session someone else
 *      created never gains stubs through this door. If eve ever exposes the
 *      creator at the channel, admit only sessions this principal created.
 *
 * Then it mints a short chat-run token (15 minutes) for the fixture's
 * conversation, exactly the claims the app's transport would mint for the
 * in-app chat, so the spec, tool and usage routes treat the eval as that test
 * person in the app (callerClassOf: 'person'). Every internal route re-verifies
 * the token, as always.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ForbiddenError, UnauthenticatedError, type AuthFn } from 'eve/channels/auth'
import { chatRunHeaders, chatRunSecret, extractTargetedSessionId, lookupSessionOwner, serviceClient } from './auth.js'
import { EVAL_USER_EMAIL, isDevSupabaseUrl } from './eval-fixture-identity.js'

/** The bearer prefix the eval runner's token carries (EVE_EVAL_AUTH_TOKEN = d8eval_<secret>). */
export const EVAL_BEARER_PREFIX = 'd8eval_'
/** The switch: exactly '1' turns the path on. */
export const EVAL_AUTH_FLAG = 'EVE_EVAL_AUTH_ENABLED'
/** The shortest secret accepted. */
export const EVAL_SECRET_MIN_LENGTH = 32
/** How long an eval chat-run token lives. */
export const EVAL_TOKEN_TTL_MS = 15 * 60 * 1000
/** How long a passing fixture check is trusted. */
const FIXTURE_CACHE_MS = 60 * 1000

export interface EvalPrincipal {
  userId: string
  workspaceId: string
  conversationId: string
}

export type EvalDisabledReason = 'flag_off' | 'production' | 'not_dev_database' | 'secret_missing' | 'principal_missing'

/** The only deployment environments the door opens on. Anything else counts as production, as eve counts it. */
const NON_PRODUCTION_ENVS: ReadonlySet<string> = new Set(['preview', 'development'])

/**
 * True only when the deployment is provably not production: VERCEL_ENV is
 * preview or development, or neither VERCEL_ENV nor VERCEL is set (a local
 * server); and VERCEL_TARGET_ENV, when set, is preview or development. An
 * unknown value, or VERCEL set without VERCEL_ENV, fails closed. Pure.
 */
export function isNonProductionDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const vercelEnv = env.VERCEL_ENV
  if (vercelEnv !== undefined && vercelEnv !== '') {
    if (!NON_PRODUCTION_ENVS.has(vercelEnv)) return false
  } else if (env.VERCEL !== undefined && env.VERCEL !== '') {
    return false
  }
  const target = env.VERCEL_TARGET_ENV
  if (target !== undefined && target !== '' && !NON_PRODUCTION_ENVS.has(target)) return false
  return true
}

/** Why the eval path is off in this process, or null when every switch is on. Pure over `env`. */
export function evalAuthDisabledReason(env: NodeJS.ProcessEnv = process.env): EvalDisabledReason | null {
  if (env[EVAL_AUTH_FLAG] !== '1') return 'flag_off'
  if (!isNonProductionDeployment(env)) return 'production'
  if (!isDevSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)) return 'not_dev_database'
  const secret = env.EVE_EVAL_SECRET ?? ''
  if (secret.length < EVAL_SECRET_MIN_LENGTH) return 'secret_missing'
  if (!evalPrincipalFromEnv(env)) return 'principal_missing'
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The configured fixture principal, or null when any id is missing or not a UUID. */
export function evalPrincipalFromEnv(env: NodeJS.ProcessEnv = process.env): EvalPrincipal | null {
  const userId = env.EVE_EVAL_USER_ID ?? ''
  const workspaceId = env.EVE_EVAL_WORKSPACE_ID ?? ''
  const conversationId = env.EVE_EVAL_CONVERSATION_ID ?? ''
  if (![userId, workspaceId, conversationId].every((id) => UUID.test(id))) return null
  return { userId, workspaceId, conversationId }
}

/** The secret an `Authorization: Bearer d8eval_…` header carries, or null for any other request. */
export function evalBearerSecret(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  if (!token.startsWith(EVAL_BEARER_PREFIX)) return null
  return token.slice(EVAL_BEARER_PREFIX.length)
}

/** Constant-time equality over SHA-256 digests (so lengths never leak). */
function sameSecret(presented: string, expected: string): boolean {
  const a = new Uint8Array(createHash('sha256').update(presented, 'utf8').digest())
  const b = new Uint8Array(createHash('sha256').update(expected, 'utf8').digest())
  return presented.length > 0 && timingSafeEqual(a, b)
}

const fixtureOk = new Map<string, number>()

/** Test seam: forget cached fixture checks. */
export function resetEvalFixtureCache(): void {
  fixtureOk.clear()
}

/**
 * Is the configured principal a test fixture? The user is the auth user
 * EVAL_USER_EMAIL, the workspace carries `settings.eval_fixture === true`, its
 * only member is the eval user, and the conversation is theirs in it. A
 * failure or a query error is false.
 */
export async function isEvalFixture(principal: EvalPrincipal, now: number = Date.now()): Promise<boolean> {
  const key = `${principal.userId}|${principal.workspaceId}|${principal.conversationId}`
  const until = fixtureOk.get(key)
  if (until !== undefined && until > now) return true
  try {
    const supabase = serviceClient()
    const [authUser, workspace, members, conversation] = await Promise.all([
      supabase.auth.admin.getUserById(principal.userId),
      supabase.from('workspace').select('id, settings').eq('id', principal.workspaceId).maybeSingle<{ id: string; settings: Record<string, unknown> | null }>(),
      supabase.from('member').select('user_id').eq('workspace_id', principal.workspaceId).limit(3),
      supabase
        .from('chat_conversations')
        .select('id, user_id, workspace_id')
        .eq('id', principal.conversationId)
        .maybeSingle<{ id: string; user_id: string; workspace_id: string }>(),
    ])
    if (authUser.error || workspace.error || members.error || conversation.error) return false
    if (authUser.data?.user?.email?.toLowerCase() !== EVAL_USER_EMAIL) return false
    if (workspace.data?.settings?.eval_fixture !== true) return false
    const memberIds = ((members.data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)
    if (memberIds.length !== 1 || memberIds[0] !== principal.userId) return false
    if (conversation.data?.user_id !== principal.userId || conversation.data?.workspace_id !== principal.workspaceId) return false
  } catch {
    return false
  }
  fixtureOk.set(key, now + FIXTURE_CACHE_MS)
  return true
}

/**
 * Mint the in-app chat-run token for the fixture's conversation: the same
 * payload and HMAC as mintChatRunToken in src/lib/chat/chat-run-token.ts
 * (eval-auth.test.ts verifies it with the app's verifier). Null when the chat
 * secret is unset.
 */
export function mintEvalRunToken(principal: EvalPrincipal, now: number = Date.now()): string | null {
  const secret = chatRunSecret()
  if (!secret) return null
  const claims = {
    conversationId: principal.conversationId,
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    exp: now + EVAL_TOKEN_TTL_MS,
  }
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
}

/** The eval runner's entry. Skips every request without an eval bearer. */
export function evalRunnerAuth(): AuthFn<Request> {
  return async (request) => {
    const presented = evalBearerSecret(request)
    if (presented === null) return null

    const disabled = evalAuthDisabledReason()
    if (disabled) {
      console.warn('[eval-auth] refused an eval bearer', { reason: disabled })
      throw new UnauthenticatedError({ code: 'eval_auth_disabled', message: 'Eval access is off on this deployment.' })
    }
    if (!sameSecret(presented, process.env.EVE_EVAL_SECRET ?? '')) {
      throw new UnauthenticatedError({ code: 'eval_auth_invalid', message: 'The eval token is not valid here.' })
    }
    const principal = evalPrincipalFromEnv()!
    if (!(await isEvalFixture(principal))) {
      throw new ForbiddenError({
        code: 'eval_fixture_invalid',
        message: 'The configured eval principal is not a test fixture (run scripts/eval-fixture.ts on DEV).',
      })
    }

    const sessionId = extractTargetedSessionId(request)
    if (sessionId) {
      let owner: Awaited<ReturnType<typeof lookupSessionOwner>>
      try {
        owner = await lookupSessionOwner(sessionId)
      } catch {
        throw new ForbiddenError({ code: 'session_forbidden', message: 'Could not check who owns this chat session.' })
      }
      if (owner && (owner.userId !== principal.userId || owner.workspaceId !== principal.workspaceId)) {
        throw new ForbiddenError({ code: 'session_forbidden', message: 'This chat session belongs to another user or workspace.' })
      }
    }

    const chatRunToken = mintEvalRunToken(principal)
    if (!chatRunToken) {
      throw new ForbiddenError({ code: 'chat_run_token_required', message: 'The chat secret is unset, so no eval turn can run.' })
    }
    return {
      authenticator: 'eval',
      principalId: principal.userId,
      principalType: 'user',
      attributes: {
        workspaceId: principal.workspaceId,
        chatRunToken,
        chatRunCtx: chatRunHeaders(request).chatRunCtx,
      },
      allowToolStubs: true,
    }
  }
}
