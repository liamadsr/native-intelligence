import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ target: string; arch: string; current_version: string }> }
) {
  const { target, arch, current_version } = await params

  // Fetch the latest published release (service client — no auth needed)
  const supabase = getServiceClient()
  const { data: releases } = await supabase
    .from('desktop_releases')
    .select('*')
    .eq('published', true)
    .order('created_at', { ascending: false })
    .limit(1)

  const release = releases?.[0]

  if (!release) {
    // No release found
    return new NextResponse(null, { status: 204 })
  }

  // Check if the current version is already up to date
  if (!isNewerVersion(release.version, current_version)) {
    return new NextResponse(null, { status: 204 })
  }

  // Find the platform-specific artifact
  const platformKey = `${target}-${arch}`
  const platform = release.platforms?.[platformKey]

  if (!platform) {
    // No artifact for this platform
    return new NextResponse(null, { status: 204 })
  }

  return NextResponse.json({
    version: release.version,
    notes: release.notes ?? '',
    pub_date: release.pub_date ?? release.created_at,
    url: platform.url,
    signature: platform.signature,
  })
}

/**
 * Compare semver strings. Returns true if `latest` is newer than `current`.
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [lMaj, lMin = 0, lPat = 0] = parse(latest)
  const [cMaj, cMin = 0, cPat = 0] = parse(current)

  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}
