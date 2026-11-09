import { test, expect } from '@playwright/test';

// Minimum signal: the deployed app is alive. Runs without auth, against
// public routes. Tagged @pr so the CI grep selector picks them up
// alongside the authed journeys (J1, J2, J9).

test('marketing homepage loads', { tag: '@pr' }, async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveTitle(/Native Intelligence/i);
});

test('login page renders', { tag: '@pr' }, async ({ page }) => {
  await page.goto('/login');
  // Use the native email input directly rather than label association — more
  // robust against Radix/shadcn Label markup quirks and works regardless of
  // which auth mode (signin / signup / magic link) is the default.
  await expect(page.locator('input[type="email"]')).toBeVisible();
});
