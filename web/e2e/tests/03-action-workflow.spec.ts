import { test, expect } from '@playwright/test'
import { readTestUser, signInWithPassword, cookieHeader } from '../fixtures/auth'

/**
 * J3: An action moves through workflow states and the change persists.
 *
 * Workflow transitions touch:
 *   - RLS — the user must be allowed to update the action
 *   - The workflow_state lookup in the PATCH handler (for toggle_complete)
 *   - The notification side-effect (status change → notify assignees)
 *   - Optimistic UI cache invalidation (not exercised here, but the
 *     server side is the part that breaks silently)
 *
 * We use `toggle_complete` rather than passing explicit `status_id` UUIDs.
 * Reasons:
 *   - There's no public endpoint to list workflow_states, so the test
 *     would need to know team-specific UUIDs that drift across seeds.
 *   - `toggle_complete: true/false` is the exact code path users hit
 *     when they click the action checkbox — the most-used transition.
 *   - It exercises the workflow_state lookup branch in the PATCH handler
 *     (selects category='completed' or is_default=true).
 *
 * Exhaustive state-machine coverage (every transition, illegal moves,
 * etc.) belongs in integration tests against the PATCH route, not here.
 * E2E covers the happy path; integration covers the matrix.
 */

const user = readTestUser('alice')

test.describe('J3: action workflow transitions', () => {
  test.skip(
    !user,
    'E2E_USER_ALICE_EMAIL/PASSWORD not set — skipping authed journey',
  )

  test('toggling complete moves an action to Done and back', { tag: '@pr' }, async ({ page, request }) => {
    await signInWithPassword(page, user!)
    const cookie = await cookieHeader(page.context())
    const headers = { 'Content-Type': 'application/json', cookie }

    // Create the action. POST returns it in the team's default state
    // (typically "Todo" or "Backlog" depending on team config).
    const title = `E2E workflow test ${Date.now()}`
    const createRes = await request.post('/api/account/actions', {
      headers,
      data: { title },
    })
    expect(createRes.status(), 'create action').toBe(200)
    const created = (await createRes.json()).action as {
      id: string
      status_id: string
      status_name: string
      status_category?: string
    }
    expect(created.id, 'created action has id').toBeTruthy()

    // Capture the starting state so we can later assert we returned to it.
    const startStatusId = created.status_id
    const startStatusName = created.status_name

    try {
      // Transition to completed.
      const completeRes = await request.patch(`/api/account/actions/${created.id}`, {
        headers,
        data: { toggle_complete: true },
      })
      expect(completeRes.status(), 'toggle_complete: true').toBe(200)
      const completed = (await completeRes.json()).action as {
        status_id: string
        status_name: string
        status_category: string
      }
      expect(
        completed.status_id,
        'status_id changed after toggle_complete: true',
      ).not.toBe(startStatusId)
      expect(
        completed.status_category,
        'new state has category "completed"',
      ).toBe('completed')

      // Reload via GET to prove it persisted, not just that PATCH echoed back.
      // This is the bug-pattern catch: PATCH returns optimistic data but the
      // DB write silently failed.
      const reloadCompleted = await request.get(
        `/api/account/actions/${created.id}`,
        { headers: { cookie } },
      )
      expect(reloadCompleted.status(), 'GET action after complete').toBe(200)
      const reloadCompletedBody = (await reloadCompleted.json()).action as {
        status_id: string
      }
      expect(
        reloadCompletedBody.status_id,
        'completed state persisted to DB',
      ).toBe(completed.status_id)

      // Transition back to the default state.
      const uncompleteRes = await request.patch(`/api/account/actions/${created.id}`, {
        headers,
        data: { toggle_complete: false },
      })
      expect(uncompleteRes.status(), 'toggle_complete: false').toBe(200)
      const uncompleted = (await uncompleteRes.json()).action as {
        status_id: string
        status_name: string
      }
      expect(
        uncompleted.status_id,
        'returned to default state after toggle_complete: false',
      ).toBe(startStatusId)
      expect(
        uncompleted.status_name,
        'status_name matches the original state',
      ).toBe(startStatusName)

      // And reload again to confirm.
      const reloadBack = await request.get(
        `/api/account/actions/${created.id}`,
        { headers: { cookie } },
      )
      const reloadBackBody = (await reloadBack.json()).action as { status_id: string }
      expect(reloadBackBody.status_id, 'default state persisted').toBe(startStatusId)
    } finally {
      // Always clean up. If we leak actions every CI run, alice's
      // workspace fills with junk and unrelated tests start flaking.
      await request
        .delete(`/api/account/actions/${created.id}`, { headers: { cookie } })
        .catch(() => {})
    }
  })
})
