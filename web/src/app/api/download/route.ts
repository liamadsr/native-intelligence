import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { notFound } from '@/lib/api-errors'
import { downloadUrl, parsePlatform } from '@/lib/app-download'
import { NextResponse } from 'next/server'

/**
 * The desktop app's download: a redirect to APP_DOWNLOAD_URL (macOS, the
 * default) or APP_DOWNLOAD_URL_WINDOWS (`?platform=windows`). 404 when that
 * URL isn't set: a deployment without it offers no download.
 */
export async function GET(request: Request) {
  const platform = parsePlatform(new URL(request.url).searchParams.get('platform')) ?? 'mac'
  const target = downloadUrl(platform)
  if (!target) return notFound('No desktop download on this deployment')

  // Track server-side download event
  const posthog = getPostHogServerClient()
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'anonymous'
  posthog?.capture({
    distinctId: ip,
    event: 'app_downloaded',
    properties: { source: 'website', ...serverDefaultProperties },
  })

  // Redirect to the public download URL
  return NextResponse.redirect(target, 302)
}
