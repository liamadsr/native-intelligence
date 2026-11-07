// @vitest-environment jsdom
/**
 * The Personas page's history targets (⌘K, Recently viewed, Back/Forward):
 * an agent of the workspace opens in the one agent editor (bots-v4 B1), a
 * built-in one in the detail dialog, and both follow the same rules: a new
 * target replaces what's open, the root closes it, and a manually closed one
 * stays closed until the destination changes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const library = vi.hoisted(() => ({ items: [
  { id: 'a', name: 'Agent A', category: 'agent', description: '', visibility: 'workspace', is_system: false },
  { id: 'b', name: 'Agent B', category: 'agent', description: '', visibility: 'workspace', is_system: false },
  { id: 'meeting', name: 'Meeting', category: 'agent', description: '', visibility: 'workspace', is_system: true },
] }))
vi.mock('../agents/use-library-items', () => ({ useLibraryItems: () => ({
  workspaceItems: library.items, myItems: library.items, discoverItems: library.items,
  isLoading: false, fork: vi.fn(), remove: vi.fn(), save: vi.fn(), refetchOwned: vi.fn(),
}) }))
vi.mock('../agents/library-row', () => ({ LibraryRow: () => null }))
vi.mock('../agents/item-dialogs', () => ({
  defaultForm: () => ({}),
  DetailDialog: ({ item, onClose }: { item: { name: string } | null; onClose: () => void }) => item
    ? <div role="dialog" data-detail="">{item.name}<button onClick={onClose}>Close detail</button></div> : null,
  EditorDialog: () => null,
}))
vi.mock('@/components/agents/agent-editor', () => ({
  AgentEditorDialog: ({ open, agentId, onClose }: { open: boolean; agentId: string | null; onClose: () => void }) => open
    ? <div role="dialog" data-agent-editor={agentId ?? ''}>Editor for {agentId}<button onClick={onClose}>Close editor</button></div> : null,
}))
import { AgentsView } from '../agents-view'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function visit(id?: string) {
  await act(async () => root.render(<AgentsView initialItemId={id} />))
}
const dialog = () => container.querySelector('[role="dialog"]')

it('restores root, Forward, and a different agent while a dialog is already open', async () => {
  await visit('a')
  expect(dialog()?.getAttribute('data-agent-editor')).toBe('a')
  await visit('b')
  expect(dialog()?.getAttribute('data-agent-editor')).toBe('b')
  await visit()
  expect(dialog()).toBeNull()
  await visit('b')
  expect(dialog()?.getAttribute('data-agent-editor')).toBe('b')
})

it('keeps a manually closed dialog closed until the history destination changes', async () => {
  await visit('a')
  act(() => container.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
  await visit('a')
  expect(dialog()).toBeNull()
  await visit()
  await visit('a')
  expect(dialog()).not.toBeNull()
})

it('does not leave the old agent open for an unavailable history target', async () => {
  await visit('a')
  await visit('missing')
  expect(dialog()).toBeNull()
})

it('a built-in agent opens its detail, and an agent of the workspace replaces it with the editor', async () => {
  await visit('meeting')
  expect(container.querySelector('[data-detail]')?.textContent).toContain('Meeting')
  expect(container.querySelector('[data-agent-editor]')).toBeNull()
  await visit('a')
  expect(container.querySelector('[data-detail]')).toBeNull()
  expect(dialog()?.getAttribute('data-agent-editor')).toBe('a')
})
