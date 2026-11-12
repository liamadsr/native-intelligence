/**
 * A request we refuse ourselves, before anything is bought, in words written
 * for the person ("Wildcard search isn’t available for this country.", "Name
 * a domain to look up: this workspace has no website on file yet."). It is a
 * VALIDATION_ERROR like any other, but unlike a provider's own rejection
 * (whose message can carry request detail and stays in the logs) its message
 * is meant to be shown: routes and tools answer it through
 * seoFailureResponse / seoFailureForTool (./paid.ts), which keep these words.
 */
import { SeoError } from './errors'

export class SeoInputError extends SeoError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message)
    this.name = 'SeoInputError'
  }
}

export function isSeoInputError(error: unknown): error is SeoInputError {
  return error instanceof SeoInputError
}
