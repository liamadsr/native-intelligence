/**
 * DB binding fence for skill-run tokens (2026-10-31 security review, P0-1).
 *
 * A skill-run token is HMAC-signed with the same shared secret the eve
 * skill-runner presents as its bearer, so the signature alone proves only
 * "minted by a holder of the secret" — a COMPROMISED runtime could mint claims
 * naming any user and workspace. This guard requires the claims to still name
 * live DB state the app itself created:
 *   - the run-as user is a member of the workspace (`member`);
 *   - the skill is a real recipe of that workspace (or a system skill);
 *   - a `workItemId`, when the token carries one, is a tracked_job of that
 *     workspace (the route stamps touches and status changes on it);
 *   - a follow-up chat's `teammateId`, when carried, is an ai_team_member of
 *     that workspace (the ceiling is derived from it).
 *
 * Every mint site reads these ids from rows it just loaded (the run spec, the
 * ledger record), so a legitimate token always binds. The chat family has the
 * same fence in src/lib/chat/surface-run-guard.ts; the agent-run, work-run and
 * live-agent routes already re-read their rows per call.
 *
 * Soft/hard split (same as the chat guard): a lookup that ERRORS refuses this
 * one call with a transient 503, a genuine absence or mismatch is a 403.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import type { RunTokenClaims } from './skill-run-token'

/** Error code (403) when a token's claims don't bind to live rows of its workspace. */
export const RUN_TOKEN_UNBOUND = 'RUN_TOKEN_UNBOUND'

/** Error code (503) when the binding could not be checked (a lookup errored or threw). */
export const RUN_BINDING_UNVERIFIED = 'RUN_BINDING_UNVERIFIED'

/** A token's binding: bound, genuinely unbound, or unknown (lookup failed). */
export type SkillRunBinding = 'bound' | 'unbound' | 'unknown'

type MaybeRow<T> = { data: T | null; error: unknown }

/** A row of `table` with this id in this workspace, or the absence of one (no read when `id` is unset). */
async function rowInWorkspace(
  svc: SupabaseClient,
  table: string,
  id: string | undefined,
  workspaceId: string,
): Promise<MaybeRow<{ id: string }> | null> {
  if (!id) return null
  return svc.from(table).select('id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle<{ id: string }>()
}

/**
 * Whether this token's claims still bind to live DB state (see the module doc
 * for the exact rows). Two to four indexed reads, one round trip.
 */
export async function skillRunBinding(
  claims: RunTokenClaims,
  supabase?: SupabaseClient,
): Promise<SkillRunBinding> {
  try {
    const svc = supabase ?? getServiceClient()
    const [member, skill, workItem, teammate] = await Promise.all([
      svc
        .from('member')
        .select('id')
        .eq('user_id', claims.runAsUserId)
        .eq('workspace_id', claims.workspaceId)
        .maybeSingle<{ id: string }>(),
      svc
        .from('recipe')
        .select('id, workspace_id, is_system')
        .eq('id', claims.skillId)
        .eq('category', 'skill')
        .maybeSingle<{ id: string; workspace_id: string | null; is_system: boolean | null }>(),
      rowInWorkspace(svc, 'tracked_job', claims.workItemId, claims.workspaceId),
      rowInWorkspace(svc, 'ai_team_member', claims.chat?.teammateId, claims.workspaceId),
    ])
    if (member.error || skill.error || workItem?.error || teammate?.error) return 'unknown'
    if (!member.data) return 'unbound'
    const skillRow = skill.data
    if (!skillRow || (skillRow.is_system !== true && skillRow.workspace_id !== claims.workspaceId)) return 'unbound'
    if (claims.workItemId && !workItem?.data) return 'unbound'
    if (claims.chat?.teammateId && !teammate?.data) return 'unbound'
    return 'bound'
  } catch {
    return 'unknown'
  }
}

/**
 * The refusal an internal skill-run route returns for this token, or null when
 * the run may act: 403 RUN_TOKEN_UNBOUND on a genuine binding failure, 503
 * RUN_BINDING_UNVERIFIED when it could not be checked. Both fail closed.
 */
export async function skillRunBindingRefusal(
  claims: RunTokenClaims,
  supabase?: SupabaseClient,
): Promise<NextResponse | null> {
  const binding = await skillRunBinding(claims, supabase)
  if (binding === 'bound') return null
  if (binding === 'unbound') {
    return NextResponse.json(
      { error: 'this token does not bind to live rows of its workspace', code: RUN_TOKEN_UNBOUND },
      { status: 403 },
    )
  }
  return NextResponse.json(
    { error: 'could not verify this run is still live', code: RUN_BINDING_UNVERIFIED },
    { status: 503 },
  )
}
