/**
 * One mapping from a Google read's failure to what a route answers and what
 * a tool tells the agent, so both say the same thing. Google's own detail
 * stays in the logs.
 */
import { apiError } from '@/lib/api-errors'
import 'server-only'
import { isGoogleSeoError } from './errors'
import type { GoogleSeoErrorCode } from './view'

const STATUS: Record<GoogleSeoErrorCode, number> = {
  NOT_CONNECTED: 409,
  NO_SOURCE: 409,
  RECONNECT_NEEDED: 409,
  NO_ACCESS: 403,
  QUOTA: 429,
  UPSTREAM: 502,
  INVALID_REQUEST: 400,
}

/** Failures worth a log line: Google or us misbehaving, not a person's state. */
function logWorthy(code: GoogleSeoErrorCode): boolean {
  return code === 'UPSTREAM' || code === 'QUOTA'
}

/** A route's answer to a failed Google read or choice. */
export function googleErrorResponse(error: unknown, where: string) {
  if (!isGoogleSeoError(error)) {
    console.error(`[seo-google] ${where} failed`, error)
    return apiError('Could not reach Google just now.', {
      status: 500,
      code: 'INTERNAL_ERROR',
    })
  }
  if (logWorthy(error.code))
    console.warn(
      `[seo-google] ${where}: ${error.code} ${error.extra.detail ?? ''}`,
    )
  return apiError(error.message, {
    status: STATUS[error.code],
    code: error.code,
    details: error.details(),
  })
}

/** A route's answer to a write core's refusal. */
export function googleRefusalResponse(out: {
  code: GoogleSeoErrorCode
  message: string
}) {
  return apiError(out.message, { status: STATUS[out.code], code: out.code })
}

/** What the agent does next for each code. */
const NEXT: Partial<
  Record<
    GoogleSeoErrorCode,
    (product: 'search_console' | 'analytics') => string
  >
> = {
  NOT_CONNECTED: (p) =>
    `Ask the person to connect it: in the app, put up a Connect card with connect (provider google, capability ${p}); if they are texting you, text them a link with connect_link (provider ${p === 'search_console' ? 'google_search_console' : 'google_analytics'}). Never ask for a password.`,
  NO_SOURCE: (p) =>
    p === 'search_console'
      ? 'Choose the site: list_search_console_sites, then set_search_console_site with the one they confirm (or the suggested one).'
      : 'Choose the property: list_google_analytics_properties, then set_google_analytics_property with the one they confirm.',
  RECONNECT_NEEDED: (p) =>
    `Tell them who has to sign in again (above). If it is them: connect (provider google, capability ${p}) puts up a Reconnect card. Anyone else with access can choose it again through their own connection.`,
  NO_ACCESS: () =>
    'Ask them to check the Google account’s access, or choose another site or property.',
  QUOTA: () => 'Google’s quota is spent for now: try later, and say so.',
}

/** A tool's answer to a failed Google read: data the agent can relay, never a throw. */
export function googleToolError(
  error: unknown,
  where: string,
): {
  success: false
  code: string
  error: string
  next_step?: string
  reconnect_by?: string | null
} {
  if (!isGoogleSeoError(error)) {
    console.error(`[seo-google] ${where} failed`, error)
    return {
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'Could not reach Google just now.',
    }
  }
  if (logWorthy(error.code))
    console.warn(
      `[seo-google] ${where}: ${error.code} ${error.extra.detail ?? ''}`,
    )
  const next = NEXT[error.code]?.(error.product)
  return {
    success: false,
    code: error.code,
    error: error.message,
    ...(next ? { next_step: next } : {}),
    ...(error.code === 'RECONNECT_NEEDED'
      ? {
          reconnect_by: error.extra.reconnectBy?.is_you
            ? 'you (the person asking)'
            : (error.extra.reconnectBy?.name ?? null),
        }
      : {}),
  }
}

/** A tool's answer to a write core's refusal. */
export function googleToolRefusal(
  out: { code: GoogleSeoErrorCode; message: string },
  product: 'search_console' | 'analytics',
) {
  const next = NEXT[out.code]?.(product)
  return {
    success: false as const,
    code: out.code,
    error: out.message,
    ...(next ? { next_step: next } : {}),
  }
}
