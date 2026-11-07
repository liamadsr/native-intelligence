// @vitest-environment jsdom
/**
 * When the Connections panel reads its data (use-connections.ts): on mount,
 * when the panel opens, on focus only while it's open, and on refresh() —
 * never on a timer. Plus the shared status read's "Push to…" invalidation
 * (oauth-status.ts), which a panel connect relies on.
 *
 * Rendered standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  desktop: false,
  os: 'macos' as 'macos' | 'windows',
  getLocalCalendarStatus: vi.fn(async () => ({
    hasAccess: true,
    exchangeCalendars: [{ id: '1', title: 'Work', accountName: 'Exchange', color: '#f00' }],
  })),
}))
vi.mock('@/lib/platform', () => ({
  isDesktopApp: () => hoisted.desktop,
  desktopOS: () => (hoisted.desktop ? hoisted.os : null),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { getLocalCalendarStatus: hoisted.getLocalCalendarStatus },
}))

import { useConnections } from '../use-connections'
import { fetchOAuthStatus, resetTaskAccountBaseline } from '../oauth-status'
import { TASK_DESTINATIONS_CHANGED } from '@/lib/tasks/destinations-events'

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useConnections>
let calls: string[]
let statusBody: { accounts: unknown[] }
let mcpBody: { servers: unknown[] }
let failNext = false

function Probe({ active }: { active: boolean }) {
  latest = useConnections({ active })
  return null
}

async function render(active: boolean) {
  await act(async () => {
    root.render(h(Probe, { active }))
  })
  await flush()
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => {})
}

function statusCalls() {
  return calls.filter((u) => u === '/api/oauth/status').length
}

beforeEach(() => {
  hoisted.desktop = false
  hoisted.getLocalCalendarStatus.mockClear()
  resetTaskAccountBaseline()
  calls = []
  failNext = false
  statusBody = { accounts: [] }
  mcpBody = { servers: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (failNext) return new Response('{}', { status: 500 })
      const body = url === '/api/oauth/status' ? statusBody : mcpBody
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useConnections', () => {
  it('reads every endpoint once on mount (panel closed), then groups them', async () => {
    statusBody = {
      accounts: [{ id: '1', provider: 'google', capability: 'calendar', account_email: 'a@x.com', is_primary: true }],
    }
    mcpBody = { servers: [{ id: 's', display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', last_error: 'boom' }] }
    await render(false)
    expect(calls.sort()).toEqual(['/api/account/integrations/slack', '/api/account/mcp-servers', '/api/account/phone', '/api/oauth/status'])
    expect(latest.loading).toBe(false)
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['google:calendar'])
    expect(latest.groups.attention.map((r) => r.key)).toEqual(['mcp:s'])
    expect(latest.needsAttention).toBe(true)
  })

  it('mounting already open reads once, not twice', async () => {
    await render(true)
    expect(statusCalls()).toBe(1)
  })

  it('reads again each time the panel opens', async () => {
    await render(false)
    await render(true)
    expect(statusCalls()).toBe(2)
    await render(false)
    expect(statusCalls()).toBe(2)
    await render(true)
    expect(statusCalls()).toBe(3)
  })

  it('re-reads on window focus only while open', async () => {
    await render(false)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(statusCalls()).toBe(1)

    await render(true)
    expect(statusCalls()).toBe(2)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(statusCalls()).toBe(3)
  })

  it('refresh() re-reads', async () => {
    await render(false)
    await act(async () => {
      latest.refresh()
    })
    await flush()
    expect(statusCalls()).toBe(2)
  })

  it('never polls', async () => {
    vi.useFakeTimers()
    await act(async () => {
      root.render(h(Probe, { active: true }))
    })
    for (let i = 0; i < 6; i++) await act(async () => {})
    const before = calls.length
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000)
    })
    expect(calls.length).toBe(before)
  })

  it('keeps the last good data when a read fails', async () => {
    statusBody = { accounts: [{ id: '1', provider: 'linear', capability: 'tasks', account_email: 'a@x.com' }] }
    await render(false)
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['linear:tasks'])
    failNext = true
    await act(async () => {
      latest.refresh()
    })
    await flush()
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['linear:tasks'])
  })

  it('drops a stale response that lands after a newer read', async () => {
    let resolveFirst: (r: Response) => void = () => {}
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { signal?: AbortSignal }) => {
        if (url !== '/api/oauth/status') return Promise.resolve(new Response(JSON.stringify(mcpBody)))
        n++
        if (n === 1) {
          // The first read hangs, ignoring its abort, and answers late.
          void init
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(
          new Response(JSON.stringify({ accounts: [{ id: '2', provider: 'asana', capability: 'tasks', account_email: 'new@x.com' }] })),
        )
      }),
    )
    await render(false)
    await act(async () => {
      latest.refresh()
    })
    await flush()
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['asana:tasks'])
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ accounts: [] })))
    })
    await flush()
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['asana:tasks'])
  })

  it('on desktop also reads the local Exchange status', async () => {
    hoisted.desktop = true
    await render(false)
    expect(hoisted.getLocalCalendarStatus).toHaveBeenCalledTimes(1)
    expect(latest.groups.connected.map((r) => r.key)).toEqual(['local_exchange:calendar'])
  })

  it('in the Windows app has no local Exchange row (no local calendar there)', async () => {
    hoisted.desktop = true
    hoisted.os = 'windows'
    try {
      await render(false)
      expect(hoisted.getLocalCalendarStatus).not.toHaveBeenCalled()
      expect(latest.groups.available.map((r) => r.key)).not.toContain('local_exchange:calendar')
    } finally {
      hoisted.os = 'macos'
    }
  })

  it('on the web never touches the tauri bridge', async () => {
    await render(false)
    expect(hoisted.getLocalCalendarStatus).not.toHaveBeenCalled()
  })
})

describe('fetchOAuthStatus: the "Push to…" invalidation', () => {
  it('announces a change in the task-tracker count, never on the first read', async () => {
    const changed = vi.fn()
    window.addEventListener(TASK_DESTINATIONS_CHANGED, changed)
    try {
      await fetchOAuthStatus()
      expect(changed).not.toHaveBeenCalled()

      // A calendar connect isn't a tracker.
      statusBody = { accounts: [{ id: 'c', provider: 'google', capability: 'calendar' }] }
      await fetchOAuthStatus()
      expect(changed).not.toHaveBeenCalled()

      // A panel connect of Jira: the next read from any surface announces it.
      statusBody = {
        accounts: [
          { id: 'c', provider: 'google', capability: 'calendar' },
          { id: 'j', provider: 'jira', capability: 'tasks' },
        ],
      }
      await fetchOAuthStatus()
      expect(changed).toHaveBeenCalledTimes(1)

      await fetchOAuthStatus()
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(TASK_DESTINATIONS_CHANGED, changed)
    }
  })
})
