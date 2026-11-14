/**
 * The server driving the live agent's route as a capture's owner (server
 * only): a short-lived device token for the owner, pinned to the capture's
 * workspace (the pin is what getCurrentWorkspaceId resolves for a device
 * token), handed to `run`, and revoked after, whatever `run` did. The route
 * then runs as it does for the owner's own app: their settings, their model,
 * their usage row. The end-of-meeting batch of an abandoned capture or a
 * call (src/lib/inngest/capture-finalizer.ts) and a call's live turns
 * (src/lib/team-calls/live-turns.ts) both go through it, so neither copies
 * the route.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateDeviceToken } from '@/lib/device-tokens'

export async function withOwnerRunToken<T>(
  service: SupabaseClient,
  args: { ownerId: string; workspaceId: string; name: string; ttlMs: number },
  run: (token: string) => Promise<T>,
): Promise<T> {
  const { token, hash, displayPrefix } = generateDeviceToken()
  const { data: minted, error } = await service
    .from('device_token')
    .insert({
      user_id: args.ownerId,
      active_workspace_id: args.workspaceId,
      name: args.name,
      token_hash: hash,
      token_prefix: displayPrefix,
      expires_at: new Date(Date.now() + args.ttlMs).toISOString(),
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !minted) throw new Error(`owner run token: mint failed: ${error?.message ?? 'no row'}`)
  try {
    return await run(token)
  } finally {
    const { error: revokeError } = await service.from('device_token').delete().eq('id', minted.id)
    if (revokeError) console.warn('[owner-run-token] token revoke failed:', revokeError.message)
  }
}
