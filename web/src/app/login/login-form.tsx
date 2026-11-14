'use client'

import { Link } from '@/components/link'
import { accountRedirectTarget, isInviteRedirectPath, isJoinLinkPath, isMcpTarget, mcpRedirectTarget, resolvePostAuthRedirect, signInReturnUrl } from '@/lib/auth/login-redirect'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { isDesktopApp } from '@/lib/platform'
import { WindowDragStrip } from '@/components/desktop/window-drag-strip'
import { createClient } from '@/lib/supabase/client'
import { tauriBridge } from '@/lib/tauri-bridge'
import {
  beginDesktopTokenSignIn,
  completeDesktopSignIn,
  parseDesktopAuthCallback,
} from '@/lib/auth/desktop-sign-in'
import { isEditionId } from '@/lib/editions'
import {
  SIGNUP_EDITION_COOKIE,
  SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/editions/attribution-shared'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  WORK_EMAIL_HINT,
  WORK_EMAIL_REQUIRED_ERROR_CODE,
  WORK_EMAIL_REQUIRED_MESSAGE,
  isFreeEmailDomain,
  isWorkEmailRejection,
} from '@/lib/auth/work-email'

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  missing_code: 'Authentication failed. Please try again.',
  chatgpt_declined: 'ChatGPT sign-in was cancelled.',
  google_declined: 'Google sign-in was cancelled.',
  unverified_email:
    "Your ChatGPT account doesn't have a verified email yet. Verify it in ChatGPT, then try again.",
  email_unconfirmed:
    'This email has a Native Intelligence account that was never confirmed. Reset its password with "Forgot password?", then continue with ChatGPT.',
  account_failed: "We couldn't set up your account. Please try again.",
  link_expired: 'That link has expired or was already used. Sign in again to get a new one.',
  other_browser:
    "Open the link in the browser where you asked for it. If you were confirming your email, it's confirmed: sign in.",
  [WORK_EMAIL_REQUIRED_ERROR_CODE]: WORK_EMAIL_REQUIRED_MESSAGE,
}

type Mode = 'signin' | 'signup' | 'magic'

/** What the desktop's sign-in window says for a page it doesn't list
 *  (desktop/src-tauri/src/commands/auth_session.rs): builds before the rename say Dial8. */
// TODO(rename-compat): drop the Dial8 wording once desktop builds from before the rename are gone.
const REFUSED_SIGN_IN_PAGES = new Set(['not a Native Intelligence sign-in page', 'not a Dial8 sign-in page'])

/** The login page's OAuth buttons. */
type OAuthProvider = 'google' | 'chatgpt'

export function LoginForm({
  invitedEmail = null,
  chatGptSignIn = false,
  googleOnNi = false,
}: {
  /** Address an admin signup invite was issued for (resolved by the page). */
  invitedEmail?: string | null
  /** Show "Continue with ChatGPT" (lib/chatgpt/config, decided by the page). */
  chatGptSignIn?: boolean
  /** "Sign in with Google" runs Native Intelligence's own flow on this origin
   *  (lib/auth/google-sign-in, decided by the page); else Supabase's. */
  googleOnNi?: boolean
} = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackError = searchParams.get('error')
  const redirectPath = searchParams.get('redirect')
  // Arrived from an invite link (or an agent link's connect link). Invited addresses are exempt from the
  // work-email rule (the server hook checks for a pending invite), so the
  // form must not refuse them inline or nag them with the hint.
  // A join link (/join/<token>) names no address, so it is not exempt.
  const viaInvite =
    !!invitedEmail ||
    (!!redirectPath && isInviteRedirectPath(redirectPath) && !isJoinLinkPath(redirectPath))
  const editionParam = searchParams.get('edition')
  // A refused signup (work-email hook) should land back on the SIGNUP form
  // so the message reads as feedback on what they just tried, not a sign-in.
  const initialMode: Mode =
    searchParams.get('mode') === 'signup' ||
    callbackError === WORK_EMAIL_REQUIRED_ERROR_CODE ||
    !!invitedEmail
      ? 'signup'
      : 'signin'

  const [mode, setMode] = useState<Mode>(initialMode)
  const [error, setError] = useState(
    callbackError ? (ERROR_MESSAGES[callbackError] ?? 'An error occurred.') : '',
  )
  const [success, setSuccess] = useState('')
  // The OAuth button whose sign-in is under way; all of them wait meanwhile.
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null)
  const [emailLoading, setEmailLoading] = useState(false)
  const [email, setEmail] = useState(invitedEmail ?? '')
  const [password, setPassword] = useState('')
  const [isDesktop, setIsDesktop] = useState(false)
  // False in the SSR HTML, true only once React has hydrated and attached
  // the form's onSubmit. E2E waits on the resulting data-hydrated attribute:
  // the inputs and the submit button are interactive-looking in the server
  // markup, so a click landing before hydration silently does nothing.
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  useEffect(() => {
    setIsDesktop(isDesktopApp())
  }, [])

  // A Google signup refused by the work-email hook (see lib/auth/work-email)
  // normally lands on /auth/callback?error=... and is mapped to
  // `?error=work_email_required` there. Supabase can also carry auth errors
  // in the URL FRAGMENT, which no server route ever sees but which browsers
  // preserve across the redirect to /login — so read it here too.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash || hash.length < 2) return
    const params = new URLSearchParams(hash.slice(1))
    const description = params.get('error_description')
    if (!params.get('error') || !isWorkEmailRejection(description)) return
    setError(WORK_EMAIL_REQUIRED_MESSAGE)
    setMode('signup')
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])

  // Set redirect cookie for post-login navigation
  useEffect(() => {
    if (!redirectPath) return

    const securePart = window.location.protocol === 'https:' ? ';secure' : ''
    if (isInviteRedirectPath(redirectPath)) {
      document.cookie = `invite_redirect=${encodeURIComponent(redirectPath)};path=/;max-age=600;samesite=lax${securePart}`
    } else if ((redirectPath.startsWith('/s/') || redirectPath.startsWith('/mail/s/')) && !redirectPath.includes('//')) {
      // Share-link redirect (a shared page, or an email share link) — back to it after auth
      document.cookie = `share_redirect=${encodeURIComponent(redirectPath)};path=/;max-age=600;samesite=lax${securePart}`
    } else if (accountRedirectTarget(redirectPath)) {
      // A page of the app and its deep link (the Studio export the desktop app sent the person to download here):
      // back there after an OAuth sign-in too.
      document.cookie = `account_redirect=${encodeURIComponent(accountRedirectTarget(redirectPath)!)};path=/;max-age=600;samesite=lax${securePart}`
    } else {
      // MCP OAuth flow — back to the authorize endpoint after login (this
      // origin's only: src/lib/auth/login-redirect.ts)
      const mcpTarget = mcpRedirectTarget(redirectPath, window.location.origin)
      if (mcpTarget) {
        document.cookie = `mcp_redirect=${encodeURIComponent(mcpTarget)};path=/;max-age=600;samesite=lax${securePart}`
      }
    }
  }, [redirectPath])

  // Persona-edition attribution (`/login?mode=signup&edition=sales`). The
  // landing page the user came from decides which edition their first workspace
  // gets; this cookie is how that intent survives the auth round-trip. It is
  // CONSUMED once, server-side, at onboarding — deliberately not at
  // /auth/callback, which only OAuth sign-ins reach (password signups navigate
  // straight to /account), whereas every auth method passes through onboarding.
  //
  // GATED ON SIGN-IN INTENT. `?edition=` arrives on every CTA from a persona
  // landing page, including ones an EXISTING customer clicks — and this form
  // opens in signin mode unless `?mode=signup` says otherwise. Writing the
  // cookie regardless of mode meant a returning customer carried a live
  // attribution cookie into their session. The server refuses to stamp a
  // sign-in anyway (lib/editions/attribution.ts), so this is defense in depth:
  // the cookie shouldn't exist when the person is explicitly signing IN.
  // Toggling to "Sign in" clears it; toggling back re-writes it, so the cookie
  // always matches the form the user is actually looking at.
  //
  // MAGIC LINK KEEPS THE COOKIE. It is the one mode that is genuinely
  // ambiguous — "email me a link" is how plenty of people SIGN UP, and a magic-
  // link signup started from a persona CTA is legitimate attribution that
  // clearing the cookie would throw away. Only `signin` is an explicit "I
  // already have an account" statement. Keeping it for `magic` is safe because
  // the server never stamps on the cookie alone: attribution.ts requires BOTH
  // the caller's isNewSignup verdict AND a workspace younger than
  // MAX_WORKSPACE_AGE_MS, so a magic-link SIGN-IN carrying the cookie still
  // stamps nothing.
  //
  // Only a REAL edition id is cookied. `normalizeEditionId` would happily turn
  // `?edition=hunter2` into 'full', but writing that would record a garbage
  // param as a deliberate choice — and 'full' is already what an unstamped
  // workspace resolves to, so the cookie would say nothing while looking like
  // attribution. Unknown values are simply ignored.
  useEffect(() => {
    if (!isEditionId(editionParam)) return
    const securePart = window.location.protocol === 'https:' ? ';secure' : ''
    if (mode === 'signin') {
      // Expire rather than skip: the user may have arrived in signup mode
      // (cookie written) and then switched to signin.
      document.cookie = `${SIGNUP_EDITION_COOKIE}=;path=/;max-age=0;samesite=lax${securePart}`
      return
    }
    document.cookie = `${SIGNUP_EDITION_COOKIE}=${encodeURIComponent(editionParam)};path=/;max-age=${SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS};samesite=lax${securePart}`
  }, [editionParam, mode])

  function switchMode(next: Mode) {
    setMode(next)
    setError('')
    setSuccess('')
    setPassword('')
  }

  /**
   * Desktop OAuth sign-in (Google, ChatGPT). The desktop runs it in a web
   * authentication session (a sign-in sheet over this window) and hands back
   * the dial8desktop:// callback URL, finished here exactly as DeepLinkHandler
   * finishes a callback deep link. A build without the session opens the page
   * in the system browser instead (the callback then returns as a deep link).
   * `onRefused` runs instead when the build's sign-in window doesn't list the
   * page (a build older than the page).
   */
  async function desktopOAuthSignIn(
    authorizeUrl: string,
    supabase: ReturnType<typeof createClient>,
    onRefused?: () => Promise<void>,
  ) {
    let session: Awaited<ReturnType<typeof tauriBridge.authWebSession>>
    try {
      session = await tauriBridge.authWebSession(authorizeUrl)
    } catch (err) {
      if (onRefused && err instanceof Error && REFUSED_SIGN_IN_PAGES.has(err.message)) {
        await onRefused()
        return
      }
      console.error('[login] sign-in window failed:', err)
      setError('Could not open the sign-in window. Please try again.')
      setOauthLoading(null)
      return
    }
    if (session.kind === 'cancelled') {
      setOauthLoading(null)
      return
    }
    if (session.kind === 'unavailable') {
      await openSignInInBrowser(authorizeUrl)
      return
    }
    const callback = parseDesktopAuthCallback(session.url)
    const outcome = callback
      ? await completeDesktopSignIn(callback, supabase)
      : ({ ok: false, error: 'auth_failed', description: null } as const)
    if (outcome.ok) {
      // This sign-in ends on /account: a deep link left for an OAuth sign-in in a browser is not this one's.
      document.cookie = 'account_redirect=;path=/;max-age=0'
      // Keep the button busy through the navigation.
      router.push('/account')
      return
    }
    setError(ERROR_MESSAGES[outcome.error] ?? outcome.description ?? 'An error occurred.')
    setOauthLoading(null)
  }

  /**
   * A desktop build without the sign-in session: open the page in the system
   * browser (as before the session existed); the callback then comes back as
   * a dial8desktop:// deep link.
   */
  async function openSignInInBrowser(authorizeUrl: string) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(authorizeUrl)
      setSuccess('Completing sign-in in your browser...')
    } catch (err) {
      console.error('[login] could not open the sign-in page:', err)
      setError('Could not open your browser to sign in. Please try again.')
    }
    setOauthLoading(null)
  }

  /**
   * "Sign in with Google". With `googleOnNi` it runs Native Intelligence's own flow
   * (/auth/google), so the person never sees the Supabase project's URL: the
   * web navigates to it; the desktop runs it in the sign-in sheet, which ends
   * on a dial8desktop:// deep link carrying a one-time token bound to this
   * `bind`. Otherwise it runs Supabase's flow.
   */
  async function handleGoogleSignIn() {
    setError('')
    setSuccess('')
    setOauthLoading('google')

    if (googleOnNi && isDesktop) {
      const bind = beginDesktopTokenSignIn()
      // A desktop build from before /auth/google refuses it in the sign-in
      // window: run Supabase's flow there. REMOVE once every build lists it.
      await desktopOAuthSignIn(
        `${window.location.origin}/auth/google?desktop=1&bind=${bind}`,
        createClient(),
        supabaseDesktopGoogleSignIn,
      )
    } else if (googleOnNi) {
      window.location.assign('/auth/google')
    } else if (isDesktop) {
      await supabaseDesktopGoogleSignIn()
    } else {
      const supabase = createClient()
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: signInReturnUrl('browser', window.location.origin),
        },
      })

      if (oauthError) {
        setError(oauthError.message)
        setOauthLoading(null)
      }
    }
  }

  /** Supabase's Google flow on the desktop: the desktop-callback route ends
   *  it on a dial8desktop:// URL carrying a PKCE code. */
  async function supabaseDesktopGoogleSignIn() {
    const supabase = createClient()
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: signInReturnUrl('desktop', window.location.origin),
        skipBrowserRedirect: true,
      },
    })

    if (oauthError) {
      setError(oauthError.message)
      setOauthLoading(null)
      return
    }

    if (data.url) await desktopOAuthSignIn(data.url, supabase)
    else setOauthLoading(null)
  }

  /**
   * "Continue with ChatGPT" runs Native Intelligence's own OAuth flow (/auth/chatgpt), one
   * consent for sign-in and ChatGPT plan usage. The web navigates to it; the
   * desktop runs it in the sign-in sheet, which ends on a dial8desktop://
   * deep link carrying a one-time token bound to this `bind`.
   */
  async function handleChatGptSignIn() {
    setError('')
    setSuccess('')
    setOauthLoading('chatgpt')

    if (isDesktop) {
      const bind = beginDesktopTokenSignIn()
      await desktopOAuthSignIn(
        `${window.location.origin}/auth/chatgpt?desktop=1&bind=${bind}`,
        createClient(),
      )
    } else {
      window.location.assign('/auth/chatgpt')
    }
  }

  const oauthBusyLabel = isDesktop ? 'Signing in...' : 'Redirecting...'

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) return

    setError('')
    setSuccess('')
    setEmailLoading(true)

    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setEmailLoading(false)
      return
    }

    const target = resolvePostAuthRedirect(redirectPath, window.location.origin)
    // Used here: an OAuth sign-in later must not find it.
    document.cookie = 'account_redirect=;path=/;max-age=0'
    // The MCP authorize step is an API route: a full page load, not the
    // client router, and its cookie is spent.
    if (isMcpTarget(target)) {
      document.cookie = 'mcp_redirect=;path=/;max-age=0'
      window.location.assign(target)
      return
    }
    router.replace(target)
    router.refresh()
  }

  async function handlePasswordSignUp(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) return

    // Inline pre-check only — the server hook is the gate that counts, and
    // it is also what lets an invited personal address through.
    if (!viaInvite && isFreeEmailDomain(email)) {
      setError(WORK_EMAIL_REQUIRED_MESSAGE)
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setError('')
    setSuccess('')
    setEmailLoading(true)


    const supabase = createClient()
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: signInReturnUrl(isDesktop ? 'desktop' : 'browser', window.location.origin),
      },
    })

    if (signUpError) {
      setError(
        isWorkEmailRejection(signUpError.message)
          ? WORK_EMAIL_REQUIRED_MESSAGE
          : signUpError.message,
      )
      setEmailLoading(false)
      return
    }

    // If email confirmation is required, the user is returned without a session.
    if (!data.session) {
      setSuccess(
        'Account created. Check your email for a confirmation link to finish signing in.',
      )
      setEmailLoading(false)
      return
    }

    const target = resolvePostAuthRedirect(redirectPath, window.location.origin)
    // Used here: an OAuth sign-in later must not find it.
    document.cookie = 'account_redirect=;path=/;max-age=0'
    // The MCP authorize step is an API route: a full page load, not the
    // client router, and its cookie is spent.
    if (isMcpTarget(target)) {
      document.cookie = 'mcp_redirect=;path=/;max-age=0'
      window.location.assign(target)
      return
    }
    router.replace(target)
    router.refresh()
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return

    setError('')
    setSuccess('')
    setEmailLoading(true)


    const supabase = createClient()
    const { error: magicLinkError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: signInReturnUrl(isDesktop ? 'desktop' : 'browser', window.location.origin),
      },
    })

    if (magicLinkError) {
      setError(
        isWorkEmailRejection(magicLinkError.message)
          ? WORK_EMAIL_REQUIRED_MESSAGE
          : magicLinkError.message,
      )
    } else {
      setSuccess(
        isDesktop
          ? 'Check your email for a sign-in link. It will open in your browser and sign you in here.'
          : 'Check your email for a sign-in link.',
      )
    }
    setEmailLoading(false)
  }

  const isPasswordMode = mode === 'signin' || mode === 'signup'
  const submitHandler =
    mode === 'signin'
      ? handlePasswordSignIn
      : mode === 'signup'
        ? handlePasswordSignUp
        : handleMagicLink

  const submitLabel = emailLoading
    ? mode === 'magic'
      ? 'Sending...'
      : mode === 'signup'
        ? 'Creating account...'
        : 'Signing in...'
    : mode === 'magic'
      ? 'Send magic link'
      : mode === 'signup'
        ? 'Create account'
        : 'Sign in'

  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      {/* Desktop: the sign-in window has no header, so without this the whole
          Overlay-titlebar window is undraggable. */}
      <WindowDragStrip className="fixed inset-x-0 top-0 bottom-auto h-11" />
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center">
            <Link href="/" title="Home">
              <Logo className="h-9" />
            </Link>
          </div>
          <CardTitle className="mt-4">
            {mode === 'signup' ? 'Create your account' : 'Sign In'}
          </CardTitle>
          <CardDescription>
            {mode === 'signup'
              ? 'Sign up for Native Intelligence to start capturing your meetings and tracking action items.'
              : 'Sign in to your Native Intelligence account to view your action items.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {invitedEmail && mode === 'signup' && (
            <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
              You&apos;ve been invited to Native Intelligence. Create your account with{' '}
              <span className="font-medium text-foreground">{invitedEmail}</span> below.
            </div>
          )}
          {error && (
            <div
              role="alert"
              data-testid="auth-error"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400"
            >
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-400">
              {success}
            </div>
          )}

          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={oauthLoading !== null}
              onClick={handleGoogleSignIn}
            >
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              {oauthLoading === 'google' ? oauthBusyLabel : 'Sign in with Google'}
            </Button>

            {chatGptSignIn && (
              // OpenAI's approved format: "Continue with ChatGPT" with the
              // ChatGPT mark, black-on-white or white-on-black. The outline
              // button is exactly that in light and dark, at Google's weight
              // (OpenAI asks for comparable prominence, not more).
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={oauthLoading !== null}
                onClick={handleChatGptSignIn}
              >
                <ChatGptLogo className="mr-2 h-4 w-4" />
                {oauthLoading === 'chatgpt' ? oauthBusyLabel : 'Continue with ChatGPT'}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>

          <form
            onSubmit={submitHandler}
            data-hydrated={hydrated ? 'true' : undefined}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder={mode === 'signup' && !viaInvite ? 'you@company.com' : 'you@example.com'}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              {mode === 'signup' && !viaInvite && (
                <p className="text-xs text-muted-foreground">{WORK_EMAIL_HINT}</p>
              )}
            </div>

            {isPasswordMode && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === 'signin' && (
                    <Link
                      href="/forgot-password"
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Forgot password?
                    </Link>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete={
                    mode === 'signup' ? 'new-password' : 'current-password'
                  }
                  placeholder={
                    mode === 'signup' ? 'At least 8 characters' : 'Your password'
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={mode === 'signup' ? 8 : undefined}
                  required
                />
              </div>
            )}

            <Button type="submit" className="w-full" disabled={emailLoading}>
              {submitLabel}
            </Button>
          </form>

          <div className="space-y-2 text-center text-sm text-muted-foreground">
            {mode === 'signin' && (
              <>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => switchMode('magic')}
                >
                  Email me a magic link instead
                </button>
                <p>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => switchMode('signup')}
                  >
                    Sign up
                  </button>
                </p>
              </>
            )}
            {mode === 'signup' && (
              <p>
                Already have an account?{' '}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => switchMode('signin')}
                >
                  Sign in
                </button>
              </p>
            )}
            {mode === 'magic' && (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => switchMode('signin')}
              >
                Sign in with a password instead
              </button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** The ChatGPT mark from OpenAI's Sign in with ChatGPT button assets
 *  (developers.openai.com/assets/siwc/sign-in-buttons/chatgpt-logo-*.svg).
 *  Its black and white files are this path; currentColor picks between them. */
function ChatGptLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 21 21" fill="none" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.8102 19.1625C11.2327 19.1625 10.6841 19.0528 10.1643 18.8334C9.64459 18.6139 9.18259 18.3078 8.77834 17.9151C8.33944 18.0653 7.88322 18.1404 7.40967 18.1404C6.63582 18.1404 5.91972 17.9498 5.26137 17.5686C4.60302 17.1875 4.07172 16.6677 3.66747 16.0094C3.27477 15.351 3.07842 14.6176 3.07842 13.8091C3.07842 13.4742 3.12462 13.1103 3.21702 12.7176C2.75502 12.2903 2.39697 11.7994 2.14287 11.245C1.88877 10.679 1.76172 10.09 1.76172 9.47785C1.76172 8.85415 1.89454 8.25355 2.16019 7.67605C2.42584 7.09855 2.79544 6.6019 3.26899 6.1861C3.75409 5.75875 4.31427 5.46422 4.94952 5.30252C5.07657 4.64417 5.34222 4.05512 5.74647 3.53537C6.16227 3.00407 6.67047 2.58827 7.27107 2.28797C7.87167 1.98767 8.51269 1.83752 9.19414 1.83752C9.77164 1.83752 10.3203 1.94725 10.84 2.1667C11.3598 2.38615 11.8218 2.69222 12.226 3.08492C12.6649 2.93477 13.1211 2.8597 13.5947 2.8597C14.3685 2.8597 15.0846 3.05027 15.743 3.43142C16.4013 3.81257 16.9269 4.33232 17.3196 4.99067C17.7238 5.64902 17.9259 6.38245 17.9259 7.19095C17.9259 7.5259 17.8797 7.88973 17.7873 8.28242C18.2493 8.70977 18.6074 9.20643 18.8615 9.77238C19.1156 10.3268 19.2426 10.91 19.2426 11.5222C19.2426 12.1459 19.1098 12.7465 18.8442 13.324C18.5785 13.9015 18.2031 14.4039 17.718 14.8313C17.2445 15.2471 16.6901 15.5358 16.0548 15.6975C15.9278 16.3559 15.6564 16.9449 15.2406 17.4647C14.8363 17.996 14.3339 18.4118 13.7333 18.7121C13.1327 19.0124 12.4917 19.1625 11.8102 19.1625ZM7.53094 16.9969C8.10844 16.9969 8.61087 16.8756 9.03822 16.6331L12.2953 14.762C12.4108 14.6811 12.4686 14.5714 12.4686 14.4328V12.9429L8.27592 15.351C8.02182 15.5012 7.76772 15.5012 7.51362 15.351L4.23919 13.4626C4.23919 13.4973 4.23342 13.5377 4.22187 13.5839C4.22187 13.6301 4.22187 13.6994 4.22187 13.7918C4.22187 14.3808 4.36047 14.9237 4.63767 15.4203C4.92642 15.9054 5.32489 16.2866 5.83309 16.5638C6.34129 16.8525 6.90724 16.9969 7.53094 16.9969ZM7.70419 14.1729C7.77349 14.2076 7.83702 14.2249 7.89477 14.2249C7.95252 14.2249 8.01027 14.2076 8.06802 14.1729L9.36739 13.4279L5.19207 11.0024C4.93797 10.8523 4.81092 10.6271 4.81092 10.3268V6.56725C4.23342 6.82135 3.77142 7.21405 3.42492 7.74535C3.07842 8.2651 2.90517 8.8426 2.90517 9.47785C2.90517 10.0438 3.04954 10.5866 3.33829 11.1064C3.62704 11.6261 4.00242 12.0189 4.46442 12.2845L7.70419 14.1729ZM11.8102 18.0191C12.4224 18.0191 12.9768 17.8805 13.4734 17.6033C13.9701 17.3261 14.3628 16.9449 14.6515 16.4598C14.9403 15.9747 15.0846 15.4319 15.0846 14.8313V11.0891C15.0846 10.9505 15.0269 10.8465 14.9114 10.7772L13.5947 10.0149V14.8486C13.5947 15.1489 13.4676 15.3741 13.2135 15.5243L9.93912 17.4127C10.5051 17.817 11.1288 18.0191 11.8102 18.0191ZM12.4686 11.6781V9.32192L10.5108 8.21312L8.53579 9.32192V11.6781L10.5108 12.7869L12.4686 11.6781ZM7.40967 6.15145C7.40967 5.85115 7.53672 5.62592 7.79082 5.47577L11.0652 3.58735C10.4993 3.1831 9.87559 2.98097 9.19414 2.98097C8.58199 2.98097 8.02759 3.11957 7.53094 3.39677C7.03429 3.67397 6.64159 4.05512 6.35284 4.54022C6.07564 5.02532 5.93704 5.56817 5.93704 6.16878V9.89365C5.93704 10.0323 5.99479 10.142 6.11029 10.2228L7.40967 10.9851V6.15145ZM16.2108 14.4328C16.7883 14.1787 17.2445 13.786 17.5794 13.2547C17.9259 12.7234 18.0992 12.1459 18.0992 11.5222C18.0992 10.9562 17.9548 10.4134 17.6661 9.89365C17.3773 9.3739 17.0019 8.9812 16.5399 8.71555L13.3002 6.84445C13.2309 6.79825 13.1673 6.78092 13.1096 6.79248C13.0518 6.79248 12.9941 6.8098 12.9363 6.84445L11.637 7.5721L15.8296 10.0149C15.9567 10.0842 16.0491 10.1766 16.1068 10.2921C16.1761 10.3961 16.2108 10.5231 16.2108 10.6733V14.4328ZM12.7284 5.6317C12.9825 5.47 13.2366 5.47 13.4907 5.6317L16.7825 7.55477C16.7825 7.47393 16.7825 7.36997 16.7825 7.24292C16.7825 6.68852 16.6439 6.163 16.3667 5.66635C16.101 5.15815 15.7141 4.7539 15.2059 4.4536C14.7093 4.1533 14.1318 4.00315 13.4734 4.00315C12.8959 4.00315 12.3935 4.12442 11.9661 4.36697L8.70904 6.23808C8.59354 6.31892 8.53579 6.42865 8.53579 6.56725V8.0572L12.7284 5.6317Z"
      />
    </svg>
  )
}
