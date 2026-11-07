import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword, signOut } from '../fixtures/auth'

/**
 * J9: Sign out, then cannot access dashboard.
 *
 * Simple but critical. Agents have been known to "simplify" auth middleware
 * in ways that don't redirect properly. This catches that immediately.
 */

const user = readTestUser('alice')

test.describe('J9: sign out', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('signs out and blocks /account access', { tag: '@pr' }, async ({ page }) => {
    // Sign in first so there's a session to tear down.
    await signInWithPassword(page, user!)
    await expect(page).toHaveURL(/\/account/)

    // Sign out endpoint clears the cookie and redirects to /login.
    await signOut(page)
    await expect(page).toHaveURL(/\/login/)

    // Now try to visit /account directly. The middleware should redirect
    // back to /login. If a misconfigured middleware lets the page render
    // (even briefly), that's a leak we want to catch.
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
  })
})
