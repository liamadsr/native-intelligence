/**
 * Which number a person's texts about a workspace come from: one phone, two
 * agents (Liam, 2026-11-01: "the text would just go to and come from
 * different numbers"). The rule: Native Intelligence texts a person from a business's own
 * number (roadmap B2) only when a text from their phone to that number would
 * resolve back to that same person (./inbound.ts businessPerson, ./store.ts
 * findBusinessPerson), so a reply lands with the agent that sent the text,
 * and a STOP or START there changes exactly that person's row. Otherwise the
 * Native Intelligence number.
 *
 * One phone, two accounts (migration 464): a business-line row (`line =
 * 'business'`, a business's own account on a phone whose Native Intelligence line is
 * another account's) is texted ONLY from such a business number, never the
 * Native Intelligence one: its reply to the Native Intelligence number would reach the other account.
 * With none (the business has no live number yet) nothing is sent
 * ('no_line'). An NI-line row is texted as above.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { findBusinessPerson, isWorkspaceMember, linkedPhoneForUser, type LinkedPhone } from './store'

/**
 * The business number to text `userId` from about `workspaceId`, or null for
 * the Native Intelligence one: no live number, or a text from their phone (`phone`, else
 * their verified one) to it wouldn't come back to them: they aren't one of
 * its people (their reply would make them its customer), or another of its
 * people's row on that phone answers there first. A failed read is the Native Intelligence
 * number: the person still hears (a business-line phone hears nothing then:
 * {@link sendingLine}). Never throws.
 */
export async function workspaceLine(supabase: SupabaseClient, workspaceId: string, userId: string, phone?: string): Promise<string | null> {
  try {
    const number = await activeBusinessNumber(supabase, workspaceId)
    if (!number) return null
    const theirs = phone ?? (await linkedPhoneForUser(supabase, userId))?.phone
    if (!theirs) return null
    return (await findBusinessPerson(supabase, theirs, workspaceId))?.userId === userId ? number.phone : null
  } catch (err) {
    console.warn('[sms] business number read failed, texting from the Native Intelligence number:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * The number a text to this verified phone about `workspaceId` comes from: a
 * business's own number, null for the Native Intelligence one, or 'no_line' for a
 * business-line phone with no business number to text it from (nothing may
 * be sent: see the header). Never throws.
 */
export async function sendingLine(
  supabase: SupabaseClient,
  phone: Pick<LinkedPhone, 'userId' | 'phone' | 'line'>,
  workspaceId: string,
): Promise<string | null | 'no_line'> {
  const from = await workspaceLine(supabase, workspaceId, phone.userId, phone.phone)
  if (from) return from
  return phone.line === 'business' ? 'no_line' : null
}

/**
 * Whether something about `workspaceId` (a connect link, its confirmation)
 * may be texted to this verified phone: an NI-line phone linked there, or
 * whose person is one of that workspace's own people; a business-line phone
 * only when that workspace has a business number to text it from (see the
 * header). Never throws (false).
 */
export async function phoneServesWorkspace(
  supabase: SupabaseClient,
  phone: Pick<LinkedPhone, 'userId' | 'workspaceId' | 'phone' | 'line'>,
  workspaceId: string,
): Promise<boolean> {
  if (phone.line === 'business') return (await workspaceLine(supabase, workspaceId, phone.userId, phone.phone)) !== null
  if (phone.workspaceId === workspaceId) return true
  try {
    return await isWorkspaceMember(supabase, phone.userId, workspaceId)
  } catch {
    return false
  }
}
