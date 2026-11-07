import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrowserObservation } from '@/lib/browser-agent/task-contract'

const mock = vi.hoisted(() => ({ enqueue: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/browser-agent/queue', () => ({ enqueueBrowserCommand: mock.enqueue, readBrowserCommand: mock.read,
  isTerminalBrowserStatus: (status: string) => ['completed', 'failed', 'denied', 'expired'].includes(status) }))
import { createBrowserTools } from '../browser'
import { fenceBrowserPageRead } from '@/lib/browser-agent/fence-readings'

const execution = { toolCallId: 'diagnostic', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const observation: BrowserObservation = {
  protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 3, interactionEpoch: 0, observedAt: 1000,
  url: 'https://www.google.com/travel/flights', title: 'Google Flights', text: 'Where to? Los Angeles (LAX)',
  readyState: 'complete', loading: false, evidence: { headings: [], dialogs: [{ name: 'Destination', visible: true }], dialogsComplete: true },
  elements: [{ ref: 'e1', role: 'combobox', name: 'Where to?', value: 'Los Angeles', canType: true,
    disabled: false, forbidden: false, sensitive: false, context: 'Destination airport', destination: '', dialog: 'Destination' }],
}
const tools = () => createBrowserTools('user', {} as SupabaseClient, 'workspace')
beforeEach(() => {
  vi.useFakeTimers()
  mock.enqueue.mockReset().mockResolvedValue('run')
  mock.read.mockReset().mockResolvedValue({ command: 'read_page', status: 'completed', result: observation })
})
afterEach(() => vi.useRealTimers())

describe('opt-in browser decision snapshots', () => {
  it('passes explicit diagnostic mode through the existing read queue and preserves replay evidence exactly', async () => {
    const pending = tools().read_browser_page.execute!({ tab_id: 'tab', decision_snapshot: true, prose: true, max: 1 }, execution)
    await vi.advanceTimersByTimeAsync(400)
    // Validated on the raw shape, then its page text fenced as untrusted (A5).
    expect(await pending).toEqual({ success: true, browser_command_id: 'run', result: fenceBrowserPageRead(observation) })
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      command: 'read_page', userId: 'user', workspaceId: 'workspace', tabId: 'tab', request: { options: { decision: true } },
    }))
  })

  it.each([undefined, false])('leaves normal reads unchanged when diagnostic mode is %s', async decision_snapshot => {
    const legacy = { url: 'https://example.com', title: 'Page', text: '@e1 button Search', count: 1 }
    mock.read.mockResolvedValue({ command: 'read_page', status: 'completed', result: legacy })
    const pending = tools().read_browser_page.execute!({ prose: true, max: 12, decision_snapshot }, execution)
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toEqual({ success: true, browser_command_id: 'run', result: fenceBrowserPageRead(legacy) })
    expect(mock.enqueue).toHaveBeenCalledWith(expect.objectContaining({ request: { options: { prose: true, max: 12 } } }))
  })

  it.each([{ url: 'https://example.com', text: 'Legacy', count: 1 }, { ...observation, text: 'x'.repeat(12001) }])
    ('rejects malformed or over-limit diagnostic output rather than presenting it as replayable', async result => {
      mock.read.mockResolvedValue({ command: 'read_page', status: 'completed', result })
      const pending = tools().read_browser_page.execute!({ decision_snapshot: true }, execution)
      await vi.advanceTimersByTimeAsync(400)
      expect(await pending).toEqual({ success: false, browser_command_id: 'run',
        error: 'Browser diagnostic snapshot unavailable: the browser did not return a valid normalized observation.' })
    })

  it('returns only the normalized schema, excluding unexpected raw DOM or screenshot fields', async () => {
    mock.read.mockResolvedValue({ command: 'read_page', status: 'completed', result: { ...observation, html: '<body>raw</body>', screenshotBase64: 'data' } })
    const pending = tools().read_browser_page.execute!({ decision_snapshot: true }, execution)
    await vi.advanceTimersByTimeAsync(400)
    // Validated on the raw shape, then its page text fenced as untrusted (A5).
    expect(await pending).toEqual({ success: true, browser_command_id: 'run', result: fenceBrowserPageRead(observation) })
  })
})
