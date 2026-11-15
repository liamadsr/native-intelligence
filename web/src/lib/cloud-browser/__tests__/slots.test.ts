/**
 * The shared slots' pieces (src/lib/cloud-browser/slots.ts, config.ts): the cap's
 * setting, the runtime's "no memory" refusal told from any other error, who may
 * give way, and the error callers recognise. The whole flow against the fake
 * runtime is in backend-runtime.test.ts ("the shared slots").
 */
import { describe, expect, it, vi } from 'vitest'
import { cloudBrowserMaxRunning } from '@/lib/cloud-browser/config'
import { CloudBrowserBusyError, CloudBrowserNoRoomError, EVICTION_DRIVEN_FLOOR_MS, EVICTION_IDLE_FLOOR_MS, evictionCandidates, isCloudBrowserBusy, isCloudBrowserNoRoom, isRuntimeNoRoomMessage } from '@/lib/cloud-browser/slots'

describe('CLOUD_BROWSER_MAX_RUNNING', () => {
  it('is a positive integer, 4 when unset or blank', () => {
    expect(cloudBrowserMaxRunning({})).toBe(4)
    expect(cloudBrowserMaxRunning({ CLOUD_BROWSER_MAX_RUNNING: '  ' })).toBe(4)
    expect(cloudBrowserMaxRunning({ CLOUD_BROWSER_MAX_RUNNING: '3' })).toBe(3)
    expect(cloudBrowserMaxRunning({ CLOUD_BROWSER_MAX_RUNNING: ' 12 ' })).toBe(12)
  })

  it('anything else is the default, said once in the log (a typo never stops every browser)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-1', '2.5', 'four', '1e3', '01']) expect(cloudBrowserMaxRunning({ CLOUD_BROWSER_MAX_RUNNING: bad })).toBe(4)
    expect(cloudBrowserMaxRunning({ CLOUD_BROWSER_MAX_RUNNING: 'four' })).toBe(4)
    expect(warn).toHaveBeenCalledTimes(6)
    warn.mockRestore()
  })
})

describe('the runtime’s refusal for memory', () => {
  it('is told by its words, as seen live, and nothing else is', () => {
    expect(isRuntimeNoRoomMessage(new Error('500: Failed to place sandbox: this node cannot map 4096 MiB of guest memory: its memory pool is too small or in use by running sandboxes'))).toBe(true)
    expect(isRuntimeNoRoomMessage(new Error('cannot map 2048 MiB of guest memory'))).toBe(true)
    expect(isRuntimeNoRoomMessage(new Error('its memory pool is too small or in use by running sandboxes'))).toBe(true)
    // The memory phrases only: a placement that failed for another reason is an error like any other.
    for (const other of ['500: Failed to place sandbox: no node with the template', 'sandbox abc not found', '502 Bad Gateway', 'The sandbox is not running', 'timeout', '']) expect(isRuntimeNoRoomMessage(new Error(other))).toBe(false)
    expect(isRuntimeNoRoomMessage(null)).toBe(false)
    expect(isCloudBrowserNoRoom(new CloudBrowserNoRoomError('x'))).toBe(true)
    expect(isCloudBrowserNoRoom(new Error('cannot map 4096 MiB of guest memory'))).toBe(false)
  })
})

describe('who may give way', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  const row = (user: string, status: string, idleMs: number) => ({ user_id: user, workspace_id: 'w', status, last_active_at: new Date(now - idleMs).toISOString() })

  it('running browsers of others, unused past the floor, idle longest first', () => {
    const out = evictionCandidates([
      row('fresh', 'running', EVICTION_IDLE_FLOOR_MS - 1),
      row('at-floor', 'running', EVICTION_IDLE_FLOOR_MS),
      row('old', 'running', 30 * 60_000),
      row('starting', 'starting', 60 * 60_000),
      row('stopping', 'stopping', 60 * 60_000),
      row('me', 'running', 60 * 60_000),
      { ...row('garbled', 'running', 0), last_active_at: 'not a time' },
    ], { userId: 'me', workspaceId: 'w' }, now)
    expect(out.map(r => r.user_id)).toEqual(['old', 'at-floor'])
  })

  it('a browser the person drives gives way only after the idle sweep’s own idle time', () => {
    const driven = (idleMs: number) => ({ ...row('driven', 'running', idleMs), driver: 'person' })
    const self = { userId: 'me', workspaceId: 'w' }
    expect(EVICTION_DRIVEN_FLOOR_MS).toBe(5 * 60_000)
    expect(evictionCandidates([driven(4 * 60_000), row('plain', 'running', 3 * 60_000)], self, now).map(r => r.user_id)).toEqual(['plain'])
    expect(evictionCandidates([driven(5 * 60_000)], self, now).map(r => r.user_id)).toEqual(['driven'])
    expect(evictionCandidates([{ ...row('agent', 'running', 3 * 60_000), driver: 'agent' }], self, now)).toHaveLength(1)
  })

  it('the floor outlasts two of the live view’s 60 s pings', () => {
    expect(EVICTION_IDLE_FLOOR_MS).toBeGreaterThanOrEqual(2 * 60_000)
  })
})

describe('the error callers show', () => {
  it('carries its sentence and code, and is recognised by its code too', () => {
    const e = new CloudBrowserBusyError()
    expect(e.message).toBe('All browsers are in use right now. Try again in a minute.')
    expect(e.code).toBe('BROWSERS_BUSY')
    expect(isCloudBrowserBusy(e)).toBe(true)
    expect(isCloudBrowserBusy(Object.assign(new Error('x'), { code: 'BROWSERS_BUSY' }))).toBe(true)
    expect(isCloudBrowserBusy(new Error('All browsers are in use right now. Try again in a minute.'))).toBe(false)
    expect(isCloudBrowserBusy(undefined)).toBe(false)
  })
})
