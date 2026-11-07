import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { MAX_BLOCKED_SITES, normalizeBlockedSite } from '@/lib/browser-agent/blocked-sites'
import { loadBlockedSites } from '@/lib/browser-agent/blocked-sites-server'

/**
 * The sites the user has blocked the browser agent from (all their
 * workspaces). Blocked sites in the live view lists, blocks and unblocks here;
 * the relay is handed the list with each command it claims.
 *
 * GET    → { sites }
 * POST   { site } → { sites }   block (a host or a URL; normalized)
 * DELETE { site } → { sites }   unblock (the exact entry)
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json({ sites: await loadBlockedSites(auth.supabase, auth.user.id) })
  } catch {
    return serverError('Could not load blocked sites')
  }
}

async function siteFrom(request: Request): Promise<string | null> {
  try {
    const body = await request.json()
    return typeof body?.site === 'string' ? normalizeBlockedSite(body.site) : null
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const site = await siteFrom(request)
  if (!site) return badRequest('Enter a site like linkedin.com')
  try {
    const current = await loadBlockedSites(auth.supabase, auth.user.id)
    if (!current.includes(site)) {
      if (current.length >= MAX_BLOCKED_SITES) return badRequest('Too many blocked sites')
      const { error } = await auth.supabase
        .from('browser_agent_blocked_sites')
        .upsert({ user_id: auth.user.id, site }, { onConflict: 'user_id,site', ignoreDuplicates: true })
      if (error) return serverError('Could not block the site')
    }
    return NextResponse.json({ sites: await loadBlockedSites(auth.supabase, auth.user.id) })
  } catch {
    return serverError('Could not block the site')
  }
}

export async function DELETE(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const site = await siteFrom(request)
  if (!site) return badRequest('Missing site')
  const { error } = await auth.supabase
    .from('browser_agent_blocked_sites')
    .delete()
    .eq('user_id', auth.user.id)
    .eq('site', site)
  if (error) return serverError('Could not unblock the site')
  try {
    return NextResponse.json({ sites: await loadBlockedSites(auth.supabase, auth.user.id) })
  } catch {
    return serverError('Could not load blocked sites')
  }
}
