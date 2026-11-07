// @vitest-environment jsdom
/**
 * A reply's controls that sit straight on the sky (Copy / Read aloud / thumbs,
 * "Stopped") carry `data-on-sky` in the main chat, so their ink follows the
 * sky's tone (tailwind.css, lib/sky/sky-tone.ts); outside it (a bot's card,
 * any host that doesn't say so) they keep the theme's own.
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
import { OnSkyContext } from '@/components/sky/on-sky'

const reply = { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }], metadata: { eve_written: true, stopped: true } } as unknown as UIMessage

describe('ChatMessage — controls on the sky', () => {
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
  const render = (onSky: boolean | null) => {
    const msg = h(ChatMessage, { message: reply, userAvatarUrl: null, userInitials: 'LA' })
    act(() => root.render(onSky === null ? msg : h(OnSkyContext.Provider, { value: onSky }, msg)))
  }
  const actions = () => container.querySelector<HTMLElement>('[data-message-actions]')!

  it('marks the action row (and the Stopped label) in the main chat', () => {
    render(true)
    expect(actions().hasAttribute('data-on-sky')).toBe(true)
    expect(container.querySelector<HTMLElement>('[data-chat-reply-stopped]')!.hasAttribute('data-on-sky')).toBe(true)
  })

  it('leaves them unmarked anywhere else, and in a host that says no', () => {
    render(null)
    expect(actions().hasAttribute('data-on-sky')).toBe(false)
    render(false)
    expect(actions().hasAttribute('data-on-sky')).toBe(false)
    expect(container.querySelector('[data-on-sky]')).toBeNull()
  })
})
