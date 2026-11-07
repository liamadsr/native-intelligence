// @vitest-environment jsdom
/**
 * The evals card walks the real EvalsView inside the card: a suite, one of
 * its cases, Back to the suite (remembered with the card), and the suites.
 * And the page gate: where the workspace has Evals off, the card draws a
 * notice instead of the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

const edition = vi.hoisted(() => ({ views: ['evals'] as string[] }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceEdition: () => ({ views: edition.views, extraAllowedViews: [] }),
  useWorkspaceId: () => 'ws-1',
}))
vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('@/app/account/(dashboard)/evals/suite-detail', () => ({
  EvalSuiteDetail: ({ suiteId, onOpenCase, onBack }: { suiteId: string; onOpenCase: (id: string, name: string, suite: string) => void; onBack: () => void }) =>
    React.createElement(
      'div',
      { 'data-suite': suiteId },
      React.createElement('button', { 'data-open-case': '', onClick: () => onOpenCase('case-1', 'Case one', 'Suite') }, 'case'),
      React.createElement('button', { 'data-back-index': '', onClick: onBack }, 'index'),
    ),
}))
vi.mock('@/app/account/(dashboard)/evals/case-page', () => ({
  EvalCasePage: ({ caseId, onBack }: { caseId: string; onBack: () => void }) => React.createElement('button', { 'data-case': caseId, onClick: onBack }, 'back'),
}))
vi.mock('@/app/account/(dashboard)/evals/run-page', () => ({ EvalRunPage: () => null }))

import EvalsCard from '../pages/evals-card'
import { PageGate } from '../pages/page-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const SUITE = '00000000-0000-4000-8000-000000000401'
const spec: PageCardSpec = { kind: 'evals', title: 'Triage', target: { type: 'eval_suite', id: SUITE, label: 'Triage suite' } }

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  edition.views = ['evals']
  vi.stubGlobal('fetch', stubFetch({}).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('EvalsCard', () => {
  it('opens a case and comes back to its suite, all inside the card', async () => {
    const store = makeStore('call-1', spec)
    await mount.render(React.createElement(EvalsCard, { toolCallId: 'call-1', spec, store, fullScreen: false }))
    expect(mount.container.querySelector(`[data-suite="${SUITE}"]`)).not.toBeNull()
    await act(async () => (mount.container.querySelector('[data-open-case]') as HTMLElement).click())
    expect(mount.container.querySelector('[data-case="case-1"]')).not.toBeNull()
    expect(store.state('call-1').trail).toEqual([{ type: 'eval_suite', id: SUITE, label: 'Triage suite' }])
    expect(store.contextEntries()[0]).toMatchObject({ at: { type: 'eval_case', id: 'case-1' }, moved: true })

    // A reload remembers the suite above the case.
    mount.unmount()
    mount = mountRoot()
    await mount.render(React.createElement(EvalsCard, { toolCallId: 'call-1', spec, store, fullScreen: false }))
    await act(async () => (mount.container.querySelector('[data-case]') as HTMLElement).click())
    expect(mount.container.querySelector(`[data-suite="${SUITE}"]`)).not.toBeNull()
    await act(async () => (mount.container.querySelector('[data-back-index]') as HTMLElement).click())
    expect(mount.container.querySelector('[data-probe-list="eval_suite"]')?.getAttribute('data-card')).toBe('yes')
  })

  it('draws a notice instead of the page where Evals is off', async () => {
    edition.views = []
    const store = makeStore('call-1', spec)
    await mount.render(React.createElement(PageGate, { spec, children: React.createElement(EvalsCard, { toolCallId: 'call-1', spec, store, fullScreen: false }) }))
    expect(mount.container.textContent).toBe('Evals is off in this workspace.')
    expect(mount.container.querySelector('[data-suite]')).toBeNull()
  })
})
