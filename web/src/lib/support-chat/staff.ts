/**
 * Who our support team is (migration 715): the deployment's admins,
 * ADMIN_EMAILS (src/lib/admin-emails.ts). No setting of its own.
 *
 * The database can't read ADMIN_EMAILS, so it keeps its own list,
 * support_staff, and every rule about what staff may read is written against
 * that list (is_support_staff, support_chat_staff_can_read). This module
 * keeps the list in step with ADMIN_EMAILS, with the service role: an admin
 * who opens team chat is added (with the name and picture customers will see
 * on their messages, refreshed each time), and anyone on the list who is no
 * longer an admin is taken off the next time any admin opens it (prune).
 *
 * Server only.
 */
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { isAdminEmail } from '@/lib/admin-emails'

/** The longest name a staff message carries (715's check). */
export const SUPPORT_NAME_MAX = 60

/** Whether this signed-in person is on the support team (an admin by address). */
export function isSupportStaffUser(user: Pick<User, 'email'> | null | undefined): boolean {
  return !!user && isAdminEmail(user.email)
}

/**
 * The name and picture a staff member's messages carry: their own name (the
 * account's full name, else the member name they go by, else their address's
 * first part) and their picture when it is an https address. Pure.
 */
export function supportIdentity(
  user: Pick<User, 'email' | 'user_metadata'>,
  memberName?: string | null,
): { display_name: string; avatar_url: string | null } {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  const name = pick(meta.full_name) || pick(meta.name) || pick(memberName) || pick(user.email?.split('@')[0]) || 'Support'
  const avatar = pick(meta.avatar_url) || pick(meta.picture)
  return {
    display_name: [...name].slice(0, SUPPORT_NAME_MAX).join(''),
    avatar_url: /^https:\/\//i.test(avatar) && avatar.length <= 500 ? avatar : null,
  }
}

/** How long one sync stands before the next list load writes again (the list is read often). */
const SYNC_EVERY_MS = 5 * 60_000
const synced = new Map<string, { at: number; key: string }>()

/** Tests only. */
export function resetSupportStaffSync(): void {
  synced.clear()
}

/**
 * Put this admin on the support team (or refresh their name and picture),
 * and take off anyone on it who is no longer an admin. A person who isn't an
 * admin changes nothing (no write). Returns whether they are on it now. Never
 * throws: a failed write means they are treated as not on it this time.
 */
export async function syncSupportStaff(
  svc: SupabaseClient,
  user: Pick<User, 'id' | 'email' | 'user_metadata'>,
  memberName?: string | null,
): Promise<boolean> {
  try {
    // Not an admin: nothing to write (anyone who was one is taken off by an admin's prune).
    if (!isSupportStaffUser(user)) return false
    const identity = supportIdentity(user, memberName)
    const key = `${identity.display_name}|${identity.avatar_url ?? ''}`
    const last = synced.get(user.id)
    if (last && last.key === key && Date.now() - last.at < SYNC_EVERY_MS) return true
    const { error } = await svc
      .from('support_staff')
      .upsert({ user_id: user.id, ...identity, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) {
      console.warn('[support-chat] staff sync failed:', error.message)
      return false
    }
    synced.set(user.id, { at: Date.now(), key })
    await pruneSupportStaff(svc)
    return true
  } catch (err) {
    console.warn('[support-chat] staff sync failed:', err instanceof Error ? err.message : 'unknown')
    return false
  }
}

/** Take off the support team everyone whose address is no longer an admin's. Never throws. */
export async function pruneSupportStaff(svc: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await svc.from('support_staff').select('user_id')
    if (error || !data?.length) return 0
    let removed = 0
    for (const row of data as Array<{ user_id: string }>) {
      const { data: found } = await svc.auth.admin.getUserById(row.user_id)
      if (found?.user && isAdminEmail(found.user.email)) continue
      const { error: delError } = await svc.from('support_staff').delete().eq('user_id', row.user_id)
      if (!delError) removed += 1
    }
    return removed
  } catch {
    return 0
  }
}
