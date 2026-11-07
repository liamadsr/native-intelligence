// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionEvaluationReport } from '@/lib/ai/decisions/evaluation-report'
import { DecisionQualityPanel } from '../quality-panel'

const sample: DecisionEvaluationReport = {
  schemaVersion: 1, provenance: 'synthetic', dataset: 'held-out-v1', createdAt: '2026-10-04T12:00:00.000Z',
  model: 'typesafe-ai/jev', gitCommit: 'abcdef1', reverseChoices: true, latencyScope: 'provider_roundtrip', plannedCases: 3,
  cases: [{ id: 'email-case', kind: 'email.reply_required', taskVersion: 'email-reply-v3', status: 'accepted',
    correct: false, falseSuppression: true, falseAllow: false, providerMs: 2700, deadlineMs: 2500, inputTokens: null, outputTokens: null, costUsd: null }],
}
let container: HTMLDivElement
let root: Root
let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(DecisionQualityPanel)))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

async function upload(content: string, size?: number) {
  const file = new File([content], 'evaluation.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  const input = container.querySelector('input')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('local synthetic evaluation panel', () => {
  it('labels missing production accuracy and keeps evaluation evidence separate from report filters', () => {
    expect(container.textContent).toContain('Production decision accuracy is unknown')
    expect(container.textContent).toContain('Production date and workspace filters do not filter these examples')
    expect(container.querySelector('input')?.getAttribute('accept')).toContain('.json')
  })

  it('validates and renders provenance, incorrect acceptance, unknown usage, and incomplete coverage locally', async () => {
    await upload(JSON.stringify(sample))
    expect(container.textContent).toContain('held-out-v1')
    expect(container.textContent).toContain('abcdef1')
    expect(container.textContent).toContain('Base revision')
    expect(container.textContent).toContain('Uncommitted source changes are not captured')
    expect(container.textContent).toContain('email-reply-v3')
    expect(container.textContent).toContain('Reversed')
    expect(container.textContent).toContain('1 of 3 planned examples')
    expect(container.textContent).toContain('incomplete evaluation')
    const row = container.querySelector('tbody tr')!
    expect(row.textContent).toContain('0 / 1')
    expect(row.textContent).toContain('1 cost unknown · 1 tokens unknown')
    expect(row.textContent).toContain('2.70 s')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('clears a prior result when a malformed or content-bearing upload is rejected', async () => {
    await upload(JSON.stringify(sample))
    await upload(JSON.stringify({ ...sample, sourceText: 'private email content' }))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not a valid Jev evaluation report')
    expect(container.textContent).not.toContain('private email content')
    expect(container.textContent).not.toContain('held-out-v1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects oversized files before parsing and lets the user clear the error', async () => {
    await upload('{}', 2 * 1024 * 1024 + 1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('smaller than 2 MB')
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Clear report')!
    act(() => button.click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('No evaluation report loaded')
  })
})
