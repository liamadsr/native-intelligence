// @vitest-environment jsdom
/**
 * RunQuestionSection — the mid-run "needs your input" surface (Loops v3
 * interactive work runs). It renders the shared QuestionPicker from
 * `pending_input.questions` and POSTs the user's answer/skip to the respond route.
 * These tests pin the wire contract the respond route (W2) parses:
 *   - submit → POST /respond `{ answers: AskUserAnswer[] }` with the chosen
 *     option(s) split back into `selected`, and `onResumed` fired on success;
 *   - skip   → POST /respond `{ skipped: true }`.
 *
 * Mounted standalone with createRoot (mirrors attention-card-work.test — no
 * @testing-library).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { PendingInput } from '@/lib/agent-run/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { RunQuestionSection } from '../run-question-section'

let container: HTMLDivElement
let root: Root

function pending(overrides: Partial<PendingInput> = {}): PendingInput {
  return {
    requestId: 'req-1',
    approveOptionId: 'opt-approve',
    denyOptionId: 'opt-deny',
    askedAt: new Date().toISOString(),
    questions: [
      {
        question: 'Which tone should the follow-up email take?',
        header: 'Tone',
        options: [
          { label: 'Warm', description: 'Friendly and personable' },
          { label: 'Formal', description: 'Buttoned-up' },
        ],
        multiSelect: false,
      },
    ],
    ...overrides,
  }
}

function clickButtonContaining(text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
  if (!btn) throw new Error(`no button containing "${text}"`)
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('RunQuestionSection', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the "Needs your input" header and the question', () => {
    act(() => {
      root.render(h(RunQuestionSection, { runId: 'run-1', pendingInput: pending() }))
    })
    const text = container.textContent || ''
    expect(text).toContain('Needs your input')
    expect(text).toContain('Which tone should the follow-up email take?')
  })

  it('submit POSTs { answers: AskUserAnswer[] } to /respond and fires onResumed', async () => {
    const onResumed = vi.fn()
    act(() => {
      root.render(h(RunQuestionSection, { runId: 'run-abc', pendingInput: pending(), onResumed }))
    })
    // Pick the single-select "Warm" option, then Submit.
    clickButtonContaining('Warm')
    await act(async () => {
      clickButtonContaining('Submit')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/agent-runs/run-abc/respond')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      answers: [
        { question: 'Which tone should the follow-up email take?', answer: 'Warm' },
      ],
    })
    expect(onResumed).toHaveBeenCalledTimes(1)
  })

  it('skip POSTs { skipped: true } to /respond', async () => {
    const onResumed = vi.fn()
    act(() => {
      root.render(h(RunQuestionSection, { runId: 'run-xyz', pendingInput: pending(), onResumed }))
    })
    await act(async () => {
      clickButtonContaining('Skip')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/agent-runs/run-xyz/respond')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ skipped: true })
    expect(onResumed).toHaveBeenCalledTimes(1)
  })

  it('does not fire onResumed when the POST fails', async () => {
    const onResumed = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not parked' }), { status: 409 }),
    )
    act(() => {
      root.render(h(RunQuestionSection, { runId: 'run-fail', pendingInput: pending(), onResumed }))
    })
    await act(async () => {
      clickButtonContaining('Skip')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onResumed).not.toHaveBeenCalled()
    expect(container.textContent).toContain('not parked')
  })
  it('a run waiting on a teammate it handed work to shows a line, never a picker (row 13)', () => {
    const entry = { requestId: 'r1', callId: 'c1', approveOptionId: 'approve', role: 'researcher', childRunId: 'child-1' }
    act(() => {
      root.render(h(RunQuestionSection, { runId: 'run-1', pendingInput: { kind: 'delegation', askedAt: 'x', children: [entry] } }))
    })
    expect(container.textContent).toContain('Waiting on the Researcher.')
    expect(container.textContent).not.toContain('Needs your input')
    expect(container.querySelectorAll('button')).toHaveLength(0)

    act(() => {
      root.render(
        h(RunQuestionSection, {
          runId: 'run-1',
          pendingInput: { kind: 'delegation', askedAt: 'x', children: [entry, { ...entry, requestId: 'r2', childRunId: 'child-2' }, { ...entry, requestId: 'r3', childRunId: null }] },
        }),
      )
    })
    expect(container.textContent).toContain('Waiting on 2 teammates.')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
