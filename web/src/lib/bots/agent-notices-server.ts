/**
 * Whose notices a bot's Notices read covers (GET /api/account/notifications/bot
 * and its mark-all-read): the teammate's own, and, for the agent (the
 * workspace's Assistant: one face, docs/plans/always-on-agent.md §2c), every
 * area face's of its workspace too (Captures, Mail, Prospecting, Evals, CRM;
 * migration 318), since their notices are the agent's now. The notices keep
 * naming the area face that wrote them (`metadata.teammate_id`, `area`), so
 * nothing moves in the data.
 *
 * Read on the caller's session client: an area face is a system teammate of a
 * workspace the caller is in (the caller already passed resolveVisibleTeammate
 * for the Assistant), so RLS shows it. Fail-soft: a failed read covers the
 * Assistant's own notices only, logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { AREA_FACE_KEYS } from '@/lib/work/work-area'
import { ASSISTANT_SYSTEM_KEY } from '@/lib/work/bot-owner'

/** The teammate ids a bot's Notices read covers (see the header): itself, and for the Assistant its workspace's area faces. */
export async function noticeTeammateIds(
  supabase: SupabaseClient,
  mate: { id: string; workspaceId: string; isSystem: boolean; systemKey: string | null },
): Promise<string[]> {
  if (!mate.isSystem || mate.systemKey !== ASSISTANT_SYSTEM_KEY) return [mate.id]
  try {
    const { data, error } = await supabase
      .from('ai_team_member')
      .select('id')
      .eq('workspace_id', mate.workspaceId)
      .eq('is_system', true)
      .in('system_key', [...AREA_FACE_KEYS])
    if (error) throw new Error(error.message)
    const faces = ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => typeof id === 'string' && id && id !== mate.id)
    return [mate.id, ...new Set(faces)]
  } catch (err) {
    console.error('[notifications/bot] area faces read failed; the Assistant’s own notices only:', err instanceof Error ? err.message : err)
    return [mate.id]
  }
}
