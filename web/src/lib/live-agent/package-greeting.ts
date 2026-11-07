import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The user-facing acknowledgment of attached context packages — the analogue
 * of the greeting's "I'm also watching `repo`" line for the "+ Packages"
 * chip. Shared by the live-conversation greeting (POST /chat-history/live)
 * and the mid-call acknowledgment (POST /chat-history/live/packages-ack).
 *
 * Names resolve server-side under the CALLER's RLS client — never from
 * client-supplied labels — so an id the user can't see silently drops out,
 * and names are sanitized before they land in a chat message.
 */

function sanitizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const clean = name.replace(/[\r\n`]/g, '').trim()
  return clean ? clean.slice(0, 60) : null
}

/** "I'm using the “A” and “B” context packages to guide this call." — or
 *  null when nothing (visible) is attached. */
export async function describeAttachedPackages(
  supabase: SupabaseClient,
  packageIds: string[],
): Promise<string | null> {
  const ids = packageIds.filter((id) => typeof id === 'string' && id).slice(0, 5)
  if (ids.length === 0) return null
  const { data } = await supabase.from('knowledge_package').select('id, name').in('id', ids)
  const byId = new Map(
    ((data ?? []) as Array<{ id: string; name: string | null }>).map((p) => [p.id, p.name]),
  )
  const names = ids
    .map((id) => sanitizeName(byId.get(id)))
    .filter((n): n is string => !!n)
    .map((n) => `“${n}”`)
  if (names.length === 0) return null
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `I'm using the ${list} context ${names.length === 1 ? 'package' : 'packages'} to guide this call.`
}

/** Stable fingerprint of an attach set — the ack message id embeds it so
 *  re-acking the same set dedupes on the (conversation, ui_message_id)
 *  unique index instead of spamming the thread. */
export function packageSetFingerprint(packageIds: string[]): string {
  const canon = [...packageIds].sort().join(',')
  let h = 0
  for (let i = 0; i < canon.length; i++) h = (h * 31 + canon.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}
