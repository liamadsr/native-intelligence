import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isDeviceToken, resolveDeviceToken } from '@/lib/device-tokens'
import { checkUsageLimits } from '@/lib/ai/auth'

/**
 * POST /api/deepgram-token
 *
 * Creates a short-lived (60s) Deepgram API key for real-time streaming.
 * The master DEEPGRAM_API_KEY stays server-side — only the disposable key
 * reaches the client.
 *
 * Uses Deepgram's "Create Key" API:
 *   1. GET /v1/projects → get project_id
 *   2. POST /v1/projects/{project_id}/keys → create temp key with time_to_live_in_seconds
 *
 * Requires authenticated Supabase session (via cookies or Authorization header).
 */

let cachedProjectId: string | null = null

export async function POST(request: NextRequest) {
  // Try cookie-based auth first, fall back to Authorization header
  // (desktop app uses header because OAuth happens in system browser)
  const supabase = await createClient()
  const cookieAuth = await supabase.auth.getUser()
  let user: { id: string } | null = cookieAuth.data.user

  if (!user) {
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      if (isDeviceToken(token)) {
        // Native Intelligence device token (`nid_…`): opaque, resolved against device_token.
        const resolved = await resolveDeviceToken(token)
        if (resolved) user = { id: resolved.userId }
      } else {
        // Supabase access token (`eyJ…`): validate as a JWT.
        const supa = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        )
        const { data } = await supa.auth.getUser(token)
        user = data.user
      }
    }
  }

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Gate before minting a streaming key. A 60s token means this re-applies
  // every minute of streaming, so an over-limit user can't keep transcribing.
  // checkUsageLimits throws a raw 429/503 Response — return it directly. This
  // MUST stay outside the try/catch below, which would rewrap it as a 500.
  try {
    await checkUsageLimits(user.id)
  } catch (limitResponse) {
    if (limitResponse instanceof Response) return limitResponse
    throw limitResponse
  }

  const key = process.env.DEEPGRAM_API_KEY
  if (!key) {
    return NextResponse.json(
      { error: 'Deepgram API key not configured' },
      { status: 500 },
    )
  }

  try {
    // Step 1: Get project ID (cached after first call)
    if (!cachedProjectId) {
      const projectsRes = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${key}` },
      })
      if (!projectsRes.ok) {
        const body = await projectsRes.text()
        return NextResponse.json(
          { error: `Deepgram projects error (${projectsRes.status}): ${body}` },
          { status: projectsRes.status },
        )
      }
      const projectsData = await projectsRes.json()
      cachedProjectId = projectsData.projects?.[0]?.project_id
      if (!cachedProjectId) {
        return NextResponse.json(
          { error: 'No Deepgram project found' },
          { status: 500 },
        )
      }
    }

    // Step 2: Create a short-lived API key (60 seconds)
    const res = await fetch(
      `https://api.deepgram.com/v1/projects/${cachedProjectId}/keys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          comment: `temp-${user.id}-${Date.now()}`,
          scopes: ['usage:write'],
          time_to_live_in_seconds: 60,
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text()
      // If project ID was stale, clear cache and retry next time
      if (res.status === 404) cachedProjectId = null
      return NextResponse.json(
        { error: `Deepgram key error (${res.status}): ${body}` },
        { status: res.status },
      )
    }

    const data = await res.json()

    return NextResponse.json({
      token: data.key,
      expiresIn: 60,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `Failed to generate token: ${msg}` },
      { status: 500 },
    )
  }
}
