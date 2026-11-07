/**
 * Seed Triage into a brand-new account's own workspace at signup.
 *
 * A signup's first workspace is made by the `handle_new_user` trigger on
 * auth.users, in SQL, so the TypeScript seeder (seed-default-loops.ts) never
 * ran for it. Seeding used to wait for the onboarding Prime step, which left a
 * signup who skipped or bounced out of onboarding with no Triage at all: their
 * meetings were captured but never filtered down to their own commitments.
 *
 * The caller is POST /api/analytics/auth-session, the one route every auth
 * method reaches (password signups never touch /auth/callback), pinged on
 * mount from the trial wall, the onboarding wizard and the dashboard shell. It
 * calls this only while the account is inside the signup window
 * (`isFreshSignupUser`, the same test that labels the session a signup), so a
 * returning user's ping costs nothing.
 *
 * Which workspaces: the ones this user OWNS that were created inside the same
 * window, which for a new account is the trigger's workspace (plus any it made
 * through POST /api/account/workspace, which seeds on its own; the repeat is a
 * no-op). Never the current workspace as such: an invited signup's current
 * workspace is someone else's, and seeding there would make a loop that runs
 * as the invitee. The age check keeps a workspace handed over to a new account
 * from being touched.
 *
 * Idempotent through seedDefaultLoops' seed_key guard, so it runs on every ping
 * in the window: a ping that fails to seed is retried by the next one. A user
 * who deletes Triage within their first hour gets it back on the next ping;
 * after that the window is closed. Throws only on a failed member or workspace
 * read; per-workspace seeding failures are logged and skipped. SERVICE client.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { SIGNUP_SESSION_WINDOW_MS } from '@/lib/posthog'
import { seedDefaultLoops } from './seed-default-loops'

export async function seedSignupLoops(
  service: SupabaseClient,
  args: { userId: string; nowMs?: number },
): Promise<{ workspaceIds: string[] }> {
  const { data: owned, error: memberErr } = await service
    .from('member')
    .select('workspace_id')
    .eq('user_id', args.userId)
    .eq('role', 'owner')
  if (memberErr) throw new Error(`seed-signup-loops: read memberships failed: ${memberErr.message}`)
  const ownedIds = [...new Set((owned ?? []).map((m) => m.workspace_id as string))]
  if (ownedIds.length === 0) return { workspaceIds: [] }

  const cutoff = new Date((args.nowMs ?? Date.now()) - SIGNUP_SESSION_WINDOW_MS).toISOString()
  const { data: fresh, error: wsErr } = await service
    .from('workspace')
    .select('id')
    .in('id', ownedIds)
    .gte('created_at', cutoff)
  if (wsErr) throw new Error(`seed-signup-loops: read workspaces failed: ${wsErr.message}`)

  const workspaceIds = (fresh ?? []).map((w) => w.id as string)
  for (const workspaceId of workspaceIds) {
    try {
      await seedDefaultLoops(service, { workspaceId, createdByUserId: args.userId })
    } catch (err) {
      console.error('[seed-signup-loops] seed-default-loops failed', {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { workspaceIds }
}
