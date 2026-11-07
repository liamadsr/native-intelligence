/**
 * Mocks for Next.js server APIs (cookies, headers) used by helpers that
 * read request state. Use from individual test files:
 *
 *   import { mockNextHeaders } from '@/test/next-mocks'
 *   mockNextHeaders({ cookies: { workspace_id: 'w1' }, headers: {} })
 */
import { vi } from 'vitest'

export interface NextHeadersState {
  cookies?: Record<string, string>
  headers?: Record<string, string>
}

/**
 * Mocks `next/headers` cookies() and headers() to return the provided state.
 * Must be called BEFORE importing any module that uses them.
 */
export function mockNextHeaders(state: NextHeadersState = {}) {
  const cookies = state.cookies ?? {}
  const headers = state.headers ?? {}

  vi.mock('next/headers', () => ({
    cookies: async () => ({
      get: (name: string) =>
        name in cookies ? { name, value: cookies[name] } : undefined,
      getAll: () =>
        Object.entries(cookies).map(([name, value]) => ({ name, value })),
      set: vi.fn(),
      delete: vi.fn(),
    }),
    headers: async () => ({
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      has: (name: string) => name.toLowerCase() in headers,
    }),
  }))
}
