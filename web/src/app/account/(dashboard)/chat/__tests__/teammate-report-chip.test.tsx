// @vitest-environment jsdom
/**
 * A teammate's report in the chat (bots v2 phase 7): its chip opens the work
 * item where any item opens (bots-v4.md "An item opens on its bot's page",
 * Phase 2, useOpenWorkItem): on its teammate's bot's page, else over the
 * Inbox; never over the Agents page. The part names no teammate, so it's left
 * to the shell's rows, else the item is looked up; its workspace and title
 * ride along. A RESULT opens to its output instead (Liam, 10-15): the
 * deliverable the chip carries, else the one its report's metadata names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  openWorkItem: vi.fn(),
  navigate: vi.fn(),
  openDeliverable: vi.fn(async (_d: unknown, _ctx: unknown, _nav: unknown) => true),
}))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => hoisted.openWorkItem }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1' }) }))
vi.mock('@/lib/work/open-deliverable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/open-deliverable')>()),
  openDeliverable: hoisted.openDeliverable,
}))
vi.mock('../../main-chat/main-chat-context', () => ({ buildEntryForDetail: vi.fn() }))

import { TeammateReportChip, teammateReportPartData } from '../teammate-report-chip'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('TeammateReportChip', () => {
  it('opens its work item where any item opens, with its workspace and title, never straight onto a page', () => {
    const data = teammateReportPartData({ work_item_id: 'job-1', workspace_id: 'ws-2', status: 'needs_review', title: 'Reply to Acme' })!
    act(() => root.render(h(TeammateReportChip, { data })))
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'ws-2', title: 'Reply to Acme' })
    expect(hoisted.navigate).not.toHaveBeenCalled()
  })

  it('a result opens to its output (the deliverable the chip carries), named on the chip', async () => {
    const data = teammateReportPartData({
      work_item_id: 'job-1',
      workspace_id: 'ws-1',
      status: 'needs_review',
      title: 'Prep for Acme',
      deliverable: { type: 'document', id: 'doc-9', label: 'Acme brief' },
    })!
    act(() => root.render(h(TeammateReportChip, { data })))
    const button = container.querySelector<HTMLButtonElement>('button')!
    // The deliverable's own name and kind; no hook without words above it.
    expect(button.querySelector('[data-deliverable-title]')!.textContent).toBe('Acme brief')
    expect(button.querySelector('[data-deliverable-kind]')!.textContent).toBe('Document')
    expect(button.getAttribute('data-teammate-report-opens')).toBe('document')
    expect(button.getAttribute('data-chat-panel')).toBe('deliverable')
    expect(button.querySelector('[data-thread-hook]')).toBeNull()
    await act(async () => {
      button.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hoisted.openDeliverable).toHaveBeenCalledTimes(1)
    const [d, ctx, nav] = hoisted.openDeliverable.mock.calls[0]
    expect(d).toEqual({ type: 'document', id: 'doc-9', label: 'Acme brief' })
    expect(ctx).toEqual({ itemId: 'job-1' })
    expect(nav).toEqual({ workspaceId: 'ws-1', foreignWorkspaceId: null })
    expect(hoisted.openWorkItem).not.toHaveBeenCalled()
  })

  it('a row written before the chip carried it reads the output off its report’s metadata', async () => {
    const data = teammateReportPartData({ work_item_id: 'job-1', workspace_id: 'ws-2', status: 'needs_review', title: 'Prep' })!
    const metadata = {
      kind: 'teammate_report',
      teammate_report: { work_item_id: 'job-1', workspace_id: 'ws-2', status: 'needs_review', deliverables: [{ type: 'capture', id: 'cap-1', label: 'Call' }] },
    }
    act(() => root.render(h(TeammateReportChip, { data, metadata })))
    expect(container.querySelector('[data-deliverable-title]')!.textContent).toBe('Call')
    expect(container.querySelector('[data-deliverable-kind]')!.textContent).toBe('Capture')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const [d, , nav] = hoisted.openDeliverable.mock.calls[0]
    expect(d).toMatchObject({ type: 'capture', id: 'cap-1' })
    // Its own workspace, switched to first.
    expect(nav).toEqual({ workspaceId: 'ws-2', foreignWorkspaceId: 'ws-2' })
  })

  it('an output that won’t open falls back to the work item', async () => {
    hoisted.openDeliverable.mockResolvedValueOnce(false)
    const data = teammateReportPartData({
      work_item_id: 'job-1',
      workspace_id: 'ws-1',
      status: 'needs_review',
      title: 'Prep',
      deliverable: { type: 'url', id: 'notaurl', label: 'Link' },
    })!
    act(() => root.render(h(TeammateReportChip, { data })))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'ws-1', title: 'Prep' })
  })

  it('a question or a failure opens the work item, whatever its metadata names', () => {
    const metadata = { teammate_report: { work_item_id: 'job-1', status: 'needs_review', deliverables: [{ type: 'document', id: 'doc-1', label: 'Doc' }] } }
    const data = teammateReportPartData({ work_item_id: 'job-1', workspace_id: 'ws-1', status: 'needs_input', title: 'Prep', deliverable: { type: 'document', id: 'doc-1', label: 'Doc' } })!
    act(() => root.render(h(TeammateReportChip, { data, metadata })))
    expect(container.querySelector('[data-deliverable-kind]')!.textContent).toBe('Needs your answer')
    expect(container.querySelector('[data-deliverable-title]')!.textContent).toBe('Prep')
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(hoisted.openDeliverable).not.toHaveBeenCalled()
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'ws-1', title: 'Prep' })
  })

  it('a part with no workspace leaves it to the opener (the shell’s rows, or the lookup)', () => {
    const data = teammateReportPartData({ work_item_id: 'job-1', status: 'failed', title: 'Weekly brief' })!
    act(() => root.render(h(TeammateReportChip, { data })))
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: null, title: 'Weekly brief' })
  })
})
