/**
 * GET /api/account/email/shares/targets (migration 646) → { targets } the
 * channels and DMs the caller may post in here, for the Share to chat picker,
 * each saying whether guests (people outside the workspace) can read it.
 */
import type { NextRequest } from 'next/server'
import { defaultEmailShareDeps, listShareTargets } from '@/lib/email-share/service'
import { noStore, shareCaller } from '@/lib/email-share/http'

export async function GET(request: NextRequest) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  return noStore({ targets: await listShareTargets(defaultEmailShareDeps(), caller) })
}
