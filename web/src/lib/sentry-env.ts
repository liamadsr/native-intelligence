// Shared Sentry environment resolution.
//
// Sentry tags every event with an `environment`. Without an explicit value it
// defaults to the inferred runtime, which on this project meant local dev
// (`development`) and Vercel preview deployments (`vercel-preview`) flooded the
// issues list with HMR artifacts, curl-bot scans, and cancelled requests —
// drowning out any real production errors.
//
// We resolve the environment from Vercel's own signal (`VERCEL_ENV` server-side,
// `NEXT_PUBLIC_VERCEL_ENV` client-side, since only NEXT_PUBLIC_* vars are
// available in the browser bundle) and only report events from production.

import { isInBrowserSurface } from '@/lib/platform'

/**
 * Resolves the deployment environment: 'production' | 'preview' | 'development'.
 */
export function getSentryEnvironment(): string {
  return (
    process.env.VERCEL_ENV ??
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    process.env.NODE_ENV ??
    'development'
  )
}

/**
 * Whether Sentry should report events. Only production traffic is worth
 * tracking — preview/dev events are noise. Skipping init entirely when this is
 * false keeps that noise out of Sentry at the source.
 */
export function isSentryEnabled(): boolean {
  return getSentryEnvironment() === 'production'
}

// Even from production, a large share of client events are not real bugs:
// Apple Mail and Safari aggressively prefetch links out of emails, then abort
// the fetch when the user doesn't actually open the page. That surfaces as
// `TypeError: Load failed` / `NetworkError: Load failed` via the global
// unhandledrejection/onerror handlers — with no actionable stack (minified or a
// blob: URL). These drowned out real errors in the issues list, so we drop them
// before they're sent.

/**
 * Substrings matched against an event's error message. Any match is dropped.
 * Passed to `Sentry.init({ ignoreErrors })`, which matches on both the message
 * and the exception value.
 */
export const SENTRY_IGNORE_ERRORS: (string | RegExp)[] = [
  // Apple Mail / Safari link prefetch aborting the fetch — not a real failure.
  'Load failed',
  'NetworkError when attempting to fetch resource',
  // User navigated away / cancelled an in-flight request.
  'AbortError',
  'The operation was aborted',
  // Benign ResizeObserver loop notification fired by some browsers.
  'ResizeObserver loop',
  // Microsoft embedded-webview/scanner artifact (Outlook SafeLinks, CefSharp
  // hosts): their injected bridge script rejects with this bare string on
  // pages it scans. Not our code — no stack, fires on marketing/login pages.
  'Object Not Found Matching Id',
]

/**
 * Client `beforeBreadcrumb` filter. Inside the agent browser's DOM
 * ([data-dial8-browser]: its live view and the computer card) the DOM is
 * the person's browsing, and Sentry's ui.click / ui.input breadcrumbs serialize
 * the element's title + aria-label — i.e. visited sites and blocked hosts —
 * into every later error event. Drop those; keep everything else (and every
 * breadcrumb from the rest of the app). Keyed on the event target, which Sentry
 * passes as `hint.event`; no hint → kept.
 */
export function shouldDropSentryBreadcrumb(
  breadcrumb: { category?: string },
  hint?: { event?: unknown },
): boolean {
  if (breadcrumb.category !== 'ui.click' && breadcrumb.category !== 'ui.input') return false
  return isInBrowserSurface((hint?.event as Event | undefined)?.target)
}

/**
 * Last-resort drop filter for the client `beforeSend` hook, covering noise that
 * `ignoreErrors` (message-based) can miss — e.g. events whose only signal is the
 * reporting browser. Returns true when the event should NOT be sent.
 */
export function shouldDropSentryEvent(
  event: { request?: { headers?: Record<string, string> } },
  hint?: { originalException?: unknown },
): boolean {
  // Drop everything reported by Apple Mail's webview. Real users hit the app in
  // a normal browser; Apple Mail only ever shows up via email link prefetch.
  const ua =
    event.request?.headers?.['User-Agent'] ??
    event.request?.headers?.['user-agent'] ??
    ''
  if (/AppleMail|Apple Mail/i.test(ua)) return true

  // Some prefetch aborts arrive as a bare string or an Error with no useful
  // stack; catch the "Load failed" family regardless of how it's wrapped.
  const message =
    typeof hint?.originalException === 'string'
      ? hint.originalException
      : (hint?.originalException as { message?: string } | undefined)?.message
  if (message && /(^|\b)(Network)?Error?:?\s*Load failed/i.test(message)) {
    return true
  }

  return false
}
