// @vitest-environment jsdom
/**
 * A file part with no URL (bots v4: a run chat's replay names the files that
 * went with a message, never their links) draws as a plain chip: its name and
 * an icon, nothing to open and no broken image. A file part with a URL is
 * drawn as before (an image inline, a link for anything else).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({ location: { kind: 'view', view }, view, detailPanel }),
}))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => 'full' }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'

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
})

function render(parts: UIMessage['parts']) {
  act(() => {
    root.render(h(ChatMessage, { message: { id: 'm1', role: 'user', parts } as UIMessage, userAvatarUrl: null, userInitials: 'LA' }))
  })
}

describe('ChatMessage — a file with no link', () => {
  it('draws a replayed photo and file as plain chips: no image, no link', () => {
    render([
      { type: 'text', text: 'see attached' },
      { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: '' },
      { type: 'file', mediaType: 'text/markdown', filename: 'notes.md', url: '' },
    ] as UIMessage['parts'])
    const chips = [...container.querySelectorAll('[data-file-chip]')]
    expect(chips.map((c) => c.textContent)).toEqual(['shot.png', 'notes.md'])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })

  it('a file with a link is drawn as before', () => {
    render([{ type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'https://s/shot.png' }] as UIMessage['parts'])
    expect(container.querySelector('[data-file-chip]')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://s/shot.png')
  })
})
