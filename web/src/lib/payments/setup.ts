/**
 * Texting the owner their Stripe setup link, and telling them when it's done
 * (roadmap C1).
 *
 *   textSetupLink   a fresh single-use link (./setup-link.ts) texted to the
 *                   owner's verified number. Only a workspace owner or admin
 *                   can connect the workspace's payments. Called by the agent's
 *                   send_payment_link when Stripe isn't ready yet, by the
 *                   Settings route, by the refresh route (Stripe's own link
 *                   expired), and meant for track A's sign-up-by-text flow.
 *   notifyIfReady   after any re-read of the account, the one confirmation
 *                   text when it can first take payments ("Stripe is
 *                   connected"), sent by whichever caller won the claim
 *                   (./accounts.ts syncConnectedAccount).
 *
 * Server only. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectAvailability, paymentsOrigin } from './config'
import { createSetupLink } from './setup-link'
import { textOwner } from './deliver'
import type { SyncResult } from './accounts'

export type SetupLinkTextResult =
  | { sent: true; url: string; expiresAt: string }
  | { sent: false; reason: 'not_admin' | 'payments_off' | 'too_soon' | 'daily_cap' | 'link_failed' | 'no_phone' | 'text_failed'; url?: string; error?: string }

async function roleOf(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>()
  return data?.role ?? null
}

async function businessName(supabase: SupabaseClient, workspaceId: string): Promise<string> {
  const { data } = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle<{ name: string | null }>()
  return data?.name?.trim().slice(0, 60) || 'your business'
}

/** The setup text. Pure. */
export function setupLinkText(business: string, url: string): string {
  return `To let customers pay ${business} by card, connect Stripe here (works once, for 15 minutes): ${url}`
}

/** The confirmation text. Pure. */
export function readyText(business: string): string {
  return `Stripe is connected: customers can now pay ${business} by card, straight into your Stripe account. Ask me any time to send a customer a payment link.`
}

/** Text the owner a fresh setup link. */
export async function textSetupLink(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; origin?: string },
): Promise<SetupLinkTextResult> {
  const availability = connectAvailability()
  if (!availability.ok) return { sent: false, reason: 'payments_off', error: availability.reason }
  const role = await roleOf(supabase, args.workspaceId, args.userId).catch(() => null)
  if (role !== 'owner' && role !== 'admin') return { sent: false, reason: 'not_admin' }
  const link = await createSetupLink(supabase, { workspaceId: args.workspaceId, userId: args.userId, origin: args.origin ?? paymentsOrigin() })
  if (!link.ok) return { sent: false, reason: link.reason ?? 'link_failed', error: link.error }
  const texted = await textOwner(supabase, args.userId, setupLinkText(await businessName(supabase, args.workspaceId), link.url), args.workspaceId)
  if (!texted.sent) return { sent: false, reason: texted.reason === 'no_phone' ? 'no_phone' : 'text_failed', url: link.url }
  return { sent: true, url: link.url, expiresAt: link.expiresAt }
}

/** Tell the owner payments are on, once. */
export async function notifyIfReady(supabase: SupabaseClient, synced: SyncResult): Promise<boolean> {
  if (!synced.becameReady || !synced.account.connectedBy) return false
  const texted = await textOwner(supabase, synced.account.connectedBy, readyText(await businessName(supabase, synced.account.workspaceId)), synced.account.workspaceId)
  return texted.sent
}
