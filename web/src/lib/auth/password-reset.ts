import { appUrl } from '@/lib/app-url'
import { signInReturnUrl } from '@/lib/auth/login-redirect'

/**
 * A password reset ends where it was asked for, like every email link
 * (src/lib/auth/email-link.ts): the PKCE verifier the asking browser (or the
 * desktop app's web view) kept is what turns the link's code into a session,
 * so a link opened anywhere else does nothing.
 *
 * In a browser the link lands on /reset-password, and /auth/confirm exchanges
 * its code with that browser's verifier cookie. In the desktop app the
 * verifier is in the app's web view, but an email link always opens in the
 * system browser, so the link returns through /auth/desktop-callback like a
 * desktop sign-in: the page hands the code to the app on a dial8desktop://
 * link (with `type=recovery`), the app's web view exchanges it, and the app
 * opens /reset-password.
 */

/** Where Supabase sends a reset link back to (its `redirectTo`). */
export function passwordResetReturnUrl(where: 'desktop' | 'browser', pageOrigin: string, appAddress: string = appUrl()): string {
  return where === 'desktop' ? signInReturnUrl('desktop', pageOrigin, appAddress) : `${pageOrigin}/reset-password`
}

/** The query value that marks a reset on its way back to the desktop app:
 *  `/auth/desktop-callback?…&type=recovery`, and the same on the
 *  dial8desktop:// link that page opens. */
export const RESET_TYPE = 'recovery'

/**
 * The reset page's `?error=` for a reset code that couldn't be exchanged.
 * A missing verifier means the link was opened somewhere other than where it
 * was asked for (another browser, another computer, or a browser while the
 * reset was asked for in the app).
 */
export function resetExchangeErrorCode(error: { code?: string } | null | undefined): string {
  switch (error?.code) {
    case 'pkce_code_verifier_not_found':
      return 'opened_elsewhere'
    case 'flow_state_expired':
      return 'link_expired'
    default:
      return 'auth_failed'
  }
}

/** `/reset-password?error=` for a failed reset link. The code is reduced to a safe token. */
export function resetErrorPath(error: string): string {
  const code = /^[a-z0-9_]{1,64}$/i.test(error) ? error : 'auth_failed'
  return `/reset-password?error=${encodeURIComponent(code)}`
}

/** What went wrong with a reset link, from the reset page's `?error=`. */
export type ResetLinkProblem = 'opened_elsewhere' | 'expired' | 'failed'

export function resetLinkProblem(error: string | null | undefined): ResetLinkProblem | null {
  if (error === undefined || error === null) return null
  if (error === 'opened_elsewhere') return 'opened_elsewhere'
  if (error === 'link_expired') return 'expired'
  return 'failed'
}
