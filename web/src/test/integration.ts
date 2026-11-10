/**
 * Integration-test helpers.
 *
 * Most of our tests fully mock Supabase (see `supabase-mock.ts`). Integration
 * tests are the next tier up: they exercise an API route's full handler with
 * real request parsing, real validation, and a Supabase client that mocks
 * just the network calls — not the chain itself.
 *
 * They are still "unit" in the Vitest sense (no real network, no real DB),
 * but they exercise the full handler from `new Request()` → `Response`.
 *
 * Why a separate helper file?
 *   - Encourages a consistent shape across route tests
 *   - One place to add fixtures (users, workspaces) as we grow
 *   - Keeps individual test files focused on assertions, not setup
 *
 * See `src/app/api/early-access/__tests__/route.test.ts` for the canonical
 * worked example.
 */
import { vi } from 'vitest'

/**
 * Build a fetch-style Request that mirrors what Next.js hands route handlers.
 * Defaults to JSON; pass `raw: true` to send the body unparsed (for invalid
 * JSON tests).
 */
export function buildRequest(opts: {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  /** If true, body is sent as-is (string). If false (default), JSON.stringify'd. */
  raw?: boolean
}) {
  const {
    url = 'https://nativeintelligence.dev/api/test',
    method = 'POST',
    headers = {},
    body,
    raw = false,
  } = opts

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  }

  let finalBody: BodyInit | undefined
  if (body !== undefined) {
    finalBody = raw ? String(body) : JSON.stringify(body)
  }

  return new Request(url, {
    method,
    headers: finalHeaders,
    body: finalBody,
  })
}

/**
 * Read a Response's JSON body. Convenience over `await res.json()` because
 * Vitest's assertion errors are clearer with a named variable.
 */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/**
 * Build a minimal authed context — what `requireWorkspace()` would return on
 * a happy path. Pair with `vi.mock('@/lib/api-auth', ...)` in your test file:
 *
 *   const hoisted = vi.hoisted(() => ({ auth: vi.fn() }))
 *   vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.auth }))
 *   beforeEach(() => hoisted.auth.mockResolvedValue(authedContext()))
 */
export function authedContext(
  overrides: {
    userId?: string
    workspaceId?: string
    memberId?: string
  } = {},
) {
  const userId = overrides.userId ?? 'user-test-1'
  const workspaceId = overrides.workspaceId ?? 'workspace-test-1'
  const memberId = overrides.memberId ?? 'member-test-1'

  // Caller can spread this into a richer object if they need the supabase
  // client. We keep this skinny because most tests mock the client elsewhere.
  return {
    user: { id: userId, email: 'test@nativeintelligence.test' },
    workspaceId,
    member: { id: memberId, role: 'owner' as const },
  }
}

/**
 * In-memory rate-limit reset for routes that maintain a Map at module scope
 * (e.g. `/api/early-access`). Use in `beforeEach` to isolate tests:
 *
 *   import { resetRateLimitFor } from '@/test/integration'
 *   beforeEach(() => resetRateLimitFor('@/app/api/early-access/route'))
 *
 * This works by re-importing the module. If the route doesn't expose its
 * Map (it shouldn't — it's a private detail), the test should instead
 * mock the rate-limit check or test rate-limiting deliberately as one of
 * the cases.
 */
export async function resetRateLimitFor(modulePath: string): Promise<void> {
  vi.resetModules()
  await import(modulePath)
}
