/**
 * A workspace join link's token: 32 bytes from the CSPRNG, base64url (43
 * url-safe characters, 256 bits). Migration 644's CHECK accepts 22 to 128
 * url-safe characters, so anything shorter than 128 bits is refused there too.
 */
import { randomBytes } from 'node:crypto'

export function newJoinToken(): string {
  return randomBytes(32).toString('base64url')
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,128}$/

/** Cheap shape check before a lookup: a path segment that can't be a token never reaches the database. */
export function isJoinTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value)
}

export function joinLinkPath(token: string): string {
  return `/join/${token}`
}

/** What a link that is off, reset or unknown says, on the page and from the API. */
export const JOIN_LINK_CLOSED_MESSAGE = 'This link no longer works'
