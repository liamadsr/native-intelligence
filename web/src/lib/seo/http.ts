/**
 * One mapping from the SEO area's failures to what a route answers and what
 * a tool tells the agent, so every SEO route and tool says the same thing
 * for the same failure. Provider detail stays in the logs; the person reads
 * a plain sentence.
 */
import 'server-only'
import { apiError } from '@/lib/api-errors'
import type { SeoDataRefusal } from './access'
import { isSeoError, type SeoErrorCode } from './errors'
import { isSeoInputError } from './input-error'

const MESSAGES: Record<SeoErrorCode, string> = {
  VALIDATION_ERROR: 'That lookup isn’t valid. Check the keyword, site or location.',
  SEO_NOT_CONFIGURED: 'Search data isn’t set up on this server yet.',
  PROVIDER_AUTH_FAILED: 'The search data provider refused our key. Search data is off until it is fixed.',
  INSUFFICIENT_PROVIDER_BALANCE: 'The search data account is out of balance. Search data is off until it is topped up.',
  RATE_LIMITED: 'The search data provider is busy. Try again in a minute.',
  UPSTREAM_UNAVAILABLE: 'The search data provider didn’t answer. Try again in a moment.',
  SPEND_LIMIT_REACHED: 'This workspace has reached its search data limit for the month.',
  INTERNAL_ERROR: 'Could not look that up just now.',
}

const STATUS: Record<SeoErrorCode, number> = {
  VALIDATION_ERROR: 400,
  SEO_NOT_CONFIGURED: 503,
  PROVIDER_AUTH_FAILED: 503,
  INSUFFICIENT_PROVIDER_BALANCE: 503,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  SPEND_LIMIT_REACHED: 402,
  INTERNAL_ERROR: 500,
}

/**
 * The sentence for a failure. Two kinds keep their own words, because we
 * wrote them for the person: the spend limit (the meter's, with the amount
 * and the reset date) and a request we refused ourselves (a SeoInputError).
 * Every other message can carry the provider's detail (a path, a field name,
 * a status), which is for the logs.
 */
export function seoErrorMessage(error: unknown): { code: SeoErrorCode; message: string } {
  if (!isSeoError(error)) return { code: 'INTERNAL_ERROR', message: MESSAGES.INTERNAL_ERROR }
  // A request we refused ourselves, in words written for the person
  // (./input-error.ts). Read as a value, not as a branch: the two classes
  // have the same shape, so narrowing on one would leave nothing of the other.
  const said = isSeoInputError(error) ? error.message : null
  if (said) return { code: 'VALIDATION_ERROR', message: said }
  const own = error.code === 'SPEND_LIMIT_REACHED' && error.message && error.message !== error.code
  return { code: error.code, message: own ? error.message : MESSAGES[error.code] }
}

/** A route's answer to a failed SEO call. Logs what it does not show. */
export function seoErrorResponse(error: unknown, where: string) {
  const { code, message } = seoErrorMessage(error)
  if (code !== 'VALIDATION_ERROR' && code !== 'SPEND_LIMIT_REACHED') console.error(`[seo] ${where} failed`, error)
  return apiError(message, { status: STATUS[code], code })
}

/** A route's answer when search data may not be used at all (./access.ts). */
export function seoRefusalResponse(refusal: SeoDataRefusal) {
  // 503: nothing this person can change (no key, or a check that could not be read); 403: not for this person or this turn.
  const status = refusal.code === 'SEO_NOT_CONFIGURED' || refusal.code === 'CHECK_FAILED' ? 503 : 403
  return apiError(refusal.message, { status, code: refusal.code })
}

/** A tool's answer to a failed SEO call: data the agent can relay, never a throw. */
export function seoToolError(error: unknown, where: string): { success: false; code: string; error: string } {
  const { code, message } = seoErrorMessage(error)
  if (code !== 'VALIDATION_ERROR' && code !== 'SPEND_LIMIT_REACHED') console.error(`[seo] ${where} failed`, error)
  return { success: false, code, error: message }
}
