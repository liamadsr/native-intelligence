/**
 * DELETE /api/account/environments/macs/[deviceId] ("Remove this Mac").
 *
 * Refused while a Dial8 job is open on it (409 MAC_BUSY: stop it first).
 * Otherwise its folders are revoked and its device row deleted, which removes
 * its environment; chats that used it fall back to the next default. A Mac
 * still signed in registers again on its next heartbeat. { removed: true }
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { removeMac } from '@/lib/environments/store'
import { environmentErrorResponse, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function DELETE(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const { deviceId } = await params
  try {
    return NextResponse.json(await removeMac(getServiceClient(), auth.user.id, deviceId))
  } catch (err) {
    return environmentErrorResponse(err, 'remove Mac')
  }
}
