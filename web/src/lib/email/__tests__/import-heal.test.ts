import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInngestSend = vi.fn(async () => ({ ids: ['e-1'] }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...(args as [])) },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('pass a client') } }))

const { importNeedsRestart, restartStalledEmailImports, RUNNING_GRACE_MS } = await import('@/lib/email/import-heal')

const NOW = Date.parse('2026-10-14T06:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const done = { initial_import_status: 'complete', initial_import_started_at: ago(86_400_000), gmail_history_id: 'h-1', ms_delta_link: null }

describe('importNeedsRestart', () => {
  it('leaves a finished import with its checkpoint alone', () => {
    expect(importNeedsRestart('google', done, NOW)).toBe(false)
    expect(importNeedsRestart('microsoft', { ...done, gmail_history_id: null, ms_delta_link: 'dl' }, NOW)).toBe(false)
  })

  it('restarts an account with no sync state, a failed or pending import, or no checkpoint', () => {
    expect(importNeedsRestart('google', null, NOW)).toBe(true)
    expect(importNeedsRestart('google', { ...done, initial_import_status: 'failed' }, NOW)).toBe(true)
    expect(importNeedsRestart('google', { ...done, initial_import_status: 'pending', initial_import_started_at: null }, NOW)).toBe(true)
    // An Outlook import whose delta-link fetch failed finished without a checkpoint.
    expect(importNeedsRestart('microsoft', { ...done, gmail_history_id: null }, NOW)).toBe(true)
  })

  it('does not restart an import that may still be running', () => {
    const running = { ...done, initial_import_status: 'importing_recent', gmail_history_id: null, initial_import_started_at: ago(5 * 60_000) }
    expect(importNeedsRestart('google', running, NOW)).toBe(false)
    expect(importNeedsRestart('google', { ...running, initial_import_started_at: ago(RUNNING_GRACE_MS + 1) }, NOW)).toBe(true)
  })

  it('restarts a row left mid-backfill, now that the backfill is gone', () => {
    expect(importNeedsRestart('google', { ...done, initial_import_status: 'backfilling' }, NOW)).toBe(true)
  })
})

describe('restartStalledEmailImports', () => {
  beforeEach(() => mockInngestSend.mockClear())

  function client(accounts: unknown[], states: unknown[]) {
    const inCalls: unknown[][] = []
    const from = (table: string) => {
      const rows = table === 'connected_account' ? accounts : states
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        in: (_col: string, ids: unknown[]) => {
          inCalls.push(ids)
          return api
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
      }
      return api
    }
    return { db: { from } as never, inCalls }
  }

  it('sends one de-duplicated import event per stalled account and skips healthy ones', async () => {
    const { db, inCalls } = client(
      [
        { id: 'a-ok', user_id: 'u-1', workspace_id: 'w-1', provider: 'google' },
        { id: 'a-stuck', user_id: 'u-2', workspace_id: 'w-2', provider: 'microsoft' },
        { id: 'a-new', user_id: 'u-3', workspace_id: 'w-3', provider: 'google' },
      ],
      [
        { account_id: 'a-ok', ...done },
        { account_id: 'a-stuck', ...done, gmail_history_id: null, ms_delta_link: null },
      ],
    )

    const restarted = await restartStalledEmailImports(db, NOW)

    expect(restarted).toBe(2)
    expect(inCalls).toEqual([['a-ok', 'a-stuck', 'a-new']])
    expect(mockInngestSend).toHaveBeenCalledTimes(2)
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'email-import-restart-a-stuck-2026-10-14',
      name: 'email/initial-import',
      data: { accountId: 'a-stuck', userId: 'u-2', workspaceId: 'w-2', provider: 'microsoft' },
    })
    expect(mockInngestSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'email-import-restart-a-new-2026-10-14' }))
  })

  it('does nothing when no mailbox is connected', async () => {
    const { db } = client([], [])
    expect(await restartStalledEmailImports(db, NOW)).toBe(0)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })
})
