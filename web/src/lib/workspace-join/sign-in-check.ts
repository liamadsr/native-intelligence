/**
 * Once per sign-in: the join-by-domain check (domain-offer.ts) runs at most
 * once for each sign-in, wherever it is reached first.
 *
 * Its own marker, not the analytics dedup cookie (which lasts an hour and is
 * not set at all without PostHog): an httpOnly cookie holding the sign-in's
 * `last_sign_in_at`, which Supabase changes on every sign-in and never on a
 * token refresh. Same value: this sign-in was checked. A new sign-in, or no
 * cookie: check, then write it.
 *
 *   the server callbacks  (/auth/callback, Google, ChatGPT): check, write the
 *                         marker on the redirect, and land on /join/team
 *                         instead of /account when there is an offer;
 *   the auth-session ping (password and desktop sign-ins, which finish in the
 *                         browser): the same, answering `joinOffer: true` so
 *                         the page goes to /join/team.
 */
import type { NextResponse } from 'next/server'

export const JOIN_OFFER_PAGE = '/join/team'
export const JOIN_CHECK_COOKIE = 'ni_join_checked'

export interface SignedInUser {
  last_sign_in_at?: string | null
}

/** What identifies this sign-in, or null when the user record has none. */
export function signInStamp(user: SignedInUser | null | undefined): string | null {
  return user?.last_sign_in_at || null
}

export function checkedThisSignIn(cookieValue: string | undefined, user: SignedInUser | null | undefined): boolean {
  const stamp = signInStamp(user)
  return !!stamp && cookieValue === stamp
}

/** Write the marker on the response that ends this check. */
export function markCheckedThisSignIn(response: NextResponse, user: SignedInUser | null | undefined): NextResponse {
  const stamp = signInStamp(user)
  if (stamp) {
    response.cookies.set(JOIN_CHECK_COOKIE, stamp, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    })
  }
  return response
}
