import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { NextResponse } from 'next/server'

const DOWNLOAD_URL = process.env.APP_DOWNLOAD_URL ?? 'https://pub-68f42b03823f4321b0938337ad51ef08.r2.dev/Dial8.dmg'

export async function GET(request: Request) {
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
  return NextResponse.redirect(DOWNLOAD_URL, 302)
} 