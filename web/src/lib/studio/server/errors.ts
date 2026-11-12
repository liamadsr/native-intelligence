// The Studio server's one error type. Every function in this folder throws a StudioError when the person (or the
// agent) asked for something that cannot be done; its message is a sentence the editor shows as is, and its status
// is what the HTTP answer carries ({ error } with that status, see router.ts).
import { ZodError } from 'zod'

export class StudioError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message)
    this.name = 'StudioError'
  }
}

/** 404: the thing named is not in this workspace. */
export const notFoundError = (message: string) => new StudioError(message, 404, 'NOT_FOUND')

/** 409: someone else changed it since it was read, or it is busy. */
export const conflictError = (message: string, code = 'CONFLICT') => new StudioError(message, 409, code)

/** 501: the Studio cannot do this here yet. */
export const notYetError = (message: string) => new StudioError(message, 501, 'NOT_AVAILABLE')

/** What every Studio request answers on a server whose database has no Studio yet (migration 620 not applied). */
export const STUDIO_NOT_SET_UP = 'The Studio is not set up on this server yet.'

/**
 * True when a query failed because a Studio table or function is not in the database: PostgREST's PGRST205 (no such
 * table in its schema cache) or PGRST202 (no such function), or Postgres' own 42P01 (no such relation).
 */
export const isNotSetUp = (error: { code?: string } | null | undefined): boolean =>
  error?.code === 'PGRST205' || error?.code === 'PGRST202' || error?.code === '42P01'

const WARNED = Symbol.for('ni.studio.not-set-up-warned')
const shared = globalThis as { [WARNED]?: boolean }

/** 503 STUDIO_NOT_SET_UP: the Studio's tables are not on this database. Said in the log once per process, not per request. */
export function notSetUpError(): StudioError {
  if (!shared[WARNED]) {
    shared[WARNED] = true
    console.warn('[studio] The Studio tables are not in this database (its migrations are not applied): Studio requests answer STUDIO_NOT_SET_UP.')
  }
  return new StudioError(STUDIO_NOT_SET_UP, 503, 'STUDIO_NOT_SET_UP')
}

/** 500 with a message that leaks nothing of the database. */
export const storeError = (what: string) => new StudioError(`Couldn't ${what} just now. Try again.`, 500, 'INTERNAL')

/** The save conflict the editor recognises ("changed in another editor tab"): its draft is kept and it offers to reload. */
export const digestConflict = () =>
  conflictError('This video changed somewhere else since you opened it. Your edits are kept here; open it again before saving.', 'DIGEST_CONFLICT')

/** A zod failure as one readable sentence: the first problem and where it is. */
export function zodSentence(error: ZodError, label: string): string {
  const issue = error.issues[0]
  if (!issue) return `${label} is not valid.`
  const where = issue.path.length ? ` (at ${issue.path.join('.')})` : ''
  const message = issue.message.replace(/\.$/, '')
  return `${label} is not valid: ${message}${where}.`
}

/** Any thrown value as a StudioError: zod failures become sentences, plain errors keep their message (400). */
export function asStudioError(error: unknown, label = 'That request'): StudioError {
  if (error instanceof StudioError) return error
  if (error instanceof ZodError) return new StudioError(zodSentence(error, label), 400, 'INVALID')
  if (error instanceof Error && error.message) return new StudioError(error.message, 400)
  return new StudioError('Something went wrong.', 500, 'INTERNAL')
}
