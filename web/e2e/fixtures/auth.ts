/**
 * Shared auth helpers for E2E journey tests.
 *
 * Pattern: each journey either drives the login form itself (when testing
 * the auth flow directly — J1, J9) or uses `storageState` from
 * `global-setup.ts` (faster, for journeys that aren't testing auth).
 *
 * The seeded users below must exist in the dev Supabase before tests run.
 * Set the credentials as GitHub Secrets:
 *
 *   E2E_USER_ALICE_EMAIL    — workspace owner with at least one team
 *   E2E_USER_ALICE_PASSWORD
 *
 * Alice must also hold an active `subscriptions` row (a complimentary
 * `granted_e2e_…` row is fine): since migration 243 there is no free tier, and
 * an account without a trialing/active seat is redirected from /account to
 * the trial wall at /account/start-trial, which no journey expects.
 *
 * Set them in the environment, then `npx playwright test`.
 */
import { expect, type Page, type BrowserContext } from '@playwright/test'

export interface TestUser {
  email: string
  password: string
}

/**
 * Read a seeded test user from env vars. Tests should call this once at the
 * top and skip gracefully if credentials aren't provided — that way the
 * suite remains green when run by someone who hasn't pulled the secrets.
 */
export function readTestUser(name: 'alice' = 'alice'): TestUser | null {
  const email = process.env[`E2E_USER_${name.toUpperCase()}_EMAIL`]
  const password = process.env[`E2E_USER_${name.toUpperCase()}_PASSWORD`]
  if (!email || !password) return null
  return { email, password }
}

/**
 * Drive the password sign-in form. Asserts navigation to /account on success.
 *
 * Uses CSS selectors (`input[type="email"]`) rather than `getByLabel('Email')`
 * because the Radix/shadcn Label wrapping isn't always associated cleanly,
 * and the type-based selectors survive copy changes to "Email Address" etc.
 */
export async function signInWithPassword(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login')

  const emailInput = page.locator('input[type="email"]')
  const passwordInput = page.locator('input[type="password"]')
  // Target the form submit button specifically. There are two "Sign in" buttons
  // on the page — one for Google OAuth (type=button) and the password submit
  // (type=submit). Match the submit one.
  const submit = page.locator('button[type="submit"]')

  // /login is server-rendered and hydrated. The inputs paint (and accept
  // fill()) before React attaches onSubmit, so a click that wins the race
  // against hydration does NOTHING: no request, no error, no navigation — the
  // page just sits on /login until the assertion times out. That was this
  // fixture's flake, and its signature in CI is a 15s timeout whose call log
  // is entirely "unexpected value .../login" with no intermediate URL.
  //
  // The form carries data-hydrated only after React's mount effect runs, so
  // this is a real handshake. Note the submit button is NOT a usable signal:
  // `emailLoading` starts false, so it is already enabled in the server HTML.
  await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({
    timeout: 15000,
  })

  await emailInput.fill(user.email)
  await passwordInput.fill(user.password)
  await submit.click()

  // The handler calls router.replace() — a CLIENT-side soft navigation, which
  // can be dropped if it fires while the router is still settling. Rather than
  // assume one click lands, poll: if we are still on /login with the button
  // interactive again and no error surfaced, the click was a no-op, so retry.
  //
  // A credential/server error is NOT retried — it renders in the form's error
  // region, and re-submitting bad credentials just burns the timeout (and can
  // trip Supabase rate limiting). Surface it immediately instead.
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (/\/account/.test(page.url())) return

    const authError = await readVisibleAuthError(page)
    if (authError) {
      throw new Error(`sign-in rejected for ${user.email}: ${authError}`)
    }

    // Give this attempt a window to navigate before judging it a no-op.
    try {
      await page.waitForURL(/\/account/, { timeout: 5000 })
      return
    } catch {
      // Still on /login. Re-click only when the form is idle and interactive
      // again — a disabled button means a sign-in is genuinely in flight.
      if (await submit.isEnabled().catch(() => false)) {
        await submit.click().catch(() => {})
      }
    }
  }

  const finalError = await readVisibleAuthError(page)
  throw new Error(
    `sign-in never reached /account (still ${page.url()})` +
      (finalError ? `; form error: ${finalError}` : '; no error shown on the form'),
  )
}

/**
 * The sign-in form's visible error text, or null. Used to fail fast on real
 * credential/config problems instead of retrying them — and to put the actual
 * message in the failure, which a bare toHaveURL timeout never showed.
 */
async function readVisibleAuthError(page: Page): Promise<string | null> {
  const banner = page.locator('[role="alert"], [data-testid="auth-error"]').first()
  if (!(await banner.isVisible().catch(() => false))) return null
  const text = (await banner.textContent().catch(() => null))?.trim()
  return text ? text : null
}

/**
 * Trigger sign-out by hitting the GET /sign-out endpoint directly.
 * This avoids depending on the icon-rail UI location, which changes often.
 * The endpoint clears the Supabase session cookie and redirects to /login.
 */
export async function signOut(page: Page): Promise<void> {
  // The dashboard keeps doing client-side router work right after sign-in
  // (hydration, workspace/state replaces); a goto() that races one of those
  // is aborted by the browser (net::ERR_ABORTED). Settle the page first and
  // retry once — the endpoint itself is a plain 307 to /login.
  //
  // Both gotos swallow errors: the first attempt's GET can land server-side
  // (session already revoked) even though the navigation aborts, after which
  // the dashboard's own 401 handling redirects to /login and *interrupts*
  // the retry goto. Ending up on /login is the success condition either way,
  // so the URL assertion below is the real check.
  await page.waitForLoadState('load').catch(() => {})
  try {
    await page.goto('/sign-out')
  } catch {
    await page.goto('/sign-out').catch(() => {})
  }
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
}

/**
 * Serialize the browser context's cookies into a `Cookie:` header so an
 * authenticated `request` context can call our API routes. Use this when
 * a journey drives the API directly rather than the UI — much faster and
 * less flaky than clicking through forms.
 *
 * Pattern:
 *   await signInWithPassword(page, user)
 *   const cookie = await cookieHeader(page.context())
 *   await request.post('/api/account/actions', { headers: { cookie }, data: {...} })
 */
export async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}
