import { NextResponse } from 'next/server'
import { badRequest, conflict, notFound, serverError } from '@/lib/api-errors'
import type { StoreResult } from './store'

/** A store refusal as the route's answer. */
export function spreadsheetRefusal(result: Extract<StoreResult<unknown>, { ok: false }>): NextResponse {
  if (result.reason === 'invalid') return badRequest(result.message) as NextResponse
  if (result.reason === 'not_found') return notFound(result.message) as NextResponse
  if (result.reason === 'conflict') {
    return conflict(result.message, { current: result.current }, 'SPREADSHEET_REVISION_CONFLICT') as NextResponse
  }
  return serverError(result.message) as NextResponse
}
