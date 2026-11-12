/**
 * Tables: a refused write as the routes answer it (src/app/api/account/tables).
 * A stale version is a 409 that carries the version now, so the client can
 * read again and retry.
 */
import { badRequest, conflict, forbidden, notFound } from '@/lib/api-errors'
import type { TableRefusal } from './store'

export function tableRefusal(r: { reason: TableRefusal; error: string; version?: number }) {
  switch (r.reason) {
    case 'conflict':
      return conflict(r.error, r.version !== undefined ? { version: r.version } : undefined, 'VERSION_CONFLICT')
    case 'not_found':
      return notFound(r.error)
    case 'forbidden':
      return forbidden(r.error)
    default:
      return badRequest(r.error)
  }
}
