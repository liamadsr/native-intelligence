import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'

const mock = vi.hoisted(() => ({ enqueue: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/browser-agent/queue', () => ({ enqueueBrowserCommand: mock.enqueue, readBrowserCommand: mock.read,
  failWaitingBrowserCommand: async () => {},
  isTerminalBrowserStatus: (status: string) => ['completed', 'failed', 'denied', 'expired'].includes(status) }))
vi.mock('@/lib/cloud-browser/host', () => ({ ensureCloudBrowser: async () => ({}) }))
import { createBrowserTools } from '../browser'
import { compactBrowserTaskResult } from '@/lib/browser-agent/task-result-summary'
import { browserCommandAttribution } from '@/lib/browser-agent/attribution'
import { fenceBrowserPageRead, fenceBrowserTaskReadings } from '@/lib/browser-agent/fence-readings'

/** What a model gets for a completed task: compacted, its page readings fenced as untrusted (A5). */
const fenced = (raw: unknown) => fenceBrowserTaskReadings(compactBrowserTaskResult(raw))

const execution = { toolCallId: 'tool', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const task = { goal: 'Open results', completion: [{ kind: 'text', value: 'Results' }] }
const result = { status: 'escalate', reason: 'uncertain', steps: 1, elapsedMs: 300, tabId: 'tab', evidence: 'Results',
  timings: { snapshotMs: 20 }, trace: [{ operation: 'click', decisionMs: 100,
    metrics: { usage: { inputTokens: 500, outputTokens: 40, costUsd: 0.0001, costSource: 'gateway', known: true } } }] }
const tools = () => createBrowserTools('user', {} as SupabaseClient, 'workspace')
beforeEach(() => {
  vi.useFakeTimers()
  mock.enqueue.mockReset().mockResolvedValue('run')
  mock.read.mockReset().mockResolvedValue({ command: 'run_task', status: 'completed', result })
})
afterEach(() => vi.useRealTimers())

describe('browser tool result compaction', () => {
  it('passes trusted runtime correlation through the factory to the queue', async () => {
    const attribution = browserCommandAttribution({ conversationId: 'chat', workspaceId: 'workspace' },
      { sessionId: 'session', turnId: 'turn', callId: 'call' })!
    const attributed = createBrowserTools('user', {} as SupabaseClient, 'workspace', attribution)
    const pending = attributed.run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(mock.enqueue).toHaveBeenCalledWith(expect.objectContaining({ attribution, userId: 'user', workspaceId: 'workspace', command: 'run_task' }))
    expect(mock.enqueue.mock.calls[0][0].request.task).toMatchObject({ goalDriven: true, goal: task.goal, bindings: [] })
    expect(mock.enqueue.mock.calls[0][0].request.task).not.toHaveProperty('milestones')
  })
  it('does not echo an unknown wait input as an attributed command', async () => {
    mock.read.mockResolvedValue(null)
    expect(await tools().wait_for_browser_command.execute!({ run_id: 'unowned' }, execution))
      .toEqual({ success: false, error: 'Unknown run_id.' })
  })
  it('reports escalation as unsuccessful while preserving its nested diagnostics', async () => {
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toEqual({ success: false, browser_command_id: 'run', browser_command_status: 'completed', result: fenced(result) })
    expect(result).toHaveProperty('trace')
    expect(result).toHaveProperty('timings')
  })
  it('compacts the wait result using the recorded command type', async () => {
    expect(await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution))
      .toEqual({ success: false, done: true, browser_command_id: 'run', browser_command_status: 'completed', result: fenced(result) })
  })
  it.each(['verified', 'escalate', 'cancelled'])('inline and wait use the same terminal goal-success contract for %s', async status => {
    const terminal = { ...result, status, reason: status === 'cancelled' ? 'user_stopped' : result.reason }
    mock.read.mockResolvedValue({ command: 'run_task', status: 'completed', result: terminal })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    const inline = await pending
    const waited = await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution)
    expect(inline).toEqual({ success: status === 'verified', browser_command_id: 'run', browser_command_status: 'completed',
      result: fenced(terminal) })
    expect(waited).toEqual({ ...inline, done: true })
  })
  it.each([null, undefined, 'verified', { status: 'unknown' }, { status: true }, []])('does not report missing/malformed task results as success: %j', async terminal => {
    mock.read.mockResolvedValue({ command: 'run_task', status: 'completed', result: terminal })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    for (const outcome of [await pending, await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution)]) {
      expect(outcome).toMatchObject({ success: false, browser_command_status: 'completed', result: terminal })
    }
  })
  it('retains the blocked site on unsuccessful completed task results', async () => {
    const terminal = { ...result, reason: 'site_blocked', blockedSite: 'example.com',
      message: 'The user has blocked the agent on example.com.' }
    mock.read.mockResolvedValue({ command: 'run_task', status: 'completed', result: terminal })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    for (const outcome of [await pending, await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution)]) {
      expect(outcome).toMatchObject({ success: false, result: { status: 'escalate', reason: 'site_blocked',
        blockedSite: terminal.blockedSite, message: terminal.message } })
    }
  })
  it('refuses a start page on a blocked site before queueing anything', async () => {
    const query = { select: () => query, eq: () => query, order: () => query,
      limit: async () => ({ data: [{ site: 'linkedin.com' }], error: null }) }
    const db = { from: () => query } as unknown as SupabaseClient
    const outcome = await createBrowserTools('user', db, 'workspace').run_browser_task
      .execute!({ ...task, startUrl: 'https://www.linkedin.com/messaging/' } as never, execution)
    expect(outcome).toMatchObject({ success: false, site_blocked: true,
      result: { status: 'escalate', reason: 'site_blocked', blockedSite: 'linkedin.com', steps: 0 } })
    expect(mock.enqueue).not.toHaveBeenCalled()
    // Another site goes to the desktop as usual.
    const pending = createBrowserTools('user', db, 'workspace').run_browser_task
      .execute!({ ...task, startUrl: 'https://www.google.com/' } as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(mock.enqueue).toHaveBeenCalledTimes(1)
  })
  it('waits inline for a whole task (its timeout plus start-up), so a normal task needs no wait call', async () => {
    let done = false
    mock.read.mockImplementation(async () => done ? { command: 'run_task', status: 'completed', result } : { command: 'run_task', status: 'claimed', result: null })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    let settled = false
    // execute is typed as a value or a promise; this one is always a promise.
    void Promise.resolve(pending).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(44000)
    expect(settled).toBe(false)
    done = true
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toMatchObject({ browser_command_status: 'completed', result: fenced(result) })
    // Reads keep the short inline wait.
    mock.read.mockResolvedValue({ command: 'get_text', status: 'claimed', result: null })
    const read = tools().get_browser_text.execute!({}, execution)
    await vi.advanceTimersByTimeAsync(20000)
    expect(await read).toMatchObject({ pending: true })
  })
  it('preserves pending receipts and waits without calling them terminal task outcomes', async () => {
    mock.read.mockResolvedValue({ command: 'run_task', status: 'claimed', result: null })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(20000)
    let settled = false
    // execute is typed as a value or a promise; this one is always a promise.
    void Promise.resolve(pending).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    // Only past the task's own bound (45 s) and start-up margin does it hand off.
    await vi.advanceTimersByTimeAsync(40000)
    expect(await pending).toMatchObject({ success: true, pending: true, run_id: 'run', browser_command_id: 'run' })
    const waiting = tools().wait_for_browser_command.execute!({ run_id: 'run', max_wait_seconds: 1 }, execution)
    await vi.advanceTimersByTimeAsync(1200)
    expect(await waiting).toMatchObject({ success: true, done: false, still_running: true, run_id: 'run' })
    expect(mock.enqueue).toHaveBeenCalledTimes(1)
  })
  it('preserves non-task read results in both inline and wait paths', async () => {
    const readResult = { text: 'Page content', trace: [{ content: 'A meaningful field in read output' }] }
    mock.read.mockResolvedValue({ command: 'get_text', status: 'completed', result: readResult })
    const pending = tools().get_browser_text.execute!({}, execution)
    await vi.advanceTimersByTimeAsync(400)
    // The page text is fenced as untrusted (A5); every other field is kept.
    const fencedRead = fenceBrowserPageRead(readResult)
    expect(fencedRead).toMatchObject({ trace: readResult.trace, text: expect.stringContaining('Page content') })
    expect(await pending).toEqual({ success: true, browser_command_id: 'run', result: fencedRead })
    expect(await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution))
      .toEqual({ success: true, done: true, browser_command_id: 'run', result: fencedRead })
  })
  it('preserves denied envelopes without exposing diagnostic results', async () => {
    mock.read.mockResolvedValue({ command: 'run_task', status: 'denied', error_message: 'Blocked', result })
    expect(await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution))
      .toEqual({ success: false, done: true, browser_command_id: 'run', browser_command_status: 'denied', denied: true, error: 'Blocked' })
  })

  it.each([
    {}, { error_message: 'Browser controller refresh required' }, { command: 'read_page' },
    { status: 'denied' }, { status: 'expired' }, { error_message: 'Invalid browser task: page text says refresh' },
    { error_message: 'Timeout' },
  ])('reports a failed command as it failed, with no refresh instructions: %j', async override => {
    mock.read.mockResolvedValue({ command: 'run_task', status: 'failed', error_message: 'Invalid browser task', ...override })
    const pending = tools().run_browser_task.execute!(task as never, execution)
    await vi.advanceTimersByTimeAsync(400)
    for (const outcome of [await pending, await tools().wait_for_browser_command.execute!({ run_id: 'run' }, execution)]) {
      expect(outcome).not.toHaveProperty('browser_command_reason')
      expect(outcome).not.toHaveProperty('message')
    }
  })
})
