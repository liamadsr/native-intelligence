/**
 * Owner-derivation + shared service client for the research agent's tools.
 *
 * SECURITY INVARIANT (non-negotiable): every tool write derives user_id AND
 * workspace_id ONLY from the verified session principal
 * (`ctx.session.auth.current`) — NEVER from model-supplied tool input. The
 * model cannot name a workspace or user to write into; it can only describe
 * WHAT to save. This mirrors the app's owner-derivation discipline (D4).
 *
 * `requireOwner(ctx)` is the single choke point: it reads the principal, refuses
 * anything that isn't an authenticated user with a real workspace, and returns
 * the derived tenancy. A tool that skips it and trusts input is a bug.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { SessionContext } from 'eve/context'

export interface OwnerScope {
  userId: string
  workspaceId: string
}

/**
 * Thrown when the session has no authenticated user + workspace to write on
 * behalf of. Tools catch this and return a clear, model-visible error result
 * rather than crashing the turn — notably the localDev smoke path, where the
 * synthetic principal carries no workspaceId.
 */
export class NoOwnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoOwnerError'
  }
}

/**
 * Derive { userId, workspaceId } from the verified principal. Throws
 * NoOwnerError when the caller is not an authenticated user OR has no workspace
 * (attributes.workspaceId is '' for a brand-new user with no membership, and
 * the localDev principal has no workspaceId at all).
 */
export function requireOwner(ctx: SessionContext): OwnerScope {
  const caller = ctx.session.auth.current
  if (!caller || caller.principalType !== 'user') {
    throw new NoOwnerError(
      'No authenticated user on this session — cannot write workspace data.'
    )
  }
  const raw = caller.attributes.workspaceId
  const workspaceId = typeof raw === 'string' ? raw : ''
  if (!workspaceId) {
    throw new NoOwnerError(
      'The authenticated user has no active workspace — cannot write workspace data.'
    )
  }
  return { userId: caller.principalId, workspaceId }
}

let cached: SupabaseClient | null = null

/**
 * Service-role Supabase client (RLS-bypassed). Tools write with this because
 * the eve runtime is a separate service from Next — there is no per-request
 * user JWT bound to PostgREST here — but EVERY query is explicitly scoped by the
 * `workspaceId` derived from the principal, so the bypass never widens scope.
 * Reuses the app's default service-role env vars (dev-local, prod on Vercel),
 * matching `getServiceClient()` in src/lib/admin.ts.
 */
export function serviceClient(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      '[onboarding-researcher] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'
    )
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}
