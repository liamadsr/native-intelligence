import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword } from '../fixtures/auth'

/**
 * J6: Switch between workspaces and confirm scoping changes.
 *
 * Workspace switching is the kind of feature where bugs are silent —
 * if the server keeps reading the old workspace_id from a stale cookie,
 * or RLS ignores the new scope, users see data leaks across tenants
 * with no visible error. So we exercise the full round-trip:
 *
 *   1. Read the user's workspace list (alice has 2+)
 *   2. Note the currently-active workspace
 *   3. POST /api/account/workspace/switch with the other workspace's ID
 *   4. GET /api/account/workspace and assert the new workspace is active
 *   5. Switch back to the original
 *
 * Drives the API directly rather than the workspace-switcher dropdown —
 * the dropdown's selectors (Radix sub-menus) are fragile and not what's
 * actually breaking when this regresses. The dropdown UI is a thin
 * client over POST /switch.
 *
 * IMPORTANT — cookie-jar discipline:
 *   We use `page.context().request` (NOT the top-level `request` fixture)
 *   so the API calls share the browser's cookie jar. Two reasons this
 *   matters:
 *     1. Supabase rotates `sb-access-token` periodically; the browser jar
 *        sees Set-Cookie responses and stays current. A snapshotted
 *        Cookie: header string goes stale and 401's.
 *     2. POST /switch sets a fresh WORKSPACE_COOKIE; the next GET needs
 *        that new value, not the pre-switch one. Sharing the jar means
 *        Playwright handles it automatically.
 *   The earlier version of this test snapshotted cookies into a header
 *   and 401'd intermittently — see the J6 failure on the first CI run.
 *
 * This test depends on alice having ≥2 workspaces. The user created
 * "workspace two" specifically for this. If alice ever drops to one
 * workspace the test skips with a clear message.
 */

const user = readTestUser('alice')

test.describe('J6: switch workspaces', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('switching workspaces updates the active scope', { tag: '@pr' }, async ({ page }) => {
    await signInWithPassword(page, user!)
    // Use the page's request context so cookies (auth + workspace) auto-sync.
    const api = page.context().request

    // Pull the full workspace list.
    const listRes = await api.get('/api/account/workspace/list')
    expect(listRes.status(), 'list workspaces').toBe(200)
    const { workspaces } = (await listRes.json()) as {
      workspaces: Array<{ id: string; name: string }>
    }
    expect(Array.isArray(workspaces)).toBe(true)

    // Need at least two to actually test switching. Skip cleanly otherwise —
    // we don't want this to fail when alice's account gets reseeded.
    test.skip(
      workspaces.length < 2,
      `alice has only ${workspaces.length} workspace(s); need ≥2 for switch test`,
    )

    // Identify current workspace.
    const currentRes = await api.get('/api/account/workspace')
    expect(currentRes.status(), 'get current workspace').toBe(200)
    const currentBody = (await currentRes.json()) as {
      workspace: { id: string; name: string } | null
    }
    const originalId = currentBody.workspace?.id
    expect(originalId, 'has an active workspace').toBeTruthy()

    // Pick a different workspace to switch to.
    const target = workspaces.find((w) => w.id !== originalId)
    expect(target, 'found a different workspace to switch to').toBeTruthy()

    // Switch. The Set-Cookie response is applied to the shared jar.
    const switchRes = await api.post('/api/account/workspace/switch', {
      data: { workspace_id: target!.id },
    })
    expect(switchRes.status(), 'switch workspace POST').toBe(200)

    // Confirm the active workspace updated.
    const afterRes = await api.get('/api/account/workspace')
    expect(afterRes.status(), 'get workspace after switch').toBe(200)
    const afterBody = (await afterRes.json()) as {
      workspace: { id: string; name: string } | null
    }
    expect(
      afterBody.workspace?.id,
      'active workspace ID changed after switch',
    ).toBe(target!.id)

    // Switch back so subsequent runs and other tests using alice see
    // the same default state.
    const restoreRes = await api.post('/api/account/workspace/switch', {
      data: { workspace_id: originalId },
    })
    expect(restoreRes.status(), 'restore original workspace').toBe(200)
  })
})
