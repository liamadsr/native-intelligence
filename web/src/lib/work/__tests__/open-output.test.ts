/**
 * A delivered item opens to its output, else the item (open-output.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import { openOutputOrItem, type DeliveredItem, type OpenOutputDeps } from '../open-output'
import type { WorkDeliverable } from '../types'

const doc: WorkDeliverable = { type: 'document', id: 'doc-1', label: 'Brief' }

function deps(over: Partial<OpenOutputDeps> = {}) {
  return {
    currentWorkspaceId: 'ws-1',
    contextFor: vi.fn(async (workId: string) => ({ itemId: workId })),
    openDeliverable: vi.fn(async () => true),
    openItem: vi.fn(),
    ...over,
  } satisfies OpenOutputDeps
}

const item = (over: Partial<DeliveredItem> = {}): DeliveredItem => ({ workItemId: 'w1', workspaceId: 'ws-1', title: 'Prep', output: doc, ...over })

describe('openOutputOrItem', () => {
  it('opens the output in the item’s workspace, on screen', async () => {
    const d = deps()
    expect(await openOutputOrItem(item(), d)).toBe('output')
    expect(d.contextFor).toHaveBeenCalledWith('w1', doc)
    expect(d.openDeliverable).toHaveBeenCalledWith(doc, { itemId: 'w1' }, { workspaceId: 'ws-1', foreignWorkspaceId: null })
    expect(d.openItem).not.toHaveBeenCalled()
  })

  it('a foreign item’s output opens in its own workspace; a deliverable’s own workspace wins', async () => {
    const d = deps()
    await openOutputOrItem(item({ workspaceId: 'ws-2' }), d)
    expect(d.openDeliverable).toHaveBeenLastCalledWith(doc, { itemId: 'w1' }, { workspaceId: 'ws-2', foreignWorkspaceId: 'ws-2' })
    await openOutputOrItem(item({ output: { ...doc, workspace_id: 'ws-3' } }), d)
    expect(vi.mocked(d.openDeliverable).mock.calls[1][2]).toEqual({ workspaceId: 'ws-3', foreignWorkspaceId: 'ws-3' })
  })

  it('no output: the item opens, synchronously', () => {
    const d = deps()
    void openOutputOrItem(item({ output: null }), d)
    expect(d.openItem).toHaveBeenCalledWith(item({ output: null }))
    expect(d.openDeliverable).not.toHaveBeenCalled()
  })

  it('an output that won’t open, or throws, falls back to the item', async () => {
    const refused = deps({ openDeliverable: vi.fn(async () => false) })
    expect(await openOutputOrItem(item(), refused)).toBe('item')
    expect(refused.openItem).toHaveBeenCalledTimes(1)
    const thrown = deps({ contextFor: vi.fn(async () => Promise.reject(new Error('offline'))) })
    expect(await openOutputOrItem(item(), thrown)).toBe('item')
    expect(thrown.openItem).toHaveBeenCalledTimes(1)
  })
})
