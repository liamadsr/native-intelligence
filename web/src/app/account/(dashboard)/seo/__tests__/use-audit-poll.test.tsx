// @vitest-environment jsdom
/**
 * The audit poll: a live audit is read every 3 s, the next read armed only
 * after the last settles; a failed read is a blip (it keeps going); a hidden
 * tab reads nothing; the first answer that is no longer live is handed over
 * and ends the loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SiteAuditDetail, SiteAuditStatus } from '@/lib/seo/audit/view'
import { AUDIT_POLL_INTERVAL_MS, useAuditPoll } from '../use-audit-poll'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = '11111111-1111-4111-8111-111111111111'
const detail = (status: SiteAuditStatus, crawled: number) => ({ audit: { id: ID, status, pages_crawled: crawled }, issues: [] }) as unknown as SiteAuditDetail

let answers: Array<SiteAuditDetail | 'fail'>
let fetchMock: ReturnType<typeof vi.fn>
let seen: SiteAuditDetail[]
let container: HTMLDivElement
let root: Root

function Probe({ live }: { live: boolean }) {
  useAuditPoll(ID, live, (d) => seen.push(d))
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
  answers = []
  fetchMock = vi.fn(async () => {
    const next = answers.shift() ?? 'fail'
    if (next === 'fail') return new Response(JSON.stringify({ error: 'Could not load the audit just now.' }), { status: 500 })
    return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
})

const tick = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS)
  })
}

describe('useAuditPoll', () => {
  it('reads a live audit every 3 s until an answer is no longer live, which it hands over', async () => {
    answers = [detail('running', 10), 'fail', detail('running', 30), detail('completed', 42)]
    act(() => root.render(<Probe live />))
    expect(fetchMock).not.toHaveBeenCalled()
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/account/seo/audits/${ID}`)
    // A failed read is a blip: the next one still comes.
    await tick()
    await tick()
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(seen.map((d) => `${d.audit.status}:${d.audit.pages_crawled}`)).toEqual(['running:10', 'running:30', 'completed:42'])
    // Ended: no more reads.
    await tick()
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('reads nothing while the tab is hidden, and again once it shows', async () => {
    answers = [detail('running', 10)]
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => root.render(<Probe live />))
    await tick()
    await tick()
    expect(fetchMock).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an audit that is not live', async () => {
    act(() => root.render(<Probe live={false} />))
    await tick()
    await tick()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
