// @vitest-environment jsdom
/**
 * The hover "play this section" buttons on a chat reply (chat-message.tsx →
 * MessageContent → Markdown), with the section player supported and the
 * desktop bridge mocked:
 *  - a finished reply's heading gets one on hover;
 *  - none while the reply streams and its last text part is still arriving
 *    (a text part followed by another part, or ended, has finished);
 *  - a reply stopped mid-stream (its part stuck at `streaming`) gets them
 *    once its turn settles;
 *  - where the chat shows each reply's Read aloud button (ChatPanel), none
 *    for a section that is the whole text part; elsewhere (an agent run's
 *    chat) that section gets one;
 *  - never on a user message, which renders no markdown at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: vi.fn(),
}))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => 'full' }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => {},
    ttsCancel: async () => {},
    ttsPrepare: async () => {},
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))

import { ChatMessage } from '../chat-message'
import { __resetSectionPlayerForTests, setSectionPlayerSupported } from '@/lib/read-aloud/section-player'

const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'
const TWO_SECTIONS = `## Plan\n\n${LONG}\n\n## Budget\n\n${LONG}`

const reply = (parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts }) as unknown as UIMessage
const text = (value: string, state?: 'streaming' | 'done') => ({ type: 'text', text: value, ...(state ? { state } : {}) })
const tool = { type: 'tool-search', toolCallId: 'c1', state: 'input-available', input: {} }

let container: HTMLDivElement
let root: Root

async function mount(message: UIMessage, props: { streaming?: boolean; wholeReadAloud?: boolean } = {}) {
  await act(async () =>
    root.render(h(ChatMessage, { message, userAvatarUrl: null, userInitials: 'LA', wholeReadAloud: true, ...props })),
  )
}

function hoverHeading(label: string) {
  const el = [...container.querySelectorAll('h2')].find((h2) => h2.textContent === label)
  if (!el) throw new Error(`no heading ${label}`)
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
  })
}

const buttons = () => container.querySelectorAll('[data-read-aloud-section]')

beforeEach(() => {
  __resetSectionPlayerForTests()
  setSectionPlayerSupported(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
})

describe('ChatMessage — section read-aloud buttons', () => {
  it('a finished reply: hovering a heading shows one', async () => {
    await mount(reply([text(TWO_SECTIONS, 'done')]))
    hoverHeading('Plan')
    expect(buttons()).toHaveLength(1)
  })

  it('restored history (no part state) counts as finished', async () => {
    await mount(reply([text(TWO_SECTIONS)]))
    hoverHeading('Budget')
    expect(buttons()).toHaveLength(1)
  })

  it('none while the text part streams; a text part with a part after it, or ended, has finished', async () => {
    await mount(reply([text(TWO_SECTIONS, 'streaming')]), { streaming: true })
    hoverHeading('Plan')
    expect(buttons()).toHaveLength(0)

    await mount(reply([text(TWO_SECTIONS, 'streaming'), tool]), { streaming: true })
    hoverHeading('Plan')
    expect(buttons()).toHaveLength(1)

    // A fresh reply (the pointer never left Plan above).
    await act(async () => root.render(null))
    await mount(reply([text(TWO_SECTIONS, 'done')]), { streaming: true })
    hoverHeading('Budget')
    expect(buttons()).toHaveLength(1)
  })

  it('a reply stopped mid-stream gets them once its turn settles', async () => {
    await mount(reply([text(TWO_SECTIONS, 'streaming')]), { streaming: false })
    hoverHeading('Plan')
    expect(buttons()).toHaveLength(1)
  })

  it('none for a section that is the whole text part (the reply’s Read aloud reads it)', async () => {
    await mount(reply([text(`## Only\n\n${LONG}`, 'done')]))
    hoverHeading('Only')
    expect(buttons()).toHaveLength(0)
  })

  it('without a Read aloud button per reply (an agent run’s chat), the whole-part section gets one', async () => {
    await mount(reply([text(`## Only\n\n${LONG}`, 'done')]), { wholeReadAloud: false })
    hoverHeading('Only')
    expect(buttons()).toHaveLength(1)
  })

  it('never on a user message', async () => {
    await mount({ id: 'u1', role: 'user', parts: [text(TWO_SECTIONS)] } as unknown as UIMessage)
    expect(container.querySelector('h2')).toBeNull()
    expect(container.textContent).toContain('## Plan')
    expect(buttons()).toHaveLength(0)
  })
})
