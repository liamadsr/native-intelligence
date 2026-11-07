import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword } from '../fixtures/auth'

/**
 * J1: Sign in lands on dashboard.
 *
 * If this breaks, nothing else works. Single highest-value journey.
 *
 * Skips when E2E_USER_ALICE_* env vars are unset so the suite stays green
 * on machines without secrets pulled. CI sets them via GitHub Secrets.
 */

const user = readTestUser('alice')

test.describe('J1: sign in', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('signs in with password and lands on /account', { tag: '@pr' }, async ({ page }) => {
    await signInWithPassword(page, user!)

    // Auth worked — we're on /account. That's the primary signal.
    await expect(page).toHaveURL(/\/account/)

    // Then assert we see EITHER the real dashboard OR the onboarding
    // wizard. Both prove the session was established. The test doesn't
    // care which state the user is in — that's an orthogonal concern,
    // and tying J1 to a specific UI state makes it fragile to fresh-
    // user setups or onboarding-state resets.
    //
    // - "@ to mention…" / "Continue chat" → chat input placeholder (dashboard)
    // - "Welcome, " → onboarding wizard heading for first-time users
    const dashboardSignal = page.getByPlaceholder(/@ to mention|Continue chat/i).first()
    const onboardingSignal = page.getByRole('heading', { name: /^Welcome,/i }).first()
    await expect(dashboardSignal.or(onboardingSignal)).toBeVisible({
      timeout: 20000,
    })
  })

  test('rejects bad credentials and stays on /login', { tag: '@pr' }, async ({ page }) => {
    await page.goto('/login')
    await page.locator('input[type="email"]').fill(user!.email)
    await page.locator('input[type="password"]').fill('definitely-wrong-password')
    await page.locator('button[type="submit"]').click()

    // Supabase returns an error message; we don't assert the exact copy
    // (could change), just that we stayed on /login and an error is shown.
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    // The error banner uses red styling. Match by role=alert OR the red text class.
    // Either signal is sufficient.
    const error = page
      .locator('[role="alert"], .text-red-700, .text-red-400')
      .first()
    await expect(error).toBeVisible({ timeout: 10000 })
  })
})
