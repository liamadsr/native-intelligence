/**
 * A Mac's environment exists with the Mac (docs/plans/environments.md §4):
 * the device heartbeat creates it on a device's first beat, and a local
 * agent session stamps it when it starts. Kept apart from ./store so the
 * local-agent library can import it without an import cycle.
 *
 * `svc` is a service-role client (environment has no client write policy).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { macEnvironmentName } from './types'

type Svc = SupabaseClient

/**
 * The Mac environment of (userId, deviceId), made now when it doesn't exist
 * yet: one insert with ON CONFLICT (owner_user_id, device_id) DO NOTHING
 * (migration 420's environment_one_per_mac), then a read only when the row
 * was already there. Named after the device on creation; a rename later is
 * the person's and is kept. Returns its id, or null when the device row is
 * gone (the composite foreign key refuses the insert). Throws on a database
 * error.
 */
export async function ensureMacEnvironment(svc: Svc, userId: string, deviceId: string, name: string | null | undefined): Promise<string | null> {
  const { data: made, error } = await svc
    .from('environment')
    .upsert(
      { kind: 'mac', name: macEnvironmentName(name), owner_user_id: userId, device_id: deviceId },
      { onConflict: 'owner_user_id,device_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    // 23503: the user_device row is gone (a Mac removed mid-call).
    if (error.code === '23503') return null
    throw new Error(`mac environment insert failed: ${error.message}`)
  }
  const id = (made as Array<{ id: string }> | null)?.[0]?.id
  if (id) return id
  return macEnvironmentId(svc, userId, deviceId)
}

/** The Mac environment's id of (userId, deviceId), or null. */
export async function macEnvironmentId(svc: Svc, userId: string, deviceId: string): Promise<string | null> {
  const { data, error } = await svc
    .from('environment')
    .select('id')
    .eq('kind', 'mac')
    .eq('owner_user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle()
  if (error) throw new Error(`mac environment read failed: ${error.message}`)
  return (data as { id: string } | null)?.id ?? null
}
