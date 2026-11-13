import { createClient } from '@/lib/supabase/server'
import {
  AUTH_EVENT_COOKIE,
  isFreshSignupUser,
  trackAuthSession,
} from '@/lib/posthog'
import {
  SIGN_IN_COUNT_CEILING,
  SIGN_IN_COUNT_METADATA_KEY,
} from '@/lib/onboarding/sign-in-count'
import {
  SIGNUP_EDITION_COOKIE,
  consumeSignupEdition,
} from '@/lib/editions/attribution'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { getServiceClient } from '@/lib/supabase/service'
import { seedSignupLoops } from '@/lib/flows/seed-signup-loops'
import { joinByEmailDomainAtSignIn } from '@/lib/workspace-join/domain-join'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

/**
 * POST /api/analytics/auth-session
 *
 * Counts an authenticated session as a signup or login, exactly once per
 * sign-in, across EVERY auth method (OAuth, password, magic link, returning
 * session). Called once on mount from the first authenticated surface
 * (trial wall / onboarding wizard / dashboard shell) via
 * {@link AuthSessionPinger}.
 *
 * WHY a Route Handler: Next 16 forbids mutating cookies in Server Components,
 * so the dedup-cookie write that `trackAuthSession` requires can't live in the
 * account layout. A Route Handler is the choke-point where the write is legal —
 * and the client pinger guarantees every session reaches it regardless of how
 * the user authenticated (password logins never hit the OAuth /auth/callback).
 *
 * Also consumes the persona-edition signup cookie (see
 * lib/editions/attribution.ts). Same two reasons put it here: this is the
 * choke-point every auth method reaches, and a Route Handler is where the
 * cookie can legally be expired.
 *
 * And seeds Triage into a new account's own workspace (see
 * lib/flows/seed-signup-loops.ts): the signup trigger makes that workspace in
 * SQL, so this is the first server code every new account reaches.
 *
 * Fail-soft: unauthenticated → 401 no-op; analytics must never break the UI.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ tracked: false }, { status: 401 })

  const cookieStore = await cookies()
  const alreadyTracked = cookieStore.get(AUTH_EVENT_COOKIE)?.value === '1'
  const authEvent = trackAuthSession(user, { alreadyTracked })

  // Count genuine sign-ins so first-run surfaces can hold off until the user
  // has been here a few times (see SIGN_IN_COUNT_METADATA_KEY). Keyed off
  // `alreadyTracked` — the same once-per-sign-in cookie dedup the analytics
  // event uses — and NOT off `authEvent`, which is null whenever PostHog is
  // unconfigured (e.g. local dev), where the counter must still advance.
  if (!alreadyTracked) {
    const current = user.user_metadata?.[SIGN_IN_COUNT_METADATA_KEY]
    const count = typeof current === 'number' && Number.isFinite(current) ? current : 0
    // Stop incrementing once past the threshold: this writes to the auth user
    // on every sign-in, and an unbounded counter is churn for no added signal.
    if (count <= SIGN_IN_COUNT_CEILING) {
      // Fail-soft, like the analytics it rides along with — a nudge-gating
      // counter must never break the sign-in it is observing.
      await supabase.auth
        .updateUser({ data: { [SIGN_IN_COUNT_METADATA_KEY]: count + 1 } })
        .catch(() => {})
    }
  }

  // Persona-edition attribution. Rides on this route because it is already the
  // one surface every auth method reaches (password signups never touch
  // /auth/callback) and, as a Route Handler, the one place the cookie can
  // legally be expired.
  //
  // GATED ON SIGNUP. This route runs on EVERY ping from EVERY authenticated
  // user, and the workspace it resolves is whichever one is currently selected
  // — for a returning customer, a long-lived workspace full of their data.
  // Without this flag, an existing customer who clicked a /sales CTA (which
  // sets the cookie) and then signed IN would have that workspace silently
  // converted. First-write-wins does not save them: every workspace created
  // before editions shipped is unstamped. `isFreshSignupUser` is the same
  // account-age question `trackAuthSession` asks to pick signup-vs-login, so
  // the two can never disagree; attribution then re-checks the WORKSPACE's own
  // age as an independent belt (see lib/editions/attribution.ts).
  //
  // Best-effort: it cannot throw, and its failure is invisible to the user
  // beyond the workspace staying on the `full` default.
  const isNewSignup = isFreshSignupUser(user)
  const editionAttribution = await consumeSignupEdition(
    cookieStore.get(SIGNUP_EDITION_COOKIE)?.value,
    await getCurrentWorkspaceIdSafe(),
    user.id,
    { isNewSignup },
  )

  // Every workspace starts with Triage, the post-call filter that keeps only
  // the user's own commitments, even when its owner never reaches onboarding.
  // Only inside the signup window (a returning user's ping skips it), and on
  // every ping in that window: seeding is idempotent, so a failed attempt is
  // retried by the next ping. Best-effort, like everything else here.
  if (isNewSignup) {
    try {
      await seedSignupLoops(getServiceClient(), { userId: user.id })
    } catch (err) {
      console.error('[auth-session] seed-signup-loops failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Auto-join by email domain (src/lib/workspace-join/domain-join.ts), once
  // per sign-in. The OAuth and magic-link callbacks already ran it; this is
  // how a password or desktop sign-in, finished in the browser, reaches it.
  // When it lands a brand-new account in its team's workspace it sets the
  // workspace cookie, and `switchedWorkspace` tells the pinger to reload.
  const domainJoin = alreadyTracked ? null : await joinByEmailDomainAtSignIn(user)
  const switchedWorkspace = domainJoin?.joined && domainJoin.activated ? domainJoin.workspaceId : null

  const res = NextResponse.json({ tracked: Boolean(authEvent), ...(switchedWorkspace ? { switchedWorkspace } : {}) })
  if (editionAttribution.shouldClear) {
    res.cookies.set(SIGNUP_EDITION_COOKIE, '', { path: '/', maxAge: 0 })
  }
  if (authEvent) {
    // Legal here (Route Handler). Set on the response so the Set-Cookie header
    // rides on the response the client just awaited. ~Supabase access-token
    // lifetime: the next genuinely-fresh sign-in re-fires after it expires.
    res.cookies.set(AUTH_EVENT_COOKIE, authEvent.cookieValue, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60,
    })
  }
  return res
}
