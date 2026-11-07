/**
 * Standardized API error responses.
 *
 * Before this helper existed, ~230 API routes each built error responses
 * inline with slightly different shapes:
 *
 *   NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 *   NextResponse.json({ error: error.message }, { status: 500 })
 *   NextResponse.json({ error: 'No workspace' }, { status: 400 })
 *
 * Inconsistency made it hard for the frontend to do anything smarter than
 * show the raw string. This module centralizes the shape so we can evolve
 * it in one place (e.g. add `code` fields, structured details) without
 * touching every route.
 *
 * Shape: { error: string, code?: string, details?: unknown }
 *
 * Usage:
 *   import { apiError, unauthorized, notFound } from '@/lib/api-errors'
 *   return unauthorized()
 *   return notFound('Action not found')
 *   return apiError('Something went wrong', { status: 500, code: 'INTERNAL' })
 */
import { NextResponse } from 'next/server'

export interface ApiErrorBody {
  error: string
  code?: string
  details?: unknown
}

export interface ApiErrorOptions {
  status?: number
  code?: string
  details?: unknown
}

/**
 * Build a standardized NextResponse error. All other helpers below are
 * thin wrappers around this for the common HTTP statuses.
 */
export function apiError(message: string, opts: ApiErrorOptions = {}) {
  const body: ApiErrorBody = { error: message }
  if (opts.code) body.code = opts.code
  if (opts.details !== undefined) body.details = opts.details
  return NextResponse.json(body, { status: opts.status ?? 500 })
}

export function unauthorized(message = 'Unauthorized') {
  return apiError(message, { status: 401, code: 'UNAUTHORIZED' })
}

/**
 * The caller's session token expired (a distinct 401 from a plain missing/
 * invalid session). PostgREST rejects an expired Supabase JWT with PGRST303 on
 * the token-bound client; a half-expired session (dead cookie, stale Bearer)
 * lands here rather than a bogus 500. The dedicated `SESSION_EXPIRED` code lets
 * the client refresh its access token and retry the request once.
 */
export function sessionExpired(message = 'Session expired') {
  return apiError(message, { status: 401, code: 'SESSION_EXPIRED' })
}

export function forbidden(message = 'Forbidden') {
  return apiError(message, { status: 403, code: 'FORBIDDEN' })
}

export function notFound(message = 'Not found') {
  return apiError(message, { status: 404, code: 'NOT_FOUND' })
}

export function badRequest(message = 'Bad request', details?: unknown) {
  return apiError(message, { status: 400, code: 'BAD_REQUEST', details })
}

export function noWorkspace(message = 'No workspace') {
  return apiError(message, { status: 400, code: 'NO_WORKSPACE' })
}

export function notMember(message = 'Not a workspace member') {
  return apiError(message, { status: 403, code: 'NOT_MEMBER' })
}

/**
 * The workspace has the feature this route belongs to switched off. A distinct
 * 403 from NOT_MEMBER: the caller IS a member, the surface just isn't enabled
 * here, so a client can tell "you can't" from "this workspace doesn't have it".
 */
export function featureDisabled(message = 'Feature not enabled for this workspace') {
  return apiError(message, { status: 403, code: 'FEATURE_DISABLED' })
}

/**
 * The write named a version of the row that is no longer current (a
 * compare-and-swap that lost): nothing was written. `details` says what the
 * row is at now, so the client can re-read and decide.
 */
export function conflict(message = 'Conflict', details?: unknown, code = 'CONFLICT') {
  return apiError(message, { status: 409, code, details })
}

export function rateLimited(message = 'Rate limited') {
  return apiError(message, { status: 429, code: 'RATE_LIMITED' })
}

export function serverError(
  message = 'Internal server error',
  details?: unknown,
) {
  return apiError(message, { status: 500, code: 'INTERNAL', details })
}
