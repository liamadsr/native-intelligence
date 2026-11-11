/**
 * The two public links of a time offer (migration 554):
 *
 *   /t/<token>   the offer's page: the guest picks a time. A random token
 *                (144 bits) minted when the offer is sent; only its sha256
 *                is stored (time_offer.token_hash).
 *   /t/<token>   a poll guest's page (migration 583): an HMAC of their row's
 *                id under a key kept for this one purpose, so the host can
 *                copy the same link again (list_time_offers, a nudge); only
 *                its sha256 is stored (time_offer_recipient.token_hash), and
 *                only once the poll is sent.
 *   /b/<token>   the guest's manage page for a booking: cancel or move it.
 *                An HMAC of the booking's id under a key kept for this one
 *                purpose (derived from the OAuth state secret, as the
 *                payments return token is), so the server can write the same
 *                link into the calendar event on a retry after a crash
 *                without ever storing the token: only its sha256 is stored
 *                (meeting_booking.manage_token_hash), and lookups go by it.
 *
 * Server only.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { oauthStateSecret } from '@/lib/oauth/state'

/** 24 base64url characters: 18 random bytes for an offer, 18 bytes of HMAC for a booking. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24}$/

/** True when `token` has a link token's shape (checked before any read). */
export function isOfferToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

/** A new offer token. */
export function mintOfferToken(): string {
  return randomBytes(18).toString('base64url')
}

/** The stored form of an offer token. */
export function offerTokenHash(token: string): string {
  return createHash('sha256').update(`time-offer:${token}`).digest('hex')
}

function manageKey(secret: string): string {
  return createHmac('sha256', secret).update('ni-meeting-booking-manage-v1').digest('base64url')
}

/** A booking's manage token: the same for the same booking, unguessable without the server's secret. */
export function manageTokenFor(bookingId: string, secret: string = oauthStateSecret()): string {
  return createHmac('sha256', manageKey(secret)).update(`booking:${bookingId}`).digest().subarray(0, 18).toString('base64url')
}

function pollKey(secret: string): string {
  return createHmac('sha256', secret).update('ni-time-offer-poll-guest-v1').digest('base64url')
}

/** A poll guest's link token: the same for the same guest, unguessable without the server's secret. */
export function pollTokenFor(recipientId: string, secret: string = oauthStateSecret()): string {
  return createHmac('sha256', pollKey(secret)).update(`poll-guest:${recipientId}`).digest().subarray(0, 18).toString('base64url')
}

/** A poll guest's own manage token for their group meeting: theirs alone, never the meeting's. */
export function pollManageTokenFor(bookingId: string, recipientId: string, secret: string = oauthStateSecret()): string {
  return createHmac('sha256', manageKey(secret)).update(`booking:${bookingId}:guest:${recipientId}`).digest().subarray(0, 18).toString('base64url')
}

/** The stored form of a manage token. */
export function manageTokenHash(token: string): string {
  return createHash('sha256').update(`meeting-booking:${token}`).digest('hex')
}

const trimOrigin = (origin: string) => origin.replace(/\/$/, '')

/** The offer's page. */
export function offerUrl(origin: string, token: string): string {
  return `${trimOrigin(origin)}/t/${token}`
}

/** The booking's manage page. */
export function manageUrl(origin: string, token: string): string {
  return `${trimOrigin(origin)}/b/${token}`
}

/** An offer link as a card shows it before it exists: the address with its token left out. */
export function offerUrlShown(origin: string): string {
  return `${trimOrigin(origin)}/t/…`
}
