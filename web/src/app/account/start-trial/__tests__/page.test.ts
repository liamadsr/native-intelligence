import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { AuthSessionPinger } from '@/components/analytics/auth-session-pinger'
import StartTrialPage from '../page'

/**
 * The trial wall is where a NEW SIGNUP lands first — the dashboard layout and
 * the onboarding page both redirect here until Stripe holds a card. So it has
 * to mount the auth-session pinger itself. When it didn't, the first ping
 * waited on Checkout, and two things quietly broke for anyone slower than the
 * windows below:
 *
 *   • persona-edition attribution — the cookie and both freshness gates are
 *     one hour, so the landing page's edition was dropped and the workspace
 *     fell back to `full`;
 *   • the signup event — a session only counts as `user_signed_up` inside 60s
 *     of account creation, so the signup was recorded as a login.
 *
 * Nothing else pins WHICH surfaces mount the pinger, so this does.
 */

const getBillingAccess = vi.hoisted(() => vi.fn())
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    // Like Next's: it throws, so nothing after it runs.
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
)

vi.mock('next/navigation', () => ({ redirect }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'new@acme.test' } } }) },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/billing/access.server', () => ({ getBillingAccess }))
// The view is a client component with its own UI graph; this test is about
// what the page mounts around it.
vi.mock('../start-trial-view', () => ({ StartTrialView: () => null }))

function access(overrides: { allowed: boolean }) {
  return {
    state: overrides.allowed ? 'trialing' : 'none',
    hasUsedTrial: false,
    canSkipPayment: false,
    hasStripe: false,
    ...overrides,
  }
}

/** Every element in a rendered tree, fragments flattened. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const children = (node.props as { children?: ReactNode }).children
  return node.type === Fragment ? elements(children) : [node]
}

beforeEach(() => {
  getBillingAccess.mockReset()
  redirect.mockClear()
})

describe('StartTrialPage', () => {
  it('mounts the auth-session pinger for an account behind the wall', async () => {
    getBillingAccess.mockResolvedValue(access({ allowed: false }))
    const tree = await StartTrialPage({ searchParams: Promise.resolve({}) })
    expect(elements(tree).some((el) => el.type === AuthSessionPinger)).toBe(true)
  })

  it('still mounts it on the return from Checkout — the route dedups the re-ping', async () => {
    getBillingAccess.mockResolvedValue(access({ allowed: true }))
    const tree = await StartTrialPage({ searchParams: Promise.resolve({ session_id: 'cs_1' }) })
    expect(elements(tree).some((el) => el.type === AuthSessionPinger)).toBe(true)
  })

  it('redirects an account that already has access before anything renders', async () => {
    getBillingAccess.mockResolvedValue(access({ allowed: true }))
    await expect(StartTrialPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/account',
    )
  })
})
