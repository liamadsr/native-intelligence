/**
 * Signup attribution — carrying "which landing page did this person come from"
 * across the auth round-trip and into the workspace they end up owning.
 *
 * The flow:
 *
 *   /login?mode=signup&edition=sales   (login-form.tsx sets the cookie)
 *        ↓  any auth method — OAuth, password, magic link
 *   POST /api/analytics/auth-session   (consumeSignupEdition stamps + expires)
 *        ↓
 *   workspace.settings.edition = 'sales'
 *
 * WHY the consumption sits on the auth-session route rather than
 * /auth/callback: the callback is OAuth-only. A password signup calls
 * `signInWithPassword` and navigates straight to /account, never touching it —
 * so a cookie consumed there would silently miss every non-OAuth signup. The
 * auth-session route is the choke-point EVERY auth method reaches (it is
 * pinged on mount from the trial wall, the onboarding wizard, and the
 * dashboard shell, and it is a Route Handler, the one Next 16 context where
 * expiring the cookie is legal).
 *
 * The trial wall's ping is the one that matters for a new signup: it lands
 * seconds after the account is created, where the others wait on Checkout.
 * Every window below is one hour, so a signup who took longer than that over
 * their card would otherwise reach the next ping with the cookie expired and
 * both freshness gates closed, and land on `full`.
 *
 * ── The signup gate ──────────────────────────────────────────────────────────
 *
 * Being on the every-session choke-point is exactly what makes this dangerous.
 * The route runs on every ping from every authenticated user, and the workspace
 * it hands us is whichever one is CURRENTLY selected — which for a returning
 * customer is a long-lived workspace full of their data. An existing customer
 * who clicks a /sales CTA (which sets the cookie) and then signs IN would have
 * that workspace silently converted to the sales edition, losing navigation and
 * tool surface they were using yesterday.
 *
 * First-write-wins does NOT protect them: it only skips workspaces that already
 * carry an explicit edition, and every workspace created before this feature
 * shipped — i.e. all of them — is unstamped. So the guard has to be positive
 * proof that this is a genuinely new signup, not the absence of a prior stamp.
 *
 * Two independent signals, BOTH required (see `SignupSignal`):
 *
 *   1. `isNewSignup` — the caller's signup-vs-login classification. On the
 *      auth-session route this is the same `user.created_at` freshness test
 *      that decides `user_signed_up` vs `user_logged_in`, so attribution and
 *      the acquisition event can never disagree about what a session was. A
 *      sign-in reports false and stamps nothing, full stop.
 *
 *   2. Workspace age — the workspace row's `created_at` must be within
 *      {@link MAX_WORKSPACE_AGE_MS}. This is the belt: even if signal 1 were
 *      wrong (a clock skew, a future auth method that mis-classifies, a caller
 *      that passes the flag carelessly), a workspace older than the attribution
 *      window cannot be converted. It is the signal that directly protects the
 *      asset at risk — the customer's existing workspace — rather than
 *      inferring safety from a property of the user.
 *
 * Both windows are aligned to the cookie's own 1h life
 * (SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS): a cookie that can no longer exist
 * must not be able to stamp anything, and conversely there is no point being
 * stricter than the carrier. The looser-than-60s window is deliberate — an
 * email-confirmation signup can take minutes between account creation and the
 * first authenticated ping, and those signups deserve attribution too.
 *
 * Belt-and-braces on the OTHER side: the cookie is cleared on a sign-in even
 * though nothing was stamped, so a customer who browsed /sales before logging
 * in doesn't carry a live attribution cookie into whatever they do next.
 *
 * Everything here is best-effort. Attribution is telemetry with a side effect;
 * it must never be able to break a sign-in or block onboarding, so the whole
 * body is guarded and every failure path simply leaves the workspace on the
 * `full` default.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { trackServerEvent } from '@/lib/posthog'
import { isEditionId, stampWorkspaceEdition } from './index'
import {
  SIGNUP_EDITION_COOKIE,
  SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS,
} from './attribution-shared'

export { SIGNUP_EDITION_COOKIE, SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS }

/**
 * How new a workspace must be to be attributable, in ms. Matched to the
 * attribution cookie's own lifetime: the cookie cannot survive longer than
 * this, so a workspace older than it could only be reached by a cookie that
 * should already be gone.
 */
export const MAX_WORKSPACE_AGE_MS = SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS * 1000

/**
 * What the caller knows about the session doing the consuming.
 *
 * `isNewSignup` is the caller's own signup-vs-login verdict — on the
 * auth-session route, the same `created_at` freshness test that picks
 * `user_signed_up` over `user_logged_in`. Passing `false` (or omitting the
 * context entirely) is the safe direction: it stamps nothing.
 */
export interface SignupSignal {
  /** True only when this authenticated session is a brand-new account, not a
   *  returning login. False ⇒ never stamp. */
  isNewSignup: boolean
  /** Injectable clock for tests; defaults to Date.now(). */
  nowMs?: number
}

export interface ConsumeResult {
  /** True when settings.edition was actually written by this call. */
  stamped: boolean
  /** The edition attributed — read off the cookie, or {@link DEFAULT_SIGNUP_EDITION}
   *  when a fresh signup arrived without one. Null when there was nothing to
   *  attribute at all (junk cookie, or an absent cookie on a non-signup). */
  edition: string | null
  /** True when the cookie should be expired on the response. */
  shouldClear: boolean
  /**
   * Where {@link edition} came from, on the paths that produced one.
   * `'cookie'` = the visitor clicked an attributed CTA; `'default'` = no cookie,
   * so the signup was attributed to the only funnel we run. Mirrored onto the
   * `signup_edition_attributed` event as `source`.
   */
  source?: 'cookie' | 'default'
  /**
   * Why nothing was stamped, when the reason is a deliberate refusal rather
   * than a failed write. `'not-a-signup'` = the session was a login;
   * `'workspace-too-old'` = the workspace predates the attribution window.
   * Both mean "leave this customer's workspace alone".
   */
  skipped?: 'not-a-signup' | 'workspace-too-old'
}

/**
 * What a fresh signup with NO attribution cookie is stamped with.
 *
 * `full`, the whole app: since 2026-11-14 `/` pitches one workspace for the
 * whole company (src/app/workspace-page.tsx) and its CTAs carry no edition,
 * so a homepage signup arrives cookieless on purpose and gets the whole app.
 * The persona pitches (/meeting-notes, /company-brain) still attribute through
 * their own CTAs' cookie (see components/signup-href.tsx). A signup from a
 * page with no attributed CTA (/pricing, /docs, a direct /login link) gets
 * `full` too. It is still STAMPED rather than left unset, so analytics can
 * tell a default signup (`source: 'default'`) from an older workspace.
 *
 * (From the sales pivot until 2026-11-14 this was `sales`, when `/` was the
 * sales pitch.)
 *
 * This is ONLY a default for the cookieless case. A cookie naming a different
 * edition still wins outright, and — critically — this default is applied
 * strictly INSIDE the same two gates the cookie path passes through. It cannot
 * touch an existing workspace or a sign-in; see the module header.
 */
export const DEFAULT_SIGNUP_EDITION = 'full'

/**
 * Read the attribution cookie and, if this is a genuinely new signup whose
 * workspace hasn't been claimed yet, stamp it. Never throws.
 *
 * The stamp is FIRST-WRITE-WINS (see resolve.ts) on top of the signup gate
 * described in the module header, so this is safe to call on every session
 * ping: a returning user's workspace is refused outright, and a new signup's
 * workspace that already carries an edition is left exactly as it is.
 *
 * The caller expires the cookie whenever `shouldClear` is set. That includes
 * every refusal path: once we've decided this session isn't attributable, a
 * lingering cookie has no further job and must not follow the user into their
 * next workspace.
 */
export async function consumeSignupEdition(
  cookieValue: string | undefined,
  workspaceId: string | null,
  userId: string,
  signal: SignupSignal = { isNewSignup: false },
): Promise<ConsumeResult> {
  // A cookie that is PRESENT but not a valid edition id is junk, not a missing
  // cookie: something wrote a value we don't recognize. Attribute nothing and
  // clear it so it can't linger. Deliberately NOT defaulted — a junk value is
  // evidence of a bug, and papering over it with the default would hide that.
  if (cookieValue != null && !isEditionId(cookieValue)) {
    return { stamped: false, edition: null, shouldClear: true }
  }

  // ABSENT cookie on a genuinely new signup → the default edition (see
  // DEFAULT_SIGNUP_EDITION). Resolved here, then run through EXACTLY the same
  // gates below as a cookie-borne edition — the default buys no shortcut past
  // them, which is what keeps this from touching anyone's existing workspace.
  const source: 'cookie' | 'default' = cookieValue == null ? 'default' : 'cookie'
  const edition = cookieValue ?? DEFAULT_SIGNUP_EDITION

  // SIGN-INS NEVER STAMP. Checked before the workspace lookup so a returning
  // user's ping costs nothing, and cleared so a cookie picked up while browsing
  // an attributed CTA can't survive to ambush a workspace created later.
  //
  // This is also the gate that makes the cookieless default safe. Every
  // returning customer's ping arrives here with no cookie; without this check
  // the default would try to stamp `full` onto whatever workspace they happen
  // to have selected. `isNewSignup` is false for all of them, so they are
  // refused before the workspace is even read — and with no cookie to clear,
  // `shouldClear` costs nothing either way.
  if (!signal.isNewSignup) {
    return { stamped: false, edition, shouldClear: true, source, skipped: 'not-a-signup' }
  }

  // No workspace yet (the very first ping can land before workspace creation
  // completes). KEEP the cookie — a later ping in the same hour will find the
  // workspace and stamp it then.
  if (!workspaceId) return { stamped: false, edition, shouldClear: false, source }

  try {
    // Service client: the stamp must not depend on the caller's RLS role. The
    // workspace UPDATE policy is owner-only, and while a fresh signup IS the
    // owner of their first workspace, an invited member landing here with an
    // attribution cookie would otherwise fail the write silently.
    const service: SupabaseClient = (await import('@/lib/supabase/service')).getServiceClient()

    // The belt: refuse anything but a freshly-created workspace, whatever the
    // caller believes about the session. An unreadable/absent created_at is
    // treated as too old — refusing to attribute costs a data point, wrongly
    // converting a live workspace costs a customer their navigation.
    const { data: row, error } = await service
      .from('workspace')
      .select('created_at')
      .eq('id', workspaceId)
      .maybeSingle()
    if (error) {
      // Couldn't establish age. Keep the cookie so a later ping can retry.
      return { stamped: false, edition, shouldClear: false, source }
    }
    if (!isFreshWorkspace(row?.created_at, signal.nowMs)) {
      return {
        stamped: false,
        edition,
        shouldClear: true,
        source,
        skipped: 'workspace-too-old',
      }
    }

    const result = await stampWorkspaceEdition(service, workspaceId, edition)

    if (result.stamped) {
      // $set_once, not $set: the edition a person SIGNED UP under is a
      // permanent fact about that signup. Later switches in workspace settings
      // are a different question and must not overwrite the acquisition source
      // this property exists to answer.
      //
      // Routed through trackServerEvent (not a raw client.capture) so the event
      // carries serverDefaultProperties — platform:'web', environment — like
      // every other server event; without them it was invisible to any
      // dashboard filtered on platform.
      //
      // trackServerEvent is already fail-soft, but it sits INSIDE the try that
      // guards the stamp: without this belt a throw would escape into the outer
      // catch and report a workspace that WAS stamped as un-stamped, leaving a
      // live cookie behind. Analytics never rewrites the history of the write
      // it is observing.
      try {
        trackServerEvent(
          'signup_edition_attributed',
          { userId, workspaceId },
          {
            signup_edition: edition,
            // Which path produced the attribution. Without it the cookieless
            // default is indistinguishable from a real CTA click, and the
            // funnel's measured conversion would silently absorb every signup
            // that arrived with no cookie at all.
            source,
            $set_once: { signup_edition: edition },
          },
        )
      } catch {
        // Deliberately empty — see above.
      }
    }

    return { stamped: result.stamped, edition, shouldClear: true, source }
  } catch {
    // Leave the cookie in place so a later ping can retry the stamp.
    return { stamped: false, edition, shouldClear: false, source }
  }
}

/** Tolerance for a workspace timestamp that reads slightly in the FUTURE. The
 *  row is stamped by Postgres `now()` and compared against the app server's
 *  clock, so a few seconds of skew is normal and must not cost a real signup
 *  its attribution. Anything further ahead than this is nonsense, not skew. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000

/** True when a workspace row's created_at is inside the attribution window.
 *  Unparseable, absent, or implausibly future-dated timestamps are NOT fresh —
 *  the safe answer for a check whose whole job is protecting existing
 *  workspaces. */
function isFreshWorkspace(createdAt: unknown, nowMs?: number): boolean {
  if (typeof createdAt !== 'string') return false
  const createdMs = new Date(createdAt).getTime()
  if (!Number.isFinite(createdMs)) return false
  const age = (nowMs ?? Date.now()) - createdMs
  return age > -CLOCK_SKEW_TOLERANCE_MS && age < MAX_WORKSPACE_AGE_MS
}
