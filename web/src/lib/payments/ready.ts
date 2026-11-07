/**
 * Whether a workspace can take card payments now: Connect may run (a test
 * key, or live switched on: ./config.ts) and its connected account is ready.
 * The outward gate's question before it holds send_payment_link.
 *
 * Server only. Throws on a failed read (the gate then holds).
 */
import { getServiceClient } from '@/lib/admin'
import { connectAvailability } from './config'

export async function paymentsReady(workspaceId: string): Promise<boolean> {
  const availability = connectAvailability()
  if (!availability.ok) return false
  const { data, error } = await getServiceClient().from('stripe_connect_account').select('status, livemode').eq('workspace_id', workspaceId).maybeSingle<{ status: string; livemode: boolean }>()
  if (error) throw new Error(`stripe_connect_account read failed: ${error.message}`)
  // An account from the other mode (the key switched since) can't take these payments.
  return data?.status === 'ready' && !!data.livemode === availability.livemode
}
