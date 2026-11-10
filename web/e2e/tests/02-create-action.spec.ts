import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword } from '../fixtures/auth'

/**
 * J2: Create an action and see it in the list.
 *
 * This journey drives the API directly (POST /api/account/actions) rather
 * than the create-action dialog, which has many selectors that shift
 * frequently and isn't where regressions actually happen. The dialog is
 * tested via component tests; this journey verifies the full auth →
 * workspace → action-create → action-list pipeline end-to-end.
 *
 * If this breaks, the whole "create things in Native Intelligence" feature is broken.
 */

const user = readTestUser('alice')

test.describe('J2: create action', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('creates an action via API and it appears in list', { tag: '@pr' }, async ({ page, request }) => {
    await signInWithPassword(page, user!)

    // The browser context (`page`) now has the auth cookie. We need to
    // hand it to `request` so the API calls are authenticated.
    const cookies = await page.context().cookies()
    const cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')

    const title = `E2E test action ${Date.now()}`

    // Create the action.
    const createRes = await request.post('/api/account/actions', {
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
      },
      data: { title },
    })
    expect(createRes.status(), 'create-action POST').toBe(200)
    const createBody = await createRes.json()
    expect(createBody.action, 'response has action object').toBeTruthy()
    expect(createBody.action.title).toBe(title)
    expect(createBody.action.identifier).toMatch(/^[A-Z]+-\d+$/) // GEN-42 shape
    const createdId = createBody.action.id as string

    // List actions and confirm it's there.
    const listRes = await request.get('/api/account/actions?scope=created', {
      headers: { cookie: cookieHeader },
    })
    expect(listRes.status(), 'list-actions GET').toBe(200)
    const listBody = await listRes.json()
    expect(Array.isArray(listBody.actions)).toBe(true)
    const found = listBody.actions.find(
      (a: { id: string; title: string }) => a.id === createdId,
    )
    expect(found, 'created action appears in list').toBeTruthy()
    expect(found.title).toBe(title)

    // Cleanup — best-effort. If this fails the next run still works
    // because each test uses a unique timestamp-suffixed title.
    await request.delete(`/api/account/actions/${createdId}`, {
      headers: { cookie: cookieHeader },
    }).catch(() => {
      // Swallow cleanup errors; they shouldn't fail the test.
    })
  })
})
