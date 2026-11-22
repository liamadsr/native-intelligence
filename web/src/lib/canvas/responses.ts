/** A canvas store refusal as an HTTP response (mirrors src/lib/tables/responses.ts). */
import { badRequest, conflict, forbidden, notFound } from '@/lib/api-errors'
import type { CanvasWrite } from './store'

export function canvasRefusal(result: Extract<CanvasWrite<unknown>, { ok: false }>) {
  switch (result.reason) {
    case 'not_found':
      return notFound(result.error)
    case 'forbidden':
      return forbidden(result.error)
    case 'conflict':
      return conflict(result.error, result.version !== undefined ? { version: result.version } : undefined)
    default:
      return badRequest(result.error)
  }
}
