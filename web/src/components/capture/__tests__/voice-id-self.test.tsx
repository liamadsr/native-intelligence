// @vitest-environment jsdom
/**
 * The user's own voice in the speaker row (followups issue 11): "Is this you?"
 * on a voice close to theirs, with ✓ / ✕, and "This is me" in an unknown
 * speaker's contact search — the same loop attendees get with suggestions and
 * links.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/hooks/recording-context', () => ({
  useTranscriptSegments: () => [],
  useDetectedSpeakers: () => [],
  useFinalSegmentCount: () => 0,
}))
vi.mock('@/hooks/use-recording', () => ({
  getSpeakerDisplayName: (speaker: string) => speaker,
}))
const searchProps: Array<{ speakerId: string; onAssignSelf?: () => void }> = []
vi.mock('@/components/desktop/speaker-contact-search', () => ({
  SpeakerContactSearch: (props: { speakerId: string; onAssignSelf?: () => void; children?: ReactNode }) => {
    searchProps.push(props)
    return props.children
  },
}))

import { VoiceIdCarousel } from '../live-capture-header'

let container: HTMLDivElement
let root: Root
const noop = () => {}

function render(extra: Record<string, unknown>) {
  act(() => {
    root.render(
      h(VoiceIdCarousel, {
        detectedSpeakers: ['local_1', 'local_2', 'remote_1'],
        activeSpeaker: null,
        speakerNames: {},
        speakerContacts: {},
        assignContact: noop,
        acceptSuggestion: noop,
        dismissSuggestion: noop,
        unlinkSpeaker: noop,
        ...extra,
      }),
    )
  })
}
const pill = (speaker: string) => container.querySelector<HTMLElement>(`[data-speaker="${speaker}"]`)!

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  searchProps.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('"Is this you?"', () => {
  it('asks on the suggested voice; ✓ confirms it and ✕ dismisses it', () => {
    const confirmSelf = vi.fn()
    const dismissSelf = vi.fn()
    render({ selfSuggestion: { speakerId: 'local_2', similarity: 0.75 }, confirmSelf, dismissSelf })
    expect(pill('local_2').hasAttribute('data-self-suggestion')).toBe(true)
    expect(pill('local_2').textContent).toContain('Is this you?')
    expect(pill('local_1').hasAttribute('data-self-suggestion')).toBe(false)
    act(() => pill('local_2').querySelector<HTMLButtonElement>('button[aria-label="Yes, this is me"]')!.click())
    expect(confirmSelf).toHaveBeenCalledWith('local_2')
    act(() => pill('local_2').querySelector<HTMLButtonElement>('button[aria-label="No, not me"]')!.click())
    expect(dismissSelf).toHaveBeenCalledWith('local_2')
  })

  it('does not ask on a voice already linked to someone, or without a confirm action', () => {
    render({
      selfSuggestion: { speakerId: 'local_2', similarity: 0.75 },
      confirmSelf: noop,
      speakerContacts: { local_2: { contactId: 'c1', contactName: 'Dana', confidence: 0.9, isAutoMatched: true } },
    })
    expect(pill('local_2').hasAttribute('data-self-suggestion')).toBe(false)
    render({ selfSuggestion: { speakerId: 'local_2', similarity: 0.75 } })
    expect(pill('local_2').hasAttribute('data-self-suggestion')).toBe(false)
  })
})

describe('"This is me"', () => {
  it('an unknown speaker’s contact search offers it, bound to that speaker', () => {
    const confirmSelf = vi.fn()
    render({ confirmSelf })
    const forRemote = searchProps.filter((p) => p.speakerId === 'remote_1').at(-1)!
    expect(typeof forRemote.onAssignSelf).toBe('function')
    forRemote.onAssignSelf!()
    expect(confirmSelf).toHaveBeenCalledWith('remote_1')
    searchProps.length = 0
    render({})
    expect(searchProps.every((p) => p.onAssignSelf === undefined)).toBe(true)
  })
})
