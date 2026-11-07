import { test as setup } from '@playwright/test';
import { signInWithPassword } from './fixtures/auth';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Saves authenticated session state for test users so individual tests can
// reuse the session via `test.use({ storageState: '...' })`. Wire this up
// once the seed script creates the test users.

const AUTH_DIR = path.join(__dirname, '.auth');

setup('authenticate as alice', async ({ page }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const email = process.env.E2E_USER_ALICE_EMAIL;
  const password = process.env.E2E_USER_ALICE_PASSWORD;

  if (!email || !password) {
    // Skip until the seed users exist. Once seeding lands, remove this branch.
    console.warn('[global-setup] E2E_USER_ALICE_* not set — skipping auth setup');
    return;
  }

  // Delegates to the shared fixture rather than re-driving the form here:
  // this copy used getByLabel (the Radix/shadcn label association is not
  // reliable on this form) and a name-based button match that also matches
  // the Google OAuth button, and it had none of the hydration handling that
  // the fixture grew after this exact step flaked in CI.
  await signInWithPassword(page, { email, password });

  await page.context().storageState({ path: path.join(AUTH_DIR, 'alice.json') });
});
