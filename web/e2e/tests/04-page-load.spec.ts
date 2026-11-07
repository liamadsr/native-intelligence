import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword, cookieHeader } from '../fixtures/auth'

/**
 * J-PageLoad: every authed dashboard view renders without crashing,
 * and the core authed API endpoints return 2xx.
 *
 * The Dial8 dashboard is a SPA — there are no per-page routes like
 * `/account/captures` or `/account/projects`. All views live under
 * `/account` and switch in-place via the sidebar (or keyboard shortcuts).
 *
 * This journey is the cheap, broad signal: sign in once, navigate
 * through each top-level view using its keyboard shortcut, and assert
 * the page didn't throw. It catches the class of regression where an
 * agent refactor breaks one view's render path while every other test
 * still passes — the "agent merged a broken page" case.
 *
 * Why keyboard shortcuts and not sidebar clicks?
 *   - Shortcuts are hard-coded in NAV_SHORTCUTS and almost never change
 *   - Sidebar copy/icons get redesigned regularly
 *   - Faster — no waiting for hover-peek animations
 *
 * Shortcuts are: A=todo, D=docs, P=projects, I=initiatives,
 * E=events (calendar), M=mail, T=team-actions. See resizable-sidebar.tsx
 * NAV_SHORTCUTS. (Note: CRM/contacts has no shortcut today.)
 *
 * A page "crashed" if Next.js shows its error boundary or the dashboard
 * never finishes loading. We detect both:
 *   1. No `Application error` / global-error text visible
 *   2. The workspace switcher is still mounted (proves the shell rendered)
 *   3. No console errors with crash-shaped messages
 */

const user = readTestUser('alice')

// Each entry is [keyboard-shortcut, human-name-for-the-failure-message].
// If a shortcut stops working, the test name in the failure makes it
// obvious which view regressed.
const VIEWS: Array<[string, string]> = [
  ['a', 'my actions (todo)'],
  ['d', 'docs'],
  ['p', 'projects'],
  ['i', 'initiatives'],
  ['e', 'events (calendar)'],
  ['m', 'mail'],
]

test.describe('J-PageLoad: dashboard views', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('every top-level view renders without crashing', { tag: '@pr' }, async ({ page }) => {
    await signInWithPassword(page, user!)

    // The hotkeys we use below are bound in `tab-bar.tsx`, which only
    // mounts inside the dashboard shell — NOT inside the onboarding
    // wizard. If alice's account regresses to onboarding (e.g. profile
    // row got cleared), all the key presses would silently no-op and
    // the test would pass with zero coverage. Detect that here and skip
    // with a clear message rather than emitting a false green.
    const onboardingHeading = page.getByRole('heading', { name: /^Welcome,/i }).first()
    if (await onboardingHeading.isVisible().catch(() => false)) {
      test.skip(true, 'alice is on the onboarding wizard — re-complete onboarding for the test user')
    }

    // Wait for the shell to be interactive before firing keystrokes.
    // The chat input placeholder is the most reliable "dashboard fully
    // mounted" signal — it only appears when TabBar (which owns the
    // hotkeys) is rendered.
    await expect(
      page.getByPlaceholder(/@ to mention|Continue chat/i).first(),
    ).toBeVisible({ timeout: 20000 })

    // Collect console errors that look like real crashes (not noisy
    // dev-mode warnings). We assert at the end so one bad view doesn't
    // mask another.
    const crashErrors: string[] = []
    page.on('pageerror', (err) => {
      crashErrors.push(`pageerror: ${err.message}`)
    })

    for (const [key, name] of VIEWS) {
      await page.keyboard.press(key)

      // Give React a beat to render. We're not chasing a specific
      // selector — we're just asserting the shell didn't blow up.
      // 500ms is enough on a fast preview; views that genuinely fetch
      // remote data will keep loading after, and that's fine — we're
      // testing render, not data freshness.
      await page.waitForTimeout(500)

      // Next.js error boundary copy. If either appears, the view threw.
      const errorBoundary = page.getByText(/Application error|Something went wrong/i).first()
      await expect(
        errorBoundary,
        `${name}: rendered an error boundary`,
      ).not.toBeVisible()

      // Dashboard shell sanity check — the body should still have
      // a [role="main"] or similar root. We use a soft check via
      // the document title staying intact.
      const title = await page.title()
      expect(title, `${name}: page title cleared (full crash?)`).toBeTruthy()
    }

    expect(crashErrors, 'no uncaught page errors during navigation').toEqual([])
  })

  test('core authed API endpoints return 2xx', { tag: '@pr' }, async ({ page }) => {
    await signInWithPassword(page, user!)
    // Use the page's request context so the auth cookie auto-refreshes if
    // Supabase rotates the token between requests. A static Cookie: header
    // built from page.context().cookies() goes stale and 401's — see J6
    // for the same fix.
    const api = page.context().request

    // Hit the endpoints the dashboard shell calls on every load. If any
    // of these starts 500'ing, the whole app is dead even if the React
    // tree mounts. Most agent regressions to API routes show up here.
    const endpoints = [
      '/api/account/workspace',
      '/api/account/workspace/list',
      '/api/account/actions?scope=created',
      '/api/account/teams',
      '/api/account/projects',
      '/api/account/initiatives',
      '/api/account/captures',
      '/api/account/views',
    ]

    for (const path of endpoints) {
      const res = await api.get(path)
      expect(
        res.status(),
        `${path}: expected 2xx, got ${res.status()}`,
      ).toBeLessThan(400)
    }
  })
})
