import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { downloadUrl, parsePlatform, platformFromUserAgent } from '@/lib/app-download'
import { NextResponse } from 'next/server'

/**
 * The desktop app's download. `?platform=mac|windows` when a button chose
 * it; otherwise the visitor's user agent (Windows → the Windows installer,
 * anything else → the Mac app), so every older link (emails, onboarding, the
 * nudge) sends a Windows visitor the right file.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const platform = parsePlatform(url.searchParams.get('platform')) ?? platformFromUserAgent(request.headers.get('user-agent'))

  // Track server-side download event
  const posthog = getPostHogServerClient()
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'anonymous'
  posthog?.capture({
    distinctId: ip,
    event: 'app_downloaded',
    properties: { source: 'website', ...serverDefaultProperties, download_platform: platform },
  })

  // Redirect to the public download URL
  return NextResponse.redirect(downloadUrl(platform), 302)
}
