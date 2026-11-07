import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { forgetSite, readSiteMemory } from '@/lib/cloud-browser/site-memory'

/**
 * GET: what the person's agent browser learned about sites
 * (docs/plans/cloud-browser.md, C4): those it reaches only through their Mac,
 * and those it never uses. DELETE ?site=: forget one (the person's undo for a
 * site it got wrong). The code's own never-automate seed stays.
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json(await readSiteMemory(auth.user.id))
  } catch {
    return apiError('Could not read the browser’s site memory', { status: 500, code: 'INTERNAL' })
  }
}

export async function DELETE(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const site = new URL(request.url).searchParams.get('site')
  if (!site) return badRequest('site is required')
  try {
    await forgetSite(auth.user.id, site)
  } catch {
    return apiError('Could not forget the site', { status: 500, code: 'INTERNAL' })
  }
  return NextResponse.json({ ok: true })
}
