'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-js/react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { PublicSky } from '@/components/sky/public-sky'

/**
 * Desktop-only escape hatch for a debugging session, read from localStorage —
 * NOT a NEXT_PUBLIC_* build-time env var. The desktop shell loads the already
 * deployed production bundle from dial8.ai, so a build-time flag cannot vary
 * per desktop build; it would have to be flipped for every web visitor too.
 * To re-enable replay in the desktop app for one session, run in the webview
 * devtools console and reload:
 *   localStorage.setItem('dial8:posthog-replay', 'on')
 * (remove the key to go back to the default off). Wrapped in try/catch because
 * localStorage throws outright in some privacy modes rather than returning null.
 */
function isDesktopReplayForced(): boolean {
  try {
    return localStorage.getItem('dial8:posthog-replay') === 'on'
  } catch {
    return false
  }
}

// HUD windows (/hud/*, the desktop app's overlays) aren't visits to Native Intelligence, and
// a texted single-use link's pages (/l/*) carry its token in the path, which
// must never reach analytics (src/lib/links/one-time.ts).
// (The agent browser's live view and computer card are not routes: their DOM —
// the person's browsing — carries `ph-no-capture`, which keeps it out of
// autocapture AND session recording; see components/cloud-browser.)
if (
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_POSTHOG_KEY &&
  !window.location.pathname.startsWith('/hud/') &&
  !window.location.pathname.startsWith('/l/')
) {
  // Session replay (rrweb) is the single biggest analytics-side contributor to
  // the desktop app's WebContent heap: every dashboard tab stays mounted
  // (display:none) for the life of the shell, so rrweb's MutationObserver is
  // attached to a DOM that never shrinks, and posthog-js takes a FULL snapshot
  // of that whole tree every 5 min by default (full_snapshot_interval_millis).
  // Over a 7 h session that measured 948 MB resident / 1.82 GB peak, while
  // Chrome — where tabs are not kept mounted for hours — stayed ~90 MB.
  // `disable_session_recording` is one of the ANDed terms in posthog-js's
  // `_isRecordingEnabled`, so setting it here forces recording off regardless
  // of the project's server-side replay toggle, and the rrweb recorder.js
  // bundle is never even fetched. Product analytics (capture/$pageview/
  // pageleave) are untouched, and the web path is byte-identical to before:
  // isDesktopApp() is false there, so this stays `false`.
  const desktop = isDesktopApp()
  const replayForced = desktop && isDesktopReplayForced()
  const disableSessionRecording = desktop && !replayForced

  if (replayForced) {
    // A forgotten debug key silently reinstates the memory growth this gate
    // exists to prevent, so make it visible once at init rather than leaving
    // the shell quietly recording for days.
    console.warn(
      '[dial8] PostHog session replay force-enabled via localStorage dial8:posthog-replay — remove the key to restore the default',
    )
  }

  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || '/ingest',
    person_profiles: 'identified_only',
    capture_pageview: false, // We handle this manually for App Router
    capture_pageleave: true,
    disable_session_recording: disableSessionRecording,
  })
  posthog.register({
    platform: 'web',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  })
}

function PostHogPageview() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const posthog = usePostHog()

  useEffect(() => {
    if (pathname && posthog && !pathname.startsWith('/hud/') && !pathname.startsWith('/l/')) {
      let url = window.origin + pathname
      if (searchParams.toString()) {
        url = url + '?' + searchParams.toString()
      }
      posthog.capture('$pageview', { $current_url: url })
    }
  }, [pathname, searchParams, posthog])

  return null
}

// The public sky (every page outside the signed-in app) rides here rather
// than beside {children} in the root layout: this module is already the one
// client component <body> holds, so the sky adds no forked child to the
// server layout (see app/layout.tsx).
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return (
      <>
        <PublicSky />
        {children}
      </>
    )
  }

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      <PublicSky />
      {children}
    </PHProvider>
  )
}
